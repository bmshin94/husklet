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
use hl_extension::{HostError, PostgresPage, PostgresQuery};
use tokio_postgres::{Client, SimpleQueryMessage, SimpleQueryStream};

struct PendingRow(Vec<Option<String>>);

struct Query {
    stream: Pin<Box<SimpleQueryStream>>,
    columns: Vec<String>,
    pending: Option<PendingRow>,
    ordinal: u64,
}

/// One connection-owning worker. Production construction will require the TLS
/// connector; plaintext construction exists only for the protocol fixture.
pub(crate) struct QueryWorker {
    runtime: tokio::runtime::Runtime,
    client: Client,
    queries: Mutex<HashMap<String, Query>>,
    timeout: Duration,
}

impl QueryWorker {
    #[cfg(test)]
    fn connect_plain(address: std::net::SocketAddr, timeout: Duration) -> Result<Self, HostError> {
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
        Ok(Self {
            runtime,
            client,
            queries: Mutex::new(HashMap::new()),
            timeout,
        })
    }

    pub(crate) fn start(&self, id: String, request: &PostgresQuery) -> Result<(), HostError> {
        request.validate()?;
        let mut queries = self
            .queries
            .lock()
            .map_err(|_| failed("postgres query worker lock poisoned"))?;
        if queries.contains_key(&id) {
            return Err(HostError::Conflict("postgres query identity is already live".into()));
        }
        let stream = self
            .runtime
            .block_on(async {
                tokio::time::timeout(self.timeout, self.client.simple_query_raw(&request.statement)).await
            })
            .map_err(|_| unavailable("postgres query start timed out"))?
            .map_err(unavailable_error)?;
        queries.insert(
            id,
            Query {
                stream: Box::pin(stream),
                columns: Vec::new(),
                pending: None,
                ordinal: 0,
            },
        );
        Ok(())
    }

    pub(crate) fn page(&self, id: &str, request: &PostgresQuery) -> Result<PostgresPage, HostError> {
        let mut queries = self
            .queries
            .lock()
            .map_err(|_| failed("postgres query worker lock poisoned"))?;
        let query = queries
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
                    .runtime
                    .block_on(async { tokio::time::timeout(self.timeout, query.stream.next()).await })
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

    #[cfg(test)]
    fn close(&self, id: &str) {
        self.queries.lock().unwrap().remove(id);
    }
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

    fn fixture() -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
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
        });
        address
    }

    #[test]
    fn fragmented_result_is_consumed_lazily_without_losing_a_page_boundary() {
        let worker = QueryWorker::connect_plain(fixture(), Duration::from_secs(2)).unwrap();
        let request = PostgresQuery::new(QueryOperationToken::new("query-op").unwrap(), "select value", 2, 16).unwrap();
        worker.start("query-1".into(), &request).unwrap();
        let first = worker.page("query-1", &request).unwrap();
        assert_eq!(first.rows, vec![vec![Some("one".into())], vec![Some("two".into())]]);
        assert!(first.next_cursor.is_some());
        let second = worker.page("query-1", &request).unwrap();
        assert_eq!(second.rows, vec![vec![Some("three".into())]]);
        assert!(second.next_cursor.is_none());
        worker.close("query-1");
    }

    #[test]
    fn page_byte_bound_retains_the_first_row_of_the_next_page() {
        let worker = QueryWorker::connect_plain(fixture(), Duration::from_secs(2)).unwrap();
        let request =
            PostgresQuery::new(QueryOperationToken::new("byte-bound-op").unwrap(), "select value", 8, 5).unwrap();
        worker.start("query-2".into(), &request).unwrap();

        for (expected, complete) in [("one", false), ("two", false), ("three", true)] {
            let page = worker.page("query-2", &request).unwrap();
            assert_eq!(page.rows, vec![vec![Some(expected.into())]]);
            assert_eq!(page.next_cursor.is_none(), complete);
            assert!(page.bytes <= request.page_bytes);
        }
        worker.close("query-2");
    }
}
