//! Volume and network ports over the workspace's Docker-compatible daemon.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use hl_extension::port::{
    HostError, NetworkEndpointInventory, NetworkStore, NetworkSummary, VolumeStore, VolumeSummary,
};
use hl_extension::PostgresConnection;

use super::postgres::{network_revision, CredentialRole, DatabaseEndpoint, DatabaseResolver, DatabaseTls};
use super::postgres_dial::{DialAuthority, DialTarget};
use super::{failure, Bridge};

pub struct Resources {
    bridge: Arc<Bridge>,
}

/// Explicit host-only PostgreSQL profile for the currently served workspace.
/// The endpoint itself is still resolved from the authorized container/network
/// inspection on every open and authority recheck.
pub(crate) struct PostgresResolver<'a> {
    resources: &'a Resources,
    server_name: String,
    password_key: String,
}

impl<'a> PostgresResolver<'a> {
    pub(crate) fn configured(
        resources: &'a Resources,
        profile: Option<&crate::config::PostgresProfile>,
    ) -> Result<Option<Self>, HostError> {
        let Some(profile) = profile else { return Ok(None) };
        DatabaseTls::verify_full(profile.tls_server_name.clone())?;
        if profile.password_key.is_empty() || profile.password_key.len() > 128 || profile.password_key.contains('\0') {
            return Err(HostError::Conflict("postgres password key profile is invalid".into()));
        }
        Ok(Some(Self {
            resources,
            server_name: profile.tls_server_name.clone(),
            password_key: profile.password_key.clone(),
        }))
    }
}

impl DatabaseResolver for PostgresResolver<'_> {
    fn endpoint(&self, connection: &PostgresConnection) -> Result<DatabaseEndpoint, HostError> {
        let target = self.resources.database_dial_target(connection)?;
        DatabaseEndpoint::new(
            target.address(),
            DatabaseTls::verify_full(self.server_name.clone())?,
            3_000,
            10_000,
        )
    }

    fn role(&self, key: &str) -> Result<CredentialRole, HostError> {
        (key == self.password_key)
            .then_some(CredentialRole::Password)
            .ok_or_else(|| HostError::Conflict("postgres credential key has no configured authentication role".into()))
    }
}

impl Resources {
    pub(super) fn new(bridge: Arc<Bridge>) -> Self {
        Self { bridge }
    }

    pub(crate) fn bridge(&self) -> Arc<Bridge> {
        Arc::clone(&self.bridge)
    }

    /// Resolves an authorized connection intent to a host-private route.
    ///
    /// Callers retain the target and pass it to [`DialAuthority`] so a network
    /// or container replacement is observed again immediately before and after
    /// opening the socket.
    #[allow(dead_code)] // used when the host-private TLS/credential profile is installed at composition
    pub(crate) fn database_dial_target(&self, connection: &PostgresConnection) -> Result<DialTarget, HostError> {
        self.database_route(
            &connection.container_id,
            connection.container_generation,
            &connection.network,
            connection.port,
        )
    }

    fn database_route(
        &self,
        container_id: &str,
        container_generation: u64,
        network_reference: &str,
        port: u16,
    ) -> Result<DialTarget, HostError> {
        let container = self
            .bridge
            .wait(self.bridge.client().containers().inspect(container_id))
            .map_err(|error| failure(&error))?;
        if container.metadata.id != container_id || container.metadata.generation != container_generation {
            return Err(HostError::Conflict("database container identity was replaced".into()));
        }
        let inspected = self
            .bridge
            .wait(self.bridge.client().networks().inspect(network_reference))
            .map_err(|error| failure(&error))?;
        route_from_inspection(container_id, container_generation, network_reference, port, &inspected)
    }
}

fn endpoint_address(value: &str, port: u16) -> Result<SocketAddr, HostError> {
    if port == 0 {
        return Err(HostError::Conflict("database endpoint port is invalid".into()));
    }
    let address = value.split_once('/').map_or(value, |(address, _)| address);
    let address = address
        .parse::<IpAddr>()
        .map_err(|_| HostError::Conflict("database network endpoint has no usable IP address".into()))?;
    Ok(SocketAddr::new(address, port))
}

fn route_from_inspection(
    container_id: &str,
    container_generation: u64,
    network_reference: &str,
    port: u16,
    inspected: &hl_client::model::Network,
) -> Result<DialTarget, HostError> {
    if inspected.id != network_reference && inspected.name != network_reference {
        return Err(HostError::Conflict(
            "database network identity does not match the request".into(),
        ));
    }
    let endpoint = inspected
        .containers
        .get(container_id)
        .ok_or_else(|| HostError::Conflict("database container is not a member of the requested network".into()))?;
    let summary = network(inspected, true);
    DialTarget::new(
        container_id,
        container_generation,
        inspected.id.clone(),
        network_revision(&summary)?,
        endpoint_address(
            if endpoint.ipv4_address.is_empty() {
                &endpoint.ipv6_address
            } else {
                &endpoint.ipv4_address
            },
            port,
        )?,
    )
}

impl DialAuthority for Resources {
    fn current(&self, expected: &DialTarget) -> Result<DialTarget, HostError> {
        self.database_route(
            expected.container_id(),
            expected.container_generation(),
            expected.network_id(),
            expected.address().port(),
        )
    }
}

fn volume(value: &hl_client::model::Volume) -> VolumeSummary {
    VolumeSummary {
        name: value.name.clone(),
        driver: value.driver.clone(),
        generation: value.husklet_generation.clone(),
    }
}

fn network(value: &hl_client::model::Network, inspected: bool) -> NetworkSummary {
    NetworkSummary {
        id: value.id.clone(),
        name: value.name.clone(),
        driver: value.driver.clone(),
        scope: value.scope.clone(),
        kind: match value.husklet_kind {
            hl_client::model::NetworkKind::Builtin => hl_extension::NetworkKind::Builtin,
            hl_client::model::NetworkKind::Custom => hl_extension::NetworkKind::Custom,
        },
        endpoints: inspected.then(|| NetworkEndpointInventory::bounded(value.containers.keys().cloned().collect())),
    }
}

fn network_connect_request(container: &str, aliases: &[String]) -> hl_client::model::NetworkConnect {
    hl_client::model::NetworkConnect {
        container: container.into(),
        endpoint_config: (!aliases.is_empty()).then(|| hl_client::model::EndpointConfig {
            aliases: aliases.to_vec(),
            ..Default::default()
        }),
        ..Default::default()
    }
}

impl VolumeStore for Resources {
    fn list(&self) -> Result<Vec<VolumeSummary>, HostError> {
        let listed = self
            .bridge
            .wait(self.bridge.client().volumes().list())
            .map_err(|error| failure(&error))?;
        Ok(listed.volumes.iter().map(volume).collect())
    }

    fn inspect(&self, name: &str) -> Result<VolumeSummary, HostError> {
        self.bridge
            .wait(self.bridge.client().volumes().inspect(name))
            .map(|value| volume(&value))
            .map_err(|error| failure(&error))
    }

    fn create(&self, name: &str) -> Result<VolumeSummary, HostError> {
        let request = hl_client::model::VolumeCreate {
            name: name.into(),
            ..Default::default()
        };
        self.bridge
            .wait(self.bridge.client().volumes().create(&request))
            .map(|value| volume(&value))
            .map_err(|error| failure(&error))
    }

    fn remove(&self, name: &str, generation: &str) -> Result<(), HostError> {
        self.bridge
            .wait(self.bridge.client().volumes().remove_if_generation(name, generation))
            .map_err(|error| failure(&error))
    }
}

impl NetworkStore for Resources {
    fn list(&self) -> Result<Vec<NetworkSummary>, HostError> {
        self.bridge
            .wait(self.bridge.client().networks().list())
            .map(|values| values.iter().map(|value| network(value, false)).collect())
            .map_err(|error| failure(&error))
    }

    fn inspect(&self, reference: &str) -> Result<NetworkSummary, HostError> {
        self.bridge
            .wait(self.bridge.client().networks().inspect(reference))
            .map(|value| network(&value, true))
            .map_err(|error| failure(&error))
    }

    fn create(&self, name: &str) -> Result<String, HostError> {
        let request = hl_client::model::NetworkCreate {
            name: name.into(),
            ..Default::default()
        };
        self.bridge
            .wait(self.bridge.client().networks().create(&request))
            .map(|value| value.id)
            .map_err(|error| failure(&error))
    }

    fn remove(&self, reference: &str) -> Result<(), HostError> {
        self.bridge
            .wait(self.bridge.client().networks().remove(reference, false))
            .map_err(|error| failure(&error))
    }

    fn connect(&self, reference: &str, container: &str) -> Result<(), HostError> {
        let request = network_connect_request(container, &[]);
        self.bridge
            .wait(self.bridge.client().networks().connect(reference, &request))
            .map_err(|error| failure(&error))
    }

    fn connect_with_aliases(&self, reference: &str, container: &str, aliases: &[String]) -> Result<(), HostError> {
        let request = network_connect_request(container, aliases);
        self.bridge
            .wait(self.bridge.client().networks().connect(reference, &request))
            .map_err(|error| failure(&error))
    }

    fn disconnect(&self, reference: &str, container: &str) -> Result<(), HostError> {
        let request = hl_client::model::NetworkDisconnect {
            container: container.into(),
            force: false,
            ..Default::default()
        };
        self.bridge
            .wait(self.bridge.client().networks().disconnect(reference, &request))
            .map_err(|error| failure(&error))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use hl_client::model::{ConfigFrom, Ipam, Network, NetworkContainer, NetworkKind};

    fn inspected(container: &str, address: &str) -> Network {
        Network {
            name: "backend".into(),
            id: "network-id".into(),
            created: String::new(),
            scope: "local".into(),
            driver: "bridge".into(),
            husklet_kind: NetworkKind::Custom,
            enable_ipv6: false,
            ipam: Ipam::default(),
            internal: false,
            attachable: false,
            ingress: false,
            config_from: ConfigFrom::default(),
            config_only: false,
            containers: BTreeMap::from([(
                container.into(),
                NetworkContainer {
                    name: "postgres".into(),
                    endpoint_id: "endpoint".into(),
                    mac_address: String::new(),
                    ipv4_address: address.into(),
                    ipv6_address: String::new(),
                },
            )]),
            options: BTreeMap::new(),
            labels: BTreeMap::new(),
        }
    }

    #[test]
    fn network_aliases_reach_the_daemon_request_without_rewriting() {
        let aliases = vec!["database.internal".to_owned(), "database_2".to_owned()];
        let request = super::network_connect_request(&"b".repeat(64), &aliases);
        assert_eq!(request.endpoint_config.expect("endpoint config").aliases, aliases);
        assert!(super::network_connect_request(&"b".repeat(64), &[])
            .endpoint_config
            .is_none());
    }

    #[test]
    fn database_route_uses_only_the_exact_inspected_member_and_strips_the_prefix() {
        let container = "a".repeat(64);
        let route =
            super::route_from_inspection(&container, 7, "backend", 5432, &inspected(&container, "172.30.0.7/24"))
                .unwrap();
        assert_eq!(route.container_id(), container);
        assert_eq!(route.container_generation(), 7);
        assert_eq!(route.network_id(), "network-id");
        assert_ne!(route.network_revision(), 0);
        assert_eq!(route.address(), "172.30.0.7:5432".parse().unwrap());
    }

    #[test]
    fn database_route_uses_an_inspected_ipv6_endpoint_when_ipv4_is_absent() {
        let container = "a".repeat(64);
        let mut network = inspected(&container, "");
        network.containers.get_mut(&container).unwrap().ipv6_address = "fd00::7/64".into();
        let route = super::route_from_inspection(&container, 7, "network-id", 5432, &network).unwrap();
        assert_eq!(route.address(), "[fd00::7]:5432".parse().unwrap());
    }

    #[test]
    fn database_route_rejects_spoofed_network_membership_and_addresses() {
        let container = "a".repeat(64);
        let other = "b".repeat(64);
        assert!(
            super::route_from_inspection(&container, 7, "other", 5432, &inspected(&container, "172.30.0.7/24"))
                .is_err()
        );
        assert!(
            super::route_from_inspection(&container, 7, "backend", 5432, &inspected(&other, "172.30.0.7/24")).is_err()
        );
        assert!(super::route_from_inspection(
            &container,
            7,
            "backend",
            5432,
            &inspected(&container, "postgres.internal/24")
        )
        .is_err());
        assert!(
            super::route_from_inspection(&container, 7, "backend", 0, &inspected(&container, "172.30.0.7/24")).is_err()
        );
    }
}
