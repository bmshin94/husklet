//! Host-owned PostgreSQL broker state.
//!
//! The wire-facing request contains only credential names. This boundary asks
//! the host authority for one atomic authentication snapshot and hands secret
//! bytes directly to an injected transport. No production PostgreSQL transport
//! is claimed here; the peer trait is the seam a TLS/PostgreSQL implementation
//! must satisfy.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use hl_extension::{
    HostError, PostgresBroker, PostgresConnection, PostgresCursor, PostgresLeaseId, PostgresOpenOutcome, PostgresPage,
    PostgresQuery, PostgresQueryId, PostgresQueryState, PostgresStartOutcome, QueryOperationToken,
};
use hl_rpc::InstallationIdentity;

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
    pub(crate) credentials: BTreeMap<String, u64>,
}

pub(crate) struct Secret(Vec<u8>);

impl Secret {
    pub(crate) fn new(value: Vec<u8>) -> Self {
        Self(value)
    }

    pub(crate) fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

pub(crate) struct Authentication {
    pub(crate) binding: Binding,
    pub(crate) secrets: Vec<(String, Secret)>,
}

/// Host authority queried atomically before authentication and on every use.
pub(crate) trait Authority: Send + Sync {
    fn authenticate(&self, installation: &str, connection: &PostgresConnection) -> Result<Authentication, HostError>;
    fn current(&self, binding: &Binding) -> Result<bool, HostError>;
}

/// Authenticated `PostgreSQL` transport. Secret material enters only `open`.
pub(crate) trait Peer: Send + Sync {
    fn open(&self, connection: &PostgresConnection, secrets: &[(String, Secret)])
        -> Result<PostgresLeaseId, HostError>;
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
        let id = self.peer.open(connection, &authentication.secrets)?;
        if state.leases.contains_key(id.as_str()) {
            self.peer.close_lease(&id)?;
            return Err(HostError::Conflict("postgres peer reused a live lease identity".into()));
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
        if state.leases.remove(lease.as_str()).is_none() {
            return Err(HostError::Absent(
                "postgres lease is not owned by this installation".into(),
            ));
        }
        self.peer.close_lease(lease)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
            Ok(Authentication {
                binding: Binding {
                    installation: installation.into(),
                    container_id: connection.container_id.clone(),
                    container_generation: connection.container_generation,
                    network: connection.network.clone(),
                    network_revision: self.network_revision.load(Ordering::SeqCst) as u64,
                    credentials: BTreeMap::from([("db.password".into(), self.revision.load(Ordering::SeqCst) as u64)]),
                },
                secrets: vec![("db.password".into(), Secret::new(b"host-only-password".to_vec()))],
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
    }

    impl Peer for FakePeer {
        fn open(&self, _: &PostgresConnection, secrets: &[(String, Secret)]) -> Result<PostgresLeaseId, HostError> {
            assert_eq!(secrets.len(), 1);
            assert_eq!(secrets[0].0, "db.password");
            assert_eq!(secrets[0].1.as_bytes(), b"host-only-password");
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
