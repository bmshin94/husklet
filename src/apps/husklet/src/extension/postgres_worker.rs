//! Lazy, bounded PostgreSQL query workers.
//!
//! A worker owns the runtime and connection driver for its whole lifetime. It
//! never eagerly collects a result set: each page advances an owned
//! `SimpleQueryStream` only far enough to satisfy the caller's row/byte bounds.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use hl_extension::{
    HostError, PostgresConnection, PostgresCursor, PostgresLeaseId, PostgresPage, PostgresQuery, PostgresQueryId,
    PostgresQueryState,
};
use tokio_postgres::{Client, SimpleQueryMessage, SimpleQueryStream};

use super::postgres::{DatabaseAuthentication, DatabaseCredential, DatabaseEndpoint, Peer};
use super::Bridge;

enum Executor {
    Shared(std::sync::Arc<Bridge>),
    #[cfg(test)]
    Owned(tokio::runtime::Runtime),
}

impl Executor {
    fn wait<F: std::future::Future>(&self, work: F) -> F::Output {
        match self {
            Self::Shared(bridge) => bridge.wait(work),
            #[cfg(test)]
            Self::Owned(runtime) => runtime.block_on(work),
        }
    }

    fn spawn<F>(&self, work: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        match self {
            Self::Shared(bridge) => bridge.spawn(work),
            #[cfg(test)]
            Self::Owned(runtime) => {
                runtime.spawn(work);
            }
        }
    }
}

struct PendingRow(Vec<Option<String>>);

struct Query {
    request: PostgresQuery,
    stream: Pin<Box<SimpleQueryStream>>,
    columns: Vec<String>,
    pending: Option<PendingRow>,
    ordinal: u64,
}

struct Lease {
    client: Client,
    cancellation: Cancellation,
    queries: HashMap<String, Query>,
    timeout: Duration,
}

enum Cancellation {
    #[cfg(test)]
    Plain(tokio_postgres::CancelToken),
    Tls(tokio_postgres::CancelToken),
}

/// One connection-owning worker. Production construction will require the TLS
/// connector; plaintext construction exists only for the protocol fixture.
pub(crate) struct QueryWorker {
    executor: Executor,
    leases: Mutex<HashMap<String, Lease>>,
    next_identity: std::sync::atomic::AtomicU64,
}

impl QueryWorker {
    #[cfg(test)]
    fn owned() -> Self {
        Self {
            executor: Executor::Owned(
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .unwrap(),
            ),
            leases: Mutex::new(HashMap::new()),
            next_identity: std::sync::atomic::AtomicU64::new(1),
        }
    }

    #[cfg(test)]
    fn plain(address: std::net::SocketAddr, timeout: Duration) -> Result<(Self, PostgresLeaseId), HostError> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(failed)?;
        let mut config = tokio_postgres::Config::new();
        config
            .host(&address.ip().to_string())
            .port(address.port())
            .user("fixture")
            .dbname("fixture")
            .ssl_mode(tokio_postgres::config::SslMode::Disable)
            .connect_timeout(timeout);
        let (client, connection) = runtime
            .block_on(async { tokio::time::timeout(timeout, config.connect(tokio_postgres::NoTls)).await })
            .map_err(|_| unavailable("postgres connection timed out"))?
            .map_err(unavailable_error)?;
        runtime.spawn(async move {
            let _ = connection.await;
        });
        let lease = PostgresLeaseId::new("lease-1")?;
        let cancellation = Cancellation::Plain(client.cancel_token());
        let worker = Self {
            executor: Executor::Owned(runtime),
            leases: Mutex::new(HashMap::from([(
                lease.as_str().into(),
                Lease {
                    client,
                    cancellation,
                    queries: HashMap::new(),
                    timeout,
                },
            )])),
            next_identity: std::sync::atomic::AtomicU64::new(2),
        };
        Ok((worker, lease))
    }

    pub(crate) fn new(bridge: std::sync::Arc<Bridge>) -> Self {
        Self {
            executor: Executor::Shared(bridge),
            leases: Mutex::new(HashMap::new()),
            next_identity: std::sync::atomic::AtomicU64::new(1),
        }
    }

    fn identity(&self, prefix: &str) -> Result<String, HostError> {
        let value = self.next_identity.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if value == u64::MAX {
            return Err(HostError::Conflict("postgres identity space exhausted".into()));
        }
        Ok(format!("{prefix}-{value}"))
    }

    fn start_query(&self, lease_id: &str, id: String, request: &PostgresQuery) -> Result<(), HostError> {
        request.validate()?;
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| failed("postgres query worker lock poisoned"))?;
        let lease = leases
            .get_mut(lease_id)
            .ok_or_else(|| HostError::Absent("postgres lease is not live".into()))?;
        if lease.queries.contains_key(&id) {
            return Err(HostError::Conflict("postgres query identity is already live".into()));
        }
        let stream = self
            .executor
            .wait(async {
                tokio::time::timeout(lease.timeout, lease.client.simple_query_raw(&request.statement)).await
            })
            .map_err(|_| unavailable("postgres query start timed out"))?
            .map_err(unavailable_error)?;
        lease.queries.insert(
            id,
            Query {
                request: request.clone(),
                stream: Box::pin(stream),
                columns: Vec::new(),
                pending: None,
                ordinal: 0,
            },
        );
        Ok(())
    }

    fn query_page(&self, lease_id: &str, id: &str, request: &PostgresQuery) -> Result<PostgresPage, HostError> {
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| failed("postgres query worker lock poisoned"))?;
        let lease = leases
            .get_mut(lease_id)
            .ok_or_else(|| HostError::Absent("postgres lease is not live".into()))?;
        let timeout = lease.timeout;
        let query = lease
            .queries
            .get_mut(id)
            .ok_or_else(|| HostError::Absent("postgres query is not live".into()))?;
        let mut rows = Vec::new();
        let mut bytes = 0u32;
        let mut complete = false;
        loop {
            let row = if let Some(row) = query.pending.take() {
                Some(row.0)
            } else {
                match self
                    .executor
                    .wait(async { tokio::time::timeout(timeout, query.stream.next()).await })
                    .map_err(|_| unavailable("postgres page timed out"))?
                {
                    Some(Ok(SimpleQueryMessage::RowDescription(columns))) => {
                        query.columns = columns.iter().map(|column| column.name().to_owned()).collect();
                        if query.columns.len() > 256 {
                            return Err(failed("postgres returned too many columns"));
                        }
                        continue;
                    }
                    Some(Ok(SimpleQueryMessage::Row(row))) => {
                        Some((0..row.len()).map(|index| row.get(index).map(str::to_owned)).collect())
                    }
                    Some(Ok(SimpleQueryMessage::CommandComplete(_))) => continue,
                    Some(Err(error)) => return Err(unavailable_error(error)),
                    None => {
                        complete = true;
                        None
                    }
                    Some(Ok(_)) => continue,
                }
            };
            let Some(row) = row else { break };
            let row_bytes = row
                .iter()
                .flatten()
                .try_fold(0u32, |total, value| {
                    total.checked_add(u32::try_from(value.len()).unwrap_or(u32::MAX))
                })
                .ok_or_else(|| failed("postgres row size overflow"))?;
            if row_bytes > request.page_bytes {
                return Err(failed("one postgres row exceeds the requested page byte bound"));
            }
            if rows.len() >= request.page_rows as usize || bytes.saturating_add(row_bytes) > request.page_bytes {
                query.pending = Some(PendingRow(row));
                break;
            }
            bytes += row_bytes;
            rows.push(row);
        }
        query.ordinal += 1;
        let next_cursor = (!complete)
            .then(|| hl_extension::PostgresCursor::new(format!("page-{}", query.ordinal)).expect("bounded cursor"));
        Ok(PostgresPage {
            columns: query.columns.clone(),
            rows,
            next_cursor,
            bytes,
        })
    }
}

impl Peer for QueryWorker {
    fn open(
        &self,
        connection: &PostgresConnection,
        endpoint: &DatabaseEndpoint,
        material: &DatabaseAuthentication,
    ) -> Result<PostgresLeaseId, HostError> {
        let password = material
            .credentials()
            .iter()
            .find_map(|credential| match credential {
                DatabaseCredential::Password(secret) => Some(secret.as_bytes()),
                _ => None,
            })
            .ok_or_else(|| HostError::Conflict("postgres password authentication is required".into()))?;
        if material.credentials().len() != 1 {
            return Err(HostError::Conflict(
                "postgres production transport currently accepts exactly one password credential".into(),
            ));
        }
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let tls = native_tls()?;
        let (connect_timeout_ms, io_timeout_ms) = endpoint.timeouts_ms();
        let mut config = tokio_postgres::Config::new();
        config
            .host(endpoint.tls().server_name())
            .hostaddr(endpoint.address().ip())
            .port(endpoint.address().port())
            .user(&connection.user)
            .dbname(&connection.database)
            .password(password)
            .ssl_mode(tokio_postgres::config::SslMode::Require)
            .connect_timeout(Duration::from_millis(u64::from(connect_timeout_ms)));
        let (client, driver) = self
            .executor
            .wait(async {
                tokio::time::timeout(
                    Duration::from_millis(u64::from(connect_timeout_ms)),
                    config.connect(tls),
                )
                .await
            })
            .map_err(|_| unavailable("postgres TLS connection timed out"))?
            .map_err(unavailable_error)?;
        let cancellation = Cancellation::Tls(client.cancel_token());
        self.executor.spawn(async move {
            if let Err(error) = driver.await {
                hl_log::hl_error!(hl_log::tag::RUNTIME, "postgres connection ended: {error}");
            }
        });
        let id = PostgresLeaseId::new(self.identity("lease")?)?;
        self.leases
            .lock()
            .map_err(|_| failed("postgres query worker lock poisoned"))?
            .insert(
                id.as_str().into(),
                Lease {
                    client,
                    cancellation,
                    queries: HashMap::new(),
                    timeout: Duration::from_millis(u64::from(io_timeout_ms)),
                },
            );
        Ok(id)
    }

    fn start(&self, lease: &PostgresLeaseId, query: &PostgresQuery) -> Result<PostgresQueryId, HostError> {
        let id = PostgresQueryId::new(self.identity("query")?)?;
        self.start_query(lease.as_str(), id.as_str().into(), query)?;
        Ok(id)
    }

    fn page(
        &self,
        lease: &PostgresLeaseId,
        query: &PostgresQueryId,
        _: Option<&PostgresCursor>,
    ) -> Result<PostgresPage, HostError> {
        let leases = self
            .leases
            .lock()
            .map_err(|_| failed("postgres query worker lock poisoned"))?;
        let request = leases
            .get(lease.as_str())
            .and_then(|lease| lease.queries.get(query.as_str()))
            .map(|query| query.request.clone());
        drop(leases);
        self.query_page(
            lease.as_str(),
            query.as_str(),
            &request.ok_or_else(|| HostError::Absent("postgres query is not live".into()))?,
        )
    }

    fn cancel(&self, lease: &PostgresLeaseId, query: &PostgresQueryId) -> Result<PostgresQueryState, HostError> {
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| failed("postgres query worker lock poisoned"))?;
        let lease = leases
            .get_mut(lease.as_str())
            .ok_or_else(|| HostError::Absent("postgres lease is not live".into()))?;
        if !lease.queries.contains_key(query.as_str()) {
            return Err(HostError::Absent("postgres query is not live".into()));
        }
        match &lease.cancellation {
            #[cfg(test)]
            Cancellation::Plain(token) => self
                .executor
                .wait(async { tokio::time::timeout(lease.timeout, token.cancel_query(tokio_postgres::NoTls)).await })
                .map_err(|_| unavailable("postgres cancellation timed out"))?
                .map_err(unavailable_error)?,
            Cancellation::Tls(token) => {
                let tls = native_tls()?;
                self.executor
                    .wait(async { tokio::time::timeout(lease.timeout, token.cancel_query(tls)).await })
                    .map_err(|_| unavailable("postgres cancellation timed out"))?
                    .map_err(unavailable_error)?;
            }
        }
        lease.queries.remove(query.as_str());
        Ok(PostgresQueryState::Cancelled)
    }

    fn close_query(&self, lease: &PostgresLeaseId, query: &PostgresQueryId) -> Result<(), HostError> {
        self.leases
            .lock()
            .map_err(|_| failed("postgres query worker lock poisoned"))?
            .get_mut(lease.as_str())
            .ok_or_else(|| HostError::Absent("postgres lease is not live".into()))?
            .queries
            .remove(query.as_str())
            .map(|_| ())
            .ok_or_else(|| HostError::Absent("postgres query is not live".into()))
    }

    fn close_lease(&self, lease: &PostgresLeaseId) -> Result<(), HostError> {
        self.leases
            .lock()
            .map_err(|_| failed("postgres query worker lock poisoned"))?
            .remove(lease.as_str())
            .map(|_| ())
            .ok_or_else(|| HostError::Absent("postgres lease is not live".into()))
    }
}

fn native_tls() -> Result<tokio_postgres_rustls::MakeRustlsConnect, HostError> {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let (tls, certificate_errors) = tokio_postgres_rustls::MakeRustlsConnect::with_native_certs()
        .map_err(|_| HostError::Unavailable("postgres platform trust store is empty".into()))?;
    if !certificate_errors.is_empty() {
        return Err(HostError::Unavailable(
            "postgres platform trust store contained unreadable certificates".into(),
        ));
    }
    Ok(tls)
}

fn failed(error: impl std::fmt::Display) -> HostError {
    HostError::Failed(error.to_string())
}

fn unavailable(detail: &str) -> HostError {
    HostError::Unavailable(detail.into())
}

fn unavailable_error(error: impl std::fmt::Display) -> HostError {
    HostError::Unavailable(format!("postgres transport failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hl_extension::QueryOperationToken;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    fn frame(kind: u8, body: &[u8]) -> Vec<u8> {
        let mut value = vec![kind];
        value.extend_from_slice(&(u32::try_from(body.len()).unwrap() + 4).to_be_bytes());
        value.extend_from_slice(body);
        value
    }

    fn fragmented(mut stream: TcpStream, bytes: &[u8]) {
        for byte in bytes {
            stream.write_all(&[*byte]).unwrap();
        }
    }

    fn fixture() -> (std::net::SocketAddr, std::sync::mpsc::Receiver<i32>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sent, received) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut length = [0; 4];
            stream.read_exact(&mut length).unwrap();
            let mut startup = vec![0; u32::from_be_bytes(length) as usize - 4];
            stream.read_exact(&mut startup).unwrap();
            fragmented(stream.try_clone().unwrap(), &frame(b'R', &0u32.to_be_bytes()));
            let mut key = Vec::new();
            key.extend_from_slice(&7i32.to_be_bytes());
            key.extend_from_slice(&11i32.to_be_bytes());
            fragmented(stream.try_clone().unwrap(), &frame(b'K', &key));
            fragmented(stream.try_clone().unwrap(), &frame(b'Z', b"I"));
            let mut header = [0; 5];
            stream.read_exact(&mut header).unwrap();
            let length = u32::from_be_bytes(header[1..5].try_into().unwrap()) as usize;
            let mut query = vec![0; length - 4];
            stream.read_exact(&mut query).unwrap();
            let mut description = Vec::new();
            description.extend_from_slice(&1u16.to_be_bytes());
            description.extend_from_slice(b"value\0");
            description.extend_from_slice(&0u32.to_be_bytes());
            description.extend_from_slice(&0i16.to_be_bytes());
            description.extend_from_slice(&25u32.to_be_bytes());
            description.extend_from_slice(&(-1i16).to_be_bytes());
            description.extend_from_slice(&(-1i32).to_be_bytes());
            description.extend_from_slice(&0i16.to_be_bytes());
            fragmented(stream.try_clone().unwrap(), &frame(b'T', &description));
            for value in [b"one".as_slice(), b"two", b"three"] {
                let mut row = Vec::new();
                row.extend_from_slice(&1u16.to_be_bytes());
                row.extend_from_slice(&(value.len() as u32).to_be_bytes());
                row.extend_from_slice(value);
                fragmented(stream.try_clone().unwrap(), &frame(b'D', &row));
            }
            fragmented(stream.try_clone().unwrap(), &frame(b'C', b"SELECT 3\0"));
            fragmented(stream, &frame(b'Z', b"I"));
            let (mut cancel, _) = listener.accept().unwrap();
            let mut packet = [0; 16];
            cancel.read_exact(&mut packet).unwrap();
            sent.send(i32::from_be_bytes(packet[8..12].try_into().unwrap()))
                .unwrap();
        });
        (address, received)
    }

    #[test]
    fn fragmented_result_is_consumed_lazily_without_losing_a_page_boundary() {
        let (address, _) = fixture();
        let (worker, lease) = QueryWorker::plain(address, Duration::from_secs(2)).unwrap();
        let request = PostgresQuery::new(QueryOperationToken::new("query-op").unwrap(), "select value", 2, 16).unwrap();
        worker.start_query(lease.as_str(), "query-1".into(), &request).unwrap();
        let first = worker.query_page(lease.as_str(), "query-1", &request).unwrap();
        assert_eq!(first.rows, vec![vec![Some("one".into())], vec![Some("two".into())]]);
        assert!(first.next_cursor.is_some());
        let second = worker.query_page(lease.as_str(), "query-1", &request).unwrap();
        assert_eq!(second.rows, vec![vec![Some("three".into())]]);
        assert!(second.next_cursor.is_none());
        worker.close_lease(&lease).unwrap();
    }

    #[test]
    fn page_byte_bound_retains_the_first_row_of_the_next_page() {
        let (address, _) = fixture();
        let (worker, lease) = QueryWorker::plain(address, Duration::from_secs(2)).unwrap();
        let request =
            PostgresQuery::new(QueryOperationToken::new("byte-bound-op").unwrap(), "select value", 8, 5).unwrap();
        worker.start_query(lease.as_str(), "query-2".into(), &request).unwrap();

        for (expected, complete) in [("one", false), ("two", false), ("three", true)] {
            let page = worker.query_page(lease.as_str(), "query-2", &request).unwrap();
            assert_eq!(page.rows, vec![vec![Some(expected.into())]]);
            assert_eq!(page.next_cursor.is_none(), complete);
            assert!(page.bytes <= request.page_bytes);
        }
        worker.close_lease(&lease).unwrap();
    }

    #[test]
    fn cancellation_uses_the_server_key_and_removes_the_stream() {
        let (address, cancellation) = fixture();
        let (worker, lease) = QueryWorker::plain(address, Duration::from_secs(2)).unwrap();
        let request =
            PostgresQuery::new(QueryOperationToken::new("cancel-op").unwrap(), "select value", 2, 16).unwrap();
        worker
            .start_query(lease.as_str(), "query-cancel".into(), &request)
            .unwrap();
        let query = PostgresQueryId::new("query-cancel").unwrap();
        assert_eq!(worker.cancel(&lease, &query).unwrap(), PostgresQueryState::Cancelled);
        assert_eq!(cancellation.recv_timeout(Duration::from_secs(2)).unwrap(), 7);
        assert!(matches!(
            worker.query_page(lease.as_str(), query.as_str(), &request),
            Err(HostError::Absent(_))
        ));
    }

    #[test]
    fn production_connector_refuses_a_server_that_declines_tls() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let observed = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 8];
            stream.read_exact(&mut request).unwrap();
            assert_eq!(u32::from_be_bytes(request[..4].try_into().unwrap()), 8);
            assert_eq!(u32::from_be_bytes(request[4..].try_into().unwrap()), 80_877_103);
            stream.write_all(b"N").unwrap();
        });
        let worker = QueryWorker::owned();
        let connection = PostgresConnection {
            container_id: "a".repeat(64),
            container_generation: 1,
            network: "database".into(),
            port: address.port(),
            database: "fixture".into(),
            user: "fixture".into(),
            credential_keys: vec!["db.password".into()],
        };
        let endpoint = DatabaseEndpoint::new(
            address,
            super::super::postgres::DatabaseTls::verify_full("localhost").unwrap(),
            1_000,
            1_000,
        )
        .unwrap();
        let material = DatabaseAuthentication::new(vec![DatabaseCredential::Password(
            super::super::postgres::Secret::new(b"not-logged".to_vec()),
        )])
        .unwrap();
        assert!(matches!(
            worker.open(&connection, &endpoint, &material),
            Err(HostError::Unavailable(_))
        ));
        observed.join().unwrap();
    }
}
