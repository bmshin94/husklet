//! Host-owned PostgreSQL broker state.
//!
//! The wire-facing request contains only credential names. This boundary asks
//! the host authority for one atomic authentication snapshot and hands secret
//! bytes directly to an injected transport. The production peer is composed
//! only for an explicit host TLS profile and never exposes its resolved route
//! or authentication material to the extension protocol.

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Mutex;

use hl_extension::port::{ContainerInventory, ExtensionStateStore, NetworkStore};
use hl_extension::{
    HostError, PostgresBroker, PostgresConnection, PostgresCursor, PostgresLeaseId, PostgresOpenOutcome, PostgresPage,
    PostgresQuery, PostgresQueryId, PostgresQueryState, PostgresStartOutcome, QueryOperationToken,
};
use hl_rpc::InstallationIdentity;
use sha2::{Digest, Sha256};

use super::Records;

const LEASE_LIMIT: usize = 8;
const QUERY_LIMIT: usize = 32;
const OPEN_LIMIT: usize = 32;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Binding {
    pub(crate) installation: String,
    pub(crate) container_id: String,
    pub(crate) container_generation: u64,
    pub(crate) network: String,
    pub(crate) network_revision: u64,
    pub(crate) endpoint: DatabaseEndpoint,
    pub(crate) credentials: BTreeMap<String, u64>,
}

pub(crate) struct Secret(Vec<u8>);

impl Secret {
    const LIMIT: usize = 1024 * 1024;

    pub(crate) fn new(value: Vec<u8>) -> Self {
        Self(value)
    }

    pub(crate) fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    fn valid(&self) -> bool {
        !self.0.is_empty() && self.0.len() <= Self::LIMIT
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

/// Host-resolved TLS identity for one database endpoint.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DatabaseTls {
    server_name: String,
}

impl DatabaseTls {
    const SERVER_NAME_LIMIT: usize = 253;

    pub(crate) fn verify_full(server_name: impl Into<String>) -> Result<Self, HostError> {
        let server_name = server_name.into();
        let valid = !server_name.is_empty()
            && server_name.len() <= Self::SERVER_NAME_LIMIT
            && !server_name.contains('\0')
            && server_name.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
                    && label.as_bytes().last().is_some_and(u8::is_ascii_alphanumeric)
                    && label.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            });
        if !valid {
            return Err(HostError::Conflict("postgres TLS server name is invalid".into()));
        }
        Ok(Self { server_name })
    }

    pub(crate) fn server_name(&self) -> &str {
        &self.server_name
    }
}

/// A private, already-authorized route. It is never serialized to an extension.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DatabaseEndpoint {
    address: SocketAddr,
    tls: DatabaseTls,
    connect_timeout_ms: u32,
    io_timeout_ms: u32,
}

impl DatabaseEndpoint {
    const MIN_TIMEOUT_MS: u32 = 100;
    const MAX_TIMEOUT_MS: u32 = 30_000;

    pub(crate) fn new(
        address: SocketAddr,
        tls: DatabaseTls,
        connect_timeout_ms: u32,
        io_timeout_ms: u32,
    ) -> Result<Self, HostError> {
        if address.port() == 0
            || !(Self::MIN_TIMEOUT_MS..=Self::MAX_TIMEOUT_MS).contains(&connect_timeout_ms)
            || !(Self::MIN_TIMEOUT_MS..=Self::MAX_TIMEOUT_MS).contains(&io_timeout_ms)
        {
            return Err(HostError::Conflict("postgres endpoint or timeout is invalid".into()));
        }
        Ok(Self {
            address,
            tls,
            connect_timeout_ms,
            io_timeout_ms,
        })
    }

    pub(crate) fn address(&self) -> SocketAddr {
        self.address
    }

    pub(crate) fn tls(&self) -> &DatabaseTls {
        &self.tls
    }

    pub(crate) fn timeouts_ms(&self) -> (u32, u32) {
        (self.connect_timeout_ms, self.io_timeout_ms)
    }
}

pub(crate) enum DatabaseCredential {
    Password(Secret),
    RootCertificate(Secret),
    ClientCertificate(Secret),
    ClientPrivateKey(Secret),
}

#[derive(Clone, Copy)]
pub(crate) enum CredentialRole {
    Password,
    RootCertificate,
    ClientCertificate,
    ClientPrivateKey,
}

impl CredentialRole {
    fn material(self, secret: Secret) -> DatabaseCredential {
        match self {
            Self::Password => DatabaseCredential::Password(secret),
            Self::RootCertificate => DatabaseCredential::RootCertificate(secret),
            Self::ClientCertificate => DatabaseCredential::ClientCertificate(secret),
            Self::ClientPrivateKey => DatabaseCredential::ClientPrivateKey(secret),
        }
    }
}

/// Typed, host-only authentication material. Roles can never be inferred from key order.
pub(crate) struct DatabaseAuthentication {
    credentials: Vec<DatabaseCredential>,
}

impl DatabaseAuthentication {
    const LIMIT: usize = 4;

    pub(crate) fn new(credentials: Vec<DatabaseCredential>) -> Result<Self, HostError> {
        let mut password = 0;
        let mut root = 0;
        let mut certificate = 0;
        let mut private_key = 0;
        for credential in &credentials {
            let secret = match credential {
                DatabaseCredential::Password(secret)
                | DatabaseCredential::RootCertificate(secret)
                | DatabaseCredential::ClientCertificate(secret)
                | DatabaseCredential::ClientPrivateKey(secret) => secret,
            };
            if !secret.valid() {
                return Err(HostError::Conflict("postgres credential material is invalid".into()));
            }
            match credential {
                DatabaseCredential::Password(_) => password += 1,
                DatabaseCredential::RootCertificate(_) => root += 1,
                DatabaseCredential::ClientCertificate(_) => certificate += 1,
                DatabaseCredential::ClientPrivateKey(_) => private_key += 1,
            }
        }
        if credentials.is_empty()
            || credentials.len() > Self::LIMIT
            || password > 1
            || root > 1
            || certificate > 1
            || private_key > 1
            || certificate != private_key
            || (password == 0 && certificate == 0)
        {
            return Err(HostError::Conflict("postgres credential roles are invalid".into()));
        }
        Ok(Self { credentials })
    }

    pub(crate) fn credentials(&self) -> &[DatabaseCredential] {
        &self.credentials
    }
}

pub(crate) struct Authentication {
    pub(crate) binding: Binding,
    pub(crate) endpoint: DatabaseEndpoint,
    pub(crate) material: DatabaseAuthentication,
}

/// Host authority queried atomically before authentication and on every use.
pub(crate) trait Authority: Send + Sync {
    fn authenticate(&self, installation: &str, connection: &PostgresConnection) -> Result<Authentication, HostError>;
    fn current(&self, binding: &Binding) -> Result<bool, HostError>;
}

/// Durable installation lookup used by the production authority adapter.
///
/// Keeping this separate from container and credential ports makes replacement
/// observable on every lease use without granting the broker extension-management
/// authority.
pub(crate) trait InstallationAuthority: Send + Sync {
    fn current(&self, installation: &InstallationIdentity) -> Result<bool, HostError>;
}

/// Host-private endpoint and credential-role configuration. Neither the
/// resolved address nor a key's authentication role is accepted from the
/// extension request.
pub(crate) trait DatabaseResolver: Send + Sync {
    fn endpoint(&self, connection: &PostgresConnection) -> Result<DatabaseEndpoint, HostError>;
    fn role(&self, key: &str) -> Result<CredentialRole, HostError>;
}

/// Re-opens the durable roster for every check, so disable, removal, and
/// reinstall revoke an already authenticated database lease immediately.
pub(crate) struct WorkspaceInstallation {
    root: PathBuf,
    name: hl_extension::ExtensionName,
}

impl WorkspaceInstallation {
    pub(crate) fn new(root: PathBuf, name: hl_extension::ExtensionName) -> Self {
        Self { root, name }
    }
}

impl InstallationAuthority for WorkspaceInstallation {
    fn current(&self, installation: &InstallationIdentity) -> Result<bool, HostError> {
        let storage =
            hl_ws::storage::Directory::open(&self.root).map_err(|error| HostError::Failed(error.to_string()))?;
        let records = Records::open(storage).map_err(|error| HostError::Failed(error.to_string()))?;
        Ok(records
            .all()
            .map_err(|error| HostError::Failed(error.to_string()))?
            .iter()
            .any(|record| record.enabled && record.name == self.name && record.incarnation == installation.as_str()))
    }
}

/// Production authority assembled from Husklet's existing narrow host services.
///
/// It never returns credential bytes to the extension protocol. Values move from
/// the private state store into [`Authentication`] and from there directly into
/// [`Peer::open`]. Every later operation re-reads all four authorities.
pub(crate) struct ServiceAuthority<'a, C: ?Sized, N: ?Sized, S: ?Sized, R: ?Sized> {
    installation: InstallationIdentity,
    installations: &'a dyn InstallationAuthority,
    containers: &'a C,
    networks: &'a N,
    credentials: &'a S,
    resolver: &'a R,
}

impl<'a, C, N, S, R> ServiceAuthority<'a, C, N, S, R>
where
    C: ContainerInventory + Sync + ?Sized,
    N: NetworkStore + Sync + ?Sized,
    S: ExtensionStateStore + Sync + ?Sized,
    R: DatabaseResolver + Sync + ?Sized,
{
    pub(crate) fn new(
        installation: InstallationIdentity,
        installations: &'a dyn InstallationAuthority,
        containers: &'a C,
        networks: &'a N,
        credentials: &'a S,
        resolver: &'a R,
    ) -> Self {
        Self {
            installation,
            installations,
            containers,
            networks,
            credentials,
            resolver,
        }
    }

    fn container(&self, connection: &PostgresConnection) -> Result<(), HostError> {
        let container = self.containers.inspect(&connection.container_id)?;
        if container.id != connection.container_id || container.generation != connection.container_generation {
            return Err(HostError::Conflict("postgres container identity was replaced".into()));
        }
        Ok(())
    }

    fn network(&self, connection: &PostgresConnection) -> Result<u64, HostError> {
        let network = self.networks.inspect(&connection.network)?;
        if network.id != connection.network && network.name != connection.network {
            return Err(HostError::Conflict(
                "postgres network identity does not match the request".into(),
            ));
        }
        let endpoints = network
            .endpoints
            .as_ref()
            .ok_or_else(|| HostError::Conflict("postgres network membership was not inspected".into()))?;
        if endpoints.truncated || !endpoints.containers.iter().any(|id| id == &connection.container_id) {
            return Err(HostError::Conflict(
                "postgres container is not an authoritative member of the requested network".into(),
            ));
        }
        network_revision(&network)
    }

    fn credential(&self, key: &str) -> Result<(u64, Secret), HostError> {
        let credential = self.credentials.credential(key)?;
        if credential.key != key || credential.revision == 0 {
            return Err(HostError::Conflict("postgres credential snapshot is invalid".into()));
        }
        let value = credential
            .value
            .ok_or_else(|| HostError::Absent(format!("postgres credential {key} is absent")))?;
        Ok((credential.revision, Secret::new(value)))
    }

    fn installation_current(&self, supplied: &str) -> Result<bool, HostError> {
        Ok(supplied == self.installation.as_str() && self.installations.current(&self.installation)?)
    }
}

pub(crate) fn network_revision(network: &hl_extension::port::NetworkSummary) -> Result<u64, HostError> {
    let bytes = serde_json::to_vec(network).map_err(|error| HostError::Failed(error.to_string()))?;
    let digest = Sha256::digest(bytes);
    Ok(u64::from_be_bytes(digest[..8].try_into().expect("sha256 prefix")) | 1)
}

impl<C, N, S, R> Authority for ServiceAuthority<'_, C, N, S, R>
where
    C: ContainerInventory + Sync + ?Sized,
    N: NetworkStore + Sync + ?Sized,
    S: ExtensionStateStore + Sync + ?Sized,
    R: DatabaseResolver + Sync + ?Sized,
{
    fn authenticate(&self, installation: &str, connection: &PostgresConnection) -> Result<Authentication, HostError> {
        if !self.installation_current(installation)? {
            return Err(HostError::Absent("postgres installation authority was replaced".into()));
        }
        self.container(connection)?;
        let network_revision = self.network(connection)?;
        let endpoint = self.resolver.endpoint(connection)?;
        let mut revisions = BTreeMap::new();
        let mut material = Vec::with_capacity(connection.credential_keys.len());
        for key in &connection.credential_keys {
            let (revision, secret) = self.credential(key)?;
            revisions.insert(key.clone(), revision);
            material.push(self.resolver.role(key)?.material(secret));
        }
        Ok(Authentication {
            binding: Binding {
                installation: installation.into(),
                container_id: connection.container_id.clone(),
                container_generation: connection.container_generation,
                network: connection.network.clone(),
                network_revision,
                endpoint: endpoint.clone(),
                credentials: revisions,
            },
            endpoint,
            material: DatabaseAuthentication::new(material)?,
        })
    }

    fn current(&self, binding: &Binding) -> Result<bool, HostError> {
        if !self.installation_current(&binding.installation)? {
            return Ok(false);
        }
        let connection = PostgresConnection {
            container_id: binding.container_id.clone(),
            container_generation: binding.container_generation,
            network: binding.network.clone(),
            port: binding.endpoint.address().port(),
            database: "authority-check".into(),
            user: "authority-check".into(),
            credential_keys: binding.credentials.keys().cloned().collect(),
        };
        match self.container(&connection) {
            Ok(()) => {}
            Err(HostError::Absent(_) | HostError::Conflict(_)) => return Ok(false),
            Err(error) => return Err(error),
        }
        match self.network(&connection) {
            Ok(revision) if revision == binding.network_revision => {}
            Ok(_) | Err(HostError::Absent(_) | HostError::Conflict(_)) => return Ok(false),
            Err(error) => return Err(error),
        }
        match self.resolver.endpoint(&connection) {
            Ok(endpoint) if endpoint == binding.endpoint => {}
            Ok(_) | Err(HostError::Absent(_) | HostError::Conflict(_)) => return Ok(false),
            Err(error) => return Err(error),
        }
        for (key, revision) in &binding.credentials {
            let credential = match self.credentials.credential(key) {
                Ok(credential) => credential,
                Err(HostError::Absent(_) | HostError::Conflict(_)) => return Ok(false),
                Err(error) => return Err(error),
            };
            if credential.revision != *revision || credential.value.is_none() {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

/// Authenticated `PostgreSQL` transport. Secret material enters only `open`.
pub(crate) trait Peer: Send + Sync {
    fn open(
        &self,
        connection: &PostgresConnection,
        endpoint: &DatabaseEndpoint,
        material: &DatabaseAuthentication,
    ) -> Result<PostgresLeaseId, HostError>;
    fn start(&self, lease: &PostgresLeaseId, query: &PostgresQuery) -> Result<PostgresQueryId, HostError>;
    fn page(
        &self,
        lease: &PostgresLeaseId,
        query: &PostgresQueryId,
        cursor: Option<&PostgresCursor>,
    ) -> Result<PostgresPage, HostError>;
    fn cancel(&self, lease: &PostgresLeaseId, query: &PostgresQueryId) -> Result<PostgresQueryState, HostError>;
    fn close_query(&self, lease: &PostgresLeaseId, query: &PostgresQueryId) -> Result<(), HostError>;
    fn close_lease(&self, lease: &PostgresLeaseId) -> Result<(), HostError>;
}

#[derive(Clone)]
struct QueryRecord {
    request: PostgresQuery,
    id: PostgresQueryId,
    state: PostgresQueryState,
    cursor: Option<PostgresCursor>,
}

struct LeaseRecord {
    binding: Binding,
    queries: BTreeMap<String, QueryRecord>,
}

#[derive(Default)]
struct State {
    leases: HashMap<String, LeaseRecord>,
    opens: BTreeMap<String, (PostgresConnection, PostgresLeaseId)>,
}

/// Bounded broker scoped to one immutable extension installation.
pub(crate) struct HostPostgres<A, P> {
    installation: InstallationIdentity,
    authority: A,
    peer: P,
    state: Mutex<State>,
}

impl<A: Authority, P: Peer> HostPostgres<A, P> {
    pub(crate) fn new(installation: InstallationIdentity, authority: A, peer: P) -> Self {
        Self {
            installation,
            authority,
            peer,
            state: Mutex::new(State::default()),
        }
    }

    fn installation(&self, supplied: &InstallationIdentity) -> Result<(), HostError> {
        if supplied == &self.installation {
            Ok(())
        } else {
            Err(HostError::Absent(
                "postgres operation is not owned by this installation".into(),
            ))
        }
    }

    fn live<'a>(&self, state: &'a mut State, lease: &PostgresLeaseId) -> Result<&'a mut LeaseRecord, HostError> {
        let Some(record) = state.leases.get(lease.as_str()) else {
            return Err(HostError::Absent(
                "postgres lease is not owned by this installation".into(),
            ));
        };
        if self.authority.current(&record.binding)? {
            return state
                .leases
                .get_mut(lease.as_str())
                .ok_or_else(|| HostError::Absent("postgres lease is not owned by this installation".into()));
        }
        self.peer.close_lease(lease)?;
        state.leases.remove(lease.as_str());
        Err(HostError::Conflict("postgres lease authority was revoked".into()))
    }
}

impl<A: Authority, P: Peer> PostgresBroker for HostPostgres<A, P> {
    fn open_once(
        &self,
        installation: &InstallationIdentity,
        operation: &QueryOperationToken,
        connection: &PostgresConnection,
    ) -> Result<PostgresOpenOutcome, HostError> {
        self.installation(installation)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| HostError::Failed("postgres broker lock poisoned".into()))?;
        if let Some((existing, lease)) = state.opens.get(operation.as_str()).cloned() {
            if existing != *connection {
                return Err(HostError::Conflict(
                    "postgres open token was reused with a different connection".into(),
                ));
            }
            self.live(&mut state, &lease)?;
            return Ok(PostgresOpenOutcome::Reconciled { lease });
        }
        if state.opens.len() >= OPEN_LIMIT {
            return Err(HostError::Conflict("postgres open operation limit reached".into()));
        }
        let authentication = self.authority.authenticate(self.installation.as_str(), connection)?;
        if authentication.binding.installation != self.installation.as_str()
            || authentication.binding.container_id != connection.container_id
            || authentication.binding.container_generation != connection.container_generation
            || authentication.binding.network != connection.network
            || authentication.binding.network_revision == 0
            || authentication.binding.credentials.len() != connection.credential_keys.len()
            || connection
                .credential_keys
                .iter()
                .any(|key| !authentication.binding.credentials.contains_key(key))
        {
            return Err(HostError::Conflict(
                "authentication snapshot does not exactly bind the request".into(),
            ));
        }
        if state.leases.len() >= LEASE_LIMIT {
            return Err(HostError::Conflict("postgres lease limit reached".into()));
        }
        let id = self
            .peer
            .open(connection, &authentication.endpoint, &authentication.material)?;
        if state.leases.contains_key(id.as_str()) {
            self.peer.close_lease(&id)?;
            return Err(HostError::Conflict("postgres peer reused a live lease identity".into()));
        }
        match self.authority.current(&authentication.binding) {
            Ok(true) => {}
            Ok(false) => {
                self.peer.close_lease(&id)?;
                return Err(HostError::Conflict(
                    "postgres lease authority changed during connection".into(),
                ));
            }
            Err(error) => {
                self.peer.close_lease(&id)?;
                return Err(error);
            }
        }
        state.leases.insert(
            id.as_str().into(),
            LeaseRecord {
                binding: authentication.binding,
                queries: BTreeMap::new(),
            },
        );
        state
            .opens
            .insert(operation.as_str().into(), (connection.clone(), id.clone()));
        Ok(PostgresOpenOutcome::Opened { lease: id })
    }

    fn start_once(
        &self,
        installation: &InstallationIdentity,
        lease: &PostgresLeaseId,
        query: &PostgresQuery,
    ) -> Result<PostgresStartOutcome, HostError> {
        self.installation(installation)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| HostError::Failed("postgres broker lock poisoned".into()))?;
        let record = self.live(&mut state, lease)?;
        if let Some(existing) = record.queries.get(query.operation.as_str()) {
            if existing.request != *query {
                return Err(HostError::Conflict(
                    "query operation token was reused with different SQL or bounds".into(),
                ));
            }
            return Ok(PostgresStartOutcome::Reconciled {
                query: existing.id.clone(),
                state: existing.state.clone(),
            });
        }
        if record.queries.len() >= QUERY_LIMIT {
            return Err(HostError::Conflict(
                "postgres query limit reached; close a query first".into(),
            ));
        }
        let id = self.peer.start(lease, query)?;
        record.queries.insert(
            query.operation.as_str().into(),
            QueryRecord {
                request: query.clone(),
                id: id.clone(),
                state: PostgresQueryState::Running,
                cursor: None,
            },
        );
        Ok(PostgresStartOutcome::Started { query: id })
    }

    fn status(
        &self,
        installation: &InstallationIdentity,
        lease: &PostgresLeaseId,
        query: &PostgresQueryId,
    ) -> Result<PostgresQueryState, HostError> {
        self.installation(installation)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| HostError::Failed("postgres broker lock poisoned".into()))?;
        let record = self.live(&mut state, lease)?;
        record
            .queries
            .values()
            .find(|item| &item.id == query)
            .map(|item| item.state.clone())
            .ok_or_else(|| HostError::Absent("postgres query is not owned by this lease".into()))
    }

    fn page(
        &self,
        installation: &InstallationIdentity,
        lease: &PostgresLeaseId,
        query: &PostgresQueryId,
        cursor: Option<&PostgresCursor>,
    ) -> Result<PostgresPage, HostError> {
        self.installation(installation)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| HostError::Failed("postgres broker lock poisoned".into()))?;
        let record = self.live(&mut state, lease)?;
        let Some(query_record) = record.queries.values_mut().find(|item| &item.id == query) else {
            return Err(HostError::Absent("postgres query is not owned by this lease".into()));
        };
        if cursor != query_record.cursor.as_ref() {
            return Err(HostError::Conflict(
                "postgres cursor is stale or belongs to another page".into(),
            ));
        }
        let page = self.peer.page(lease, query, cursor)?;
        page.validate(&query_record.request)?;
        query_record.cursor.clone_from(&page.next_cursor);
        if page.next_cursor.is_none() {
            query_record.state = PostgresQueryState::Completed;
        }
        Ok(page)
    }

    fn cancel(
        &self,
        installation: &InstallationIdentity,
        lease: &PostgresLeaseId,
        query: &PostgresQueryId,
    ) -> Result<PostgresQueryState, HostError> {
        self.installation(installation)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| HostError::Failed("postgres broker lock poisoned".into()))?;
        let record = self.live(&mut state, lease)?;
        let Some(query_record) = record.queries.values_mut().find(|item| &item.id == query) else {
            return Err(HostError::Absent("postgres query is not owned by this lease".into()));
        };
        let status = self.peer.cancel(lease, query)?;
        query_record.state = status.clone();
        Ok(status)
    }

    fn close_query(
        &self,
        installation: &InstallationIdentity,
        lease: &PostgresLeaseId,
        query: &PostgresQueryId,
    ) -> Result<(), HostError> {
        self.installation(installation)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| HostError::Failed("postgres broker lock poisoned".into()))?;
        let record = self.live(&mut state, lease)?;
        let operation = record
            .queries
            .iter()
            .find_map(|(operation, item)| (&item.id == query).then(|| operation.clone()))
            .ok_or_else(|| HostError::Absent("postgres query is not owned by this lease".into()))?;
        self.peer.close_query(lease, query)?;
        record.queries.remove(&operation);
        Ok(())
    }

    fn close_lease(&self, installation: &InstallationIdentity, lease: &PostgresLeaseId) -> Result<(), HostError> {
        self.installation(installation)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| HostError::Failed("postgres broker lock poisoned".into()))?;
        if !state.leases.contains_key(lease.as_str()) {
            return Err(HostError::Absent(
                "postgres lease is not owned by this installation".into(),
            ));
        }
        self.peer.close_lease(lease)?;
        state.leases.remove(lease.as_str());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hl_extension::port::{ContainerSummary, ExtensionCredential, ExtensionState};
    use hl_extension::{NetworkEndpointInventory, NetworkKind, NetworkSummary};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    #[derive(Clone)]
    struct FakeAuthority {
        live: Arc<AtomicBool>,
        revision: Arc<AtomicUsize>,
        network_revision: Arc<AtomicUsize>,
    }

    impl Authority for FakeAuthority {
        fn authenticate(
            &self,
            installation: &str,
            connection: &PostgresConnection,
        ) -> Result<Authentication, HostError> {
            let endpoint = DatabaseEndpoint::new(
                "127.0.0.1:5432".parse().unwrap(),
                DatabaseTls::verify_full("database.internal").unwrap(),
                1_000,
                5_000,
            )
            .unwrap();
            Ok(Authentication {
                binding: Binding {
                    installation: installation.into(),
                    container_id: connection.container_id.clone(),
                    container_generation: connection.container_generation,
                    network: connection.network.clone(),
                    network_revision: self.network_revision.load(Ordering::SeqCst) as u64,
                    endpoint: endpoint.clone(),
                    credentials: BTreeMap::from([("db.password".into(), self.revision.load(Ordering::SeqCst) as u64)]),
                },
                endpoint,
                material: DatabaseAuthentication::new(vec![DatabaseCredential::Password(Secret::new(
                    b"host-only-password".to_vec(),
                ))])
                .unwrap(),
            })
        }

        fn current(&self, binding: &Binding) -> Result<bool, HostError> {
            Ok(self.live.load(Ordering::SeqCst)
                && binding.network_revision == self.network_revision.load(Ordering::SeqCst) as u64
                && binding.credentials.get("db.password") == Some(&(self.revision.load(Ordering::SeqCst) as u64)))
        }
    }

    #[derive(Clone, Default)]
    struct FakePeer {
        authenticated: Arc<AtomicBool>,
        opened: Arc<AtomicUsize>,
        closed: Arc<AtomicUsize>,
        fail_close: Arc<AtomicBool>,
    }

    impl Peer for FakePeer {
        fn open(
            &self,
            _: &PostgresConnection,
            endpoint: &DatabaseEndpoint,
            material: &DatabaseAuthentication,
        ) -> Result<PostgresLeaseId, HostError> {
            assert_eq!(endpoint.address(), "127.0.0.1:5432".parse().unwrap());
            assert_eq!(endpoint.tls().server_name(), "database.internal");
            assert_eq!(endpoint.timeouts_ms(), (1_000, 5_000));
            assert_eq!(material.credentials().len(), 1);
            let DatabaseCredential::Password(secret) = &material.credentials()[0] else {
                panic!("expected password")
            };
            assert_eq!(secret.as_bytes(), b"host-only-password");
            self.opened.fetch_add(1, Ordering::SeqCst);
            self.authenticated.store(true, Ordering::SeqCst);
            PostgresLeaseId::new("lease-1")
        }
        fn start(&self, _: &PostgresLeaseId, _: &PostgresQuery) -> Result<PostgresQueryId, HostError> {
            assert!(self.authenticated.load(Ordering::SeqCst));
            PostgresQueryId::new("query-1")
        }
        fn page(
            &self,
            _: &PostgresLeaseId,
            _: &PostgresQueryId,
            cursor: Option<&PostgresCursor>,
        ) -> Result<PostgresPage, HostError> {
            Ok(PostgresPage {
                columns: vec!["answer".into()],
                rows: vec![vec![Some("42".into())]],
                next_cursor: cursor.is_none().then(|| PostgresCursor::new("page-2").unwrap()),
                bytes: 2,
            })
        }
        fn cancel(&self, _: &PostgresLeaseId, _: &PostgresQueryId) -> Result<PostgresQueryState, HostError> {
            Ok(PostgresQueryState::Cancelled)
        }
        fn close_query(&self, _: &PostgresLeaseId, _: &PostgresQueryId) -> Result<(), HostError> {
            Ok(())
        }
        fn close_lease(&self, _: &PostgresLeaseId) -> Result<(), HostError> {
            if self.fail_close.load(Ordering::SeqCst) {
                return Err(HostError::Unavailable("peer close failed".into()));
            }
            self.closed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn connection() -> PostgresConnection {
        PostgresConnection {
            container_id: "a".repeat(64),
            container_generation: 9,
            network: "private-db".into(),
            port: 5432,
            database: "app".into(),
            user: "reader".into(),
            credential_keys: vec!["db.password".into()],
        }
    }

    fn query(token: &str, statement: &str) -> PostgresQuery {
        PostgresQuery::new(
            hl_extension::QueryOperationToken::new(token).unwrap(),
            statement,
            4,
            128,
        )
        .unwrap()
    }

    fn installation(value: char) -> InstallationIdentity {
        InstallationIdentity::new(value.to_string().repeat(32)).unwrap()
    }

    struct CurrentInstallation {
        owner: InstallationIdentity,
        live: AtomicBool,
    }

    impl InstallationAuthority for CurrentInstallation {
        fn current(&self, installation: &InstallationIdentity) -> Result<bool, HostError> {
            Ok(self.live.load(Ordering::SeqCst) && installation == &self.owner)
        }
    }

    struct ContainerService {
        generation: AtomicUsize,
    }

    impl ContainerInventory for ContainerService {
        fn list(&self) -> Result<Vec<ContainerSummary>, HostError> {
            Ok(Vec::new())
        }

        fn inspect(&self, id: &str) -> Result<ContainerSummary, HostError> {
            Ok(ContainerSummary {
                id: id.into(),
                name: "database".into(),
                image: "postgres:17".into(),
                state: "running".into(),
                created: 1,
                generation: self.generation.load(Ordering::SeqCst) as u64,
                ports: Vec::new(),
            })
        }
    }

    struct NetworkService {
        member: AtomicBool,
    }

    impl NetworkStore for NetworkService {
        fn inspect(&self, reference: &str) -> Result<NetworkSummary, HostError> {
            Ok(NetworkSummary {
                id: reference.into(),
                name: "private-db".into(),
                driver: "bridge".into(),
                scope: "local".into(),
                kind: NetworkKind::Custom,
                endpoints: Some(NetworkEndpointInventory {
                    containers: self
                        .member
                        .load(Ordering::SeqCst)
                        .then(|| "a".repeat(64))
                        .into_iter()
                        .collect(),
                    truncated: false,
                }),
            })
        }
    }

    struct CredentialService {
        revision: AtomicUsize,
        reads: AtomicUsize,
    }

    struct Resolver {
        resolutions: AtomicUsize,
        port: AtomicUsize,
    }

    impl DatabaseResolver for Resolver {
        fn endpoint(&self, _: &PostgresConnection) -> Result<DatabaseEndpoint, HostError> {
            self.resolutions.fetch_add(1, Ordering::SeqCst);
            DatabaseEndpoint::new(
                SocketAddr::from(([127, 0, 0, 1], self.port.load(Ordering::SeqCst) as u16)),
                DatabaseTls::verify_full("database.internal").unwrap(),
                1_000,
                5_000,
            )
        }

        fn role(&self, key: &str) -> Result<CredentialRole, HostError> {
            (key == "db.password")
                .then_some(CredentialRole::Password)
                .ok_or_else(|| HostError::Conflict("postgres credential role is not configured".into()))
        }
    }

    impl ExtensionStateStore for CredentialService {
        fn read(&self) -> Result<ExtensionState, HostError> {
            Err(HostError::Unsupported("not used".into()))
        }

        fn write(&self, _: &str, _: &[u8]) -> Result<String, HostError> {
            Err(HostError::Unsupported("not used".into()))
        }

        fn clear(&self, _: &str) -> Result<(), HostError> {
            Err(HostError::Unsupported("not used".into()))
        }

        fn credential(&self, key: &str) -> Result<ExtensionCredential, HostError> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(ExtensionCredential {
                key: key.into(),
                revision: self.revision.load(Ordering::SeqCst) as u64,
                value: Some(b"host-only-password".to_vec()),
            })
        }
    }

    #[test]
    fn production_authority_binds_real_service_snapshots_and_revokes_a_changed_private_route() {
        let owner = installation('a');
        let installations = CurrentInstallation {
            owner: owner.clone(),
            live: AtomicBool::new(true),
        };
        let containers = ContainerService {
            generation: AtomicUsize::new(9),
        };
        let networks = NetworkService {
            member: AtomicBool::new(true),
        };
        let credentials = CredentialService {
            revision: AtomicUsize::new(7),
            reads: AtomicUsize::new(0),
        };
        let resolver = Resolver {
            resolutions: AtomicUsize::new(0),
            port: AtomicUsize::new(5432),
        };
        let peer = FakePeer::default();
        let authority = ServiceAuthority::new(
            owner.clone(),
            &installations,
            &containers,
            &networks,
            &credentials,
            &resolver,
        );
        let broker = HostPostgres::new(owner.clone(), authority, peer.clone());
        let PostgresOpenOutcome::Opened { lease } = broker
            .open_once(
                &owner,
                &QueryOperationToken::new("production-open").unwrap(),
                &connection(),
            )
            .unwrap()
        else {
            panic!("new service snapshot must open")
        };

        resolver.port.store(6432, Ordering::SeqCst);
        assert!(matches!(
            broker.start_once(&owner, &lease, &query("production-query", "select 42")),
            Err(HostError::Conflict(_))
        ));
        assert_eq!(peer.closed.load(Ordering::SeqCst), 1);
        assert_eq!(resolver.resolutions.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn production_authority_denies_cross_installation_before_reading_a_secret() {
        let owner = installation('a');
        let installations = CurrentInstallation {
            owner: owner.clone(),
            live: AtomicBool::new(true),
        };
        let containers = ContainerService {
            generation: AtomicUsize::new(9),
        };
        let networks = NetworkService {
            member: AtomicBool::new(true),
        };
        let credentials = CredentialService {
            revision: AtomicUsize::new(7),
            reads: AtomicUsize::new(0),
        };
        let resolver = Resolver {
            resolutions: AtomicUsize::new(0),
            port: AtomicUsize::new(5432),
        };
        let authority = ServiceAuthority::new(owner, &installations, &containers, &networks, &credentials, &resolver);

        assert!(matches!(
            authority.authenticate(installation('b').as_str(), &connection()),
            Err(HostError::Absent(_))
        ));
        assert_eq!(credentials.reads.load(Ordering::SeqCst), 0);
        assert_eq!(resolver.resolutions.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn authority_revoked_during_open_is_closed_before_the_lease_is_published() {
        struct RevokingPeer {
            live: Arc<AtomicBool>,
            closed: Arc<AtomicUsize>,
        }

        impl Peer for RevokingPeer {
            fn open(
                &self,
                _: &PostgresConnection,
                _: &DatabaseEndpoint,
                _: &DatabaseAuthentication,
            ) -> Result<PostgresLeaseId, HostError> {
                self.live.store(false, Ordering::SeqCst);
                PostgresLeaseId::new("revoked-during-open")
            }

            fn start(&self, _: &PostgresLeaseId, _: &PostgresQuery) -> Result<PostgresQueryId, HostError> {
                panic!("a revoked lease must never start a query")
            }

            fn page(
                &self,
                _: &PostgresLeaseId,
                _: &PostgresQueryId,
                _: Option<&PostgresCursor>,
            ) -> Result<PostgresPage, HostError> {
                panic!("a revoked lease must never expose a page")
            }

            fn cancel(&self, _: &PostgresLeaseId, _: &PostgresQueryId) -> Result<PostgresQueryState, HostError> {
                panic!("a revoked lease must never be cancellable")
            }

            fn close_query(&self, _: &PostgresLeaseId, _: &PostgresQueryId) -> Result<(), HostError> {
                panic!("a revoked lease must never publish a query")
            }

            fn close_lease(&self, _: &PostgresLeaseId) -> Result<(), HostError> {
                self.closed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        }

        let live = Arc::new(AtomicBool::new(true));
        let authority = FakeAuthority {
            live: Arc::clone(&live),
            revision: Arc::new(AtomicUsize::new(7)),
            network_revision: Arc::new(AtomicUsize::new(3)),
        };
        let closed = Arc::new(AtomicUsize::new(0));
        let owner = installation('a');
        let broker = HostPostgres::new(
            owner.clone(),
            authority,
            RevokingPeer {
                live,
                closed: Arc::clone(&closed),
            },
        );

        assert!(matches!(
            broker.open_once(
                &owner,
                &QueryOperationToken::new("revoked-open").unwrap(),
                &connection(),
            ),
            Err(HostError::Conflict(message)) if message.contains("during connection")
        ));
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        assert!(matches!(
            broker.status(
                &owner,
                &PostgresLeaseId::new("revoked-during-open").unwrap(),
                &PostgresQueryId::new("never-published").unwrap(),
            ),
            Err(HostError::Absent(_))
        ));
    }

    #[test]
    fn durable_installation_lookup_fails_closed_when_the_record_is_absent() {
        let root = tempfile::tempdir().expect("workspace storage");
        let authority = WorkspaceInstallation::new(
            root.path().to_owned(),
            hl_extension::ExtensionName::new("postgres-browser").unwrap(),
        );
        assert!(!authority.current(&installation('a')).unwrap());
    }

    #[test]
    fn private_endpoint_and_credential_roles_are_strictly_bounded() {
        assert!(DatabaseTls::verify_full("").is_err());
        assert!(DatabaseTls::verify_full("-database.internal").is_err());
        assert!(DatabaseTls::verify_full("database..internal").is_err());
        let tls = DatabaseTls::verify_full("database.internal").unwrap();
        let address = "127.0.0.1:5432".parse().unwrap();
        assert!(DatabaseEndpoint::new(address, tls.clone(), 99, 1_000).is_err());
        assert!(DatabaseEndpoint::new(address, tls.clone(), 1_000, 30_001).is_err());
        let endpoint = DatabaseEndpoint::new(address, tls, 1_000, 5_000).unwrap();
        assert_eq!(endpoint.address(), address);
        assert_eq!(endpoint.timeouts_ms(), (1_000, 5_000));

        assert!(DatabaseAuthentication::new(Vec::new()).is_err());
        assert!(DatabaseAuthentication::new(vec![DatabaseCredential::RootCertificate(
            Secret::new(b"root".to_vec(),)
        )])
        .is_err());
        assert!(
            DatabaseAuthentication::new(vec![DatabaseCredential::ClientCertificate(Secret::new(
                b"certificate".to_vec(),
            ))])
            .is_err()
        );
        assert!(DatabaseAuthentication::new(vec![
            CredentialRole::ClientCertificate.material(Secret::new(b"certificate".to_vec())),
            CredentialRole::ClientPrivateKey.material(Secret::new(b"private-key".to_vec())),
            CredentialRole::RootCertificate.material(Secret::new(b"root".to_vec())),
            CredentialRole::Password.material(Secret::new(b"password".to_vec())),
        ])
        .is_ok());
        assert!(DatabaseAuthentication::new(vec![
            DatabaseCredential::Password(Secret::new(b"first".to_vec())),
            DatabaseCredential::Password(Secret::new(b"second".to_vec())),
        ])
        .is_err());
    }

    #[test]
    fn authentication_stays_host_side_and_lost_start_reply_reconciles_exactly() {
        let authority = FakeAuthority {
            live: Arc::new(AtomicBool::new(true)),
            revision: Arc::new(AtomicUsize::new(7)),
            network_revision: Arc::new(AtomicUsize::new(3)),
        };
        let peer = FakePeer::default();
        let owner = installation('a');
        let broker = HostPostgres::new(owner.clone(), authority, peer.clone());
        let operation = QueryOperationToken::new("open-a").unwrap();
        let PostgresOpenOutcome::Opened { lease } = broker.open_once(&owner, &operation, &connection()).unwrap() else {
            panic!()
        };
        assert!(matches!(
            broker.open_once(&owner, &operation, &connection()).unwrap(),
            PostgresOpenOutcome::Reconciled { .. }
        ));
        assert_eq!(peer.opened.load(Ordering::SeqCst), 1);
        assert!(matches!(
            broker.open_once(&installation('b'), &operation, &connection()),
            Err(HostError::Absent(_))
        ));
        let mut changed = connection();
        changed.database = "other".into();
        assert!(matches!(
            broker.open_once(&owner, &operation, &changed),
            Err(HostError::Conflict(_))
        ));
        let request = query("operation-a", "select 42");
        let started = broker.start_once(&owner, &lease, &request).unwrap();
        assert!(matches!(started, PostgresStartOutcome::Started { .. }));
        assert!(matches!(
            broker.start_once(&owner, &lease, &request).unwrap(),
            PostgresStartOutcome::Reconciled {
                state: PostgresQueryState::Running,
                ..
            }
        ));
        assert!(matches!(
            broker.start_once(&owner, &lease, &query("operation-a", "delete from users")),
            Err(HostError::Conflict(_))
        ));
        let public = format!("{started:?}");
        assert!(!public.contains("host-only-password"));
        let PostgresStartOutcome::Started { query } = started else {
            panic!()
        };
        assert_eq!(
            broker.cancel(&owner, &lease, &query).unwrap(),
            PostgresQueryState::Cancelled
        );
        assert!(matches!(
            broker.start_once(&owner, &lease, &request).unwrap(),
            PostgresStartOutcome::Reconciled {
                state: PostgresQueryState::Cancelled,
                ..
            }
        ));
        broker.close_query(&owner, &lease, &query).unwrap();
        broker.close_lease(&owner, &lease).unwrap();
    }

    #[test]
    fn failed_peer_close_preserves_lease_ownership_for_an_exact_retry() {
        let authority = FakeAuthority {
            live: Arc::new(AtomicBool::new(true)),
            revision: Arc::new(AtomicUsize::new(7)),
            network_revision: Arc::new(AtomicUsize::new(3)),
        };
        let peer = FakePeer::default();
        let owner = installation('a');
        let broker = HostPostgres::new(owner.clone(), authority, peer.clone());
        let PostgresOpenOutcome::Opened { lease } = broker
            .open_once(&owner, &QueryOperationToken::new("retry-close").unwrap(), &connection())
            .unwrap()
        else {
            panic!("first open must publish one lease")
        };

        peer.fail_close.store(true, Ordering::SeqCst);
        assert!(matches!(
            broker.close_lease(&owner, &lease),
            Err(HostError::Unavailable(message)) if message == "peer close failed"
        ));
        assert!(matches!(
            broker.start_once(&owner, &lease, &query("after-failed-close", "select 1")),
            Ok(PostgresStartOutcome::Started { .. })
        ));

        peer.fail_close.store(false, Ordering::SeqCst);
        broker.close_lease(&owner, &lease).unwrap();
        assert_eq!(peer.closed.load(Ordering::SeqCst), 1);
        assert!(matches!(broker.close_lease(&owner, &lease), Err(HostError::Absent(_))));
    }

    #[test]
    fn cursor_is_single_use_bounded_and_rotation_revokes_before_peer_use() {
        let authority = FakeAuthority {
            live: Arc::new(AtomicBool::new(true)),
            revision: Arc::new(AtomicUsize::new(7)),
            network_revision: Arc::new(AtomicUsize::new(3)),
        };
        let peer = FakePeer::default();
        let owner = installation('a');
        let broker = HostPostgres::new(owner.clone(), authority.clone(), peer.clone());
        let PostgresOpenOutcome::Opened { lease } = broker
            .open_once(&owner, &QueryOperationToken::new("open-a").unwrap(), &connection())
            .unwrap()
        else {
            panic!()
        };
        let request = query("operation-a", "select 42");
        let PostgresStartOutcome::Started { query } = broker.start_once(&owner, &lease, &request).unwrap() else {
            panic!()
        };
        let first = broker.page(&owner, &lease, &query, None).unwrap();
        assert_eq!(first.rows, vec![vec![Some("42".into())]]);
        assert!(matches!(
            broker.page(&owner, &lease, &query, None),
            Err(HostError::Conflict(_))
        ));
        let cursor = PostgresCursor::new("page-2").unwrap();
        broker.page(&owner, &lease, &query, Some(&cursor)).unwrap();
        authority.revision.store(8, Ordering::SeqCst);
        assert!(matches!(
            broker.cancel(&owner, &lease, &query),
            Err(HostError::Conflict(_))
        ));
        assert_eq!(peer.closed.load(Ordering::SeqCst), 1);
        assert!(matches!(
            broker.page(&owner, &lease, &query, None),
            Err(HostError::Absent(_))
        ));
    }

    #[test]
    fn network_change_revokes_the_exact_lease_before_transport_use() {
        let authority = FakeAuthority {
            live: Arc::new(AtomicBool::new(true)),
            revision: Arc::new(AtomicUsize::new(7)),
            network_revision: Arc::new(AtomicUsize::new(3)),
        };
        let peer = FakePeer::default();
        let owner = installation('a');
        let broker = HostPostgres::new(owner.clone(), authority.clone(), peer.clone());
        let PostgresOpenOutcome::Opened { lease } = broker
            .open_once(&owner, &QueryOperationToken::new("open-a").unwrap(), &connection())
            .unwrap()
        else {
            panic!()
        };
        authority.network_revision.store(4, Ordering::SeqCst);
        assert!(matches!(
            broker.start_once(&owner, &lease, &query("operation-a", "select 42")),
            Err(HostError::Conflict(_))
        ));
        assert_eq!(peer.closed.load(Ordering::SeqCst), 1);
    }
}
