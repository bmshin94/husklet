//! Host-private, authority-bound database dialing.
//!
//! An extension can name only resources already in its database grant. The
//! resolver turns those names into a [`DialTarget`]; neither the resolved host
//! address nor the connected stream crosses the extension protocol.

use std::io;
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use hl_extension::HostError;

const MIN_TIMEOUT_MS: u32 = 100;
const MAX_TIMEOUT_MS: u32 = 30_000;

/// One exact host route to a container port, bound to both mutable identities.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DialTarget {
    container_id: String,
    container_generation: u64,
    network_id: String,
    network_revision: u64,
    address: SocketAddr,
}

impl DialTarget {
    pub(crate) fn new(
        container_id: impl Into<String>,
        container_generation: u64,
        network_id: impl Into<String>,
        network_revision: u64,
        address: SocketAddr,
    ) -> Result<Self, HostError> {
        let container_id = container_id.into();
        let network_id = network_id.into();
        if !matches!(container_id.len(), 32 | 64)
            || !container_id.bytes().all(|byte| byte.is_ascii_hexdigit())
            || container_generation == 0
            || network_id.is_empty()
            || network_id.len() > 255
            || network_id.contains('\0')
            || network_revision == 0
            || address.port() == 0
        {
            return Err(HostError::Conflict("database dial target is invalid".into()));
        }
        Ok(Self {
            container_id,
            container_generation,
            network_id,
            network_revision,
            address,
        })
    }

    pub(crate) fn address(&self) -> SocketAddr {
        self.address
    }
}

/// Re-resolves current container identity and network membership atomically.
pub(crate) trait DialAuthority: Send + Sync {
    fn current(&self, expected: &DialTarget) -> Result<DialTarget, HostError>;
}

/// Narrow connection factory, injectable so authority races are deterministic in tests.
pub(crate) trait Connector: Send + Sync {
    type Stream;

    fn connect(&self, address: SocketAddr, timeout: Duration) -> io::Result<Self::Stream>;
    fn configure(&self, stream: &Self::Stream, timeout: Duration) -> io::Result<()>;
}

/// Cross-platform connector for an already resolved private host route.
pub(crate) struct TcpConnector;

impl Connector for TcpConnector {
    type Stream = TcpStream;

    fn connect(&self, address: SocketAddr, timeout: Duration) -> io::Result<Self::Stream> {
        TcpStream::connect_timeout(&address, timeout)
    }

    fn configure(&self, stream: &Self::Stream, timeout: Duration) -> io::Result<()> {
        stream.set_read_timeout(Some(timeout))?;
        stream.set_write_timeout(Some(timeout))?;
        stream.set_nodelay(true)
    }
}

/// Dials only an exact target supplied and continuously confirmed by host authority.
pub(crate) struct PrivateDialer<A, C = TcpConnector> {
    authority: A,
    connector: C,
}

impl<A: DialAuthority> PrivateDialer<A, TcpConnector> {
    #[allow(dead_code)] // constructed when the production database resolver is installed
    pub(crate) fn new(authority: A) -> Self {
        Self {
            authority,
            connector: TcpConnector,
        }
    }
}

impl<A: DialAuthority, C: Connector> PrivateDialer<A, C> {
    #[cfg(test)]
    fn with_connector(authority: A, connector: C) -> Self {
        Self { authority, connector }
    }

    pub(crate) fn connect(
        &self,
        expected: &DialTarget,
        connect_timeout_ms: u32,
        io_timeout_ms: u32,
    ) -> Result<C::Stream, HostError> {
        if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&connect_timeout_ms)
            || !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&io_timeout_ms)
        {
            return Err(HostError::Conflict("database dial timeout is invalid".into()));
        }
        if self.authority.current(expected)? != *expected {
            return Err(HostError::Conflict("database dial target authority changed".into()));
        }
        let stream = self
            .connector
            .connect(expected.address(), Duration::from_millis(u64::from(connect_timeout_ms)))
            .map_err(|error| HostError::Unavailable(format!("database private route failed: {error}")))?;
        self.connector
            .configure(&stream, Duration::from_millis(u64::from(io_timeout_ms)))
            .map_err(|error| HostError::Unavailable(format!("database private route setup failed: {error}")))?;
        if self.authority.current(expected)? != *expected {
            drop(stream);
            return Err(HostError::Conflict(
                "database dial target authority changed during connection".into(),
            ));
        }
        Ok(stream)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct Authority {
        snapshots: Arc<Mutex<Vec<DialTarget>>>,
    }

    impl DialAuthority for Authority {
        fn current(&self, _: &DialTarget) -> Result<DialTarget, HostError> {
            let mut snapshots = self.snapshots.lock().unwrap();
            Ok(if snapshots.len() == 1 {
                snapshots[0].clone()
            } else {
                snapshots.remove(0)
            })
        }
    }

    #[derive(Clone, Default)]
    struct FakeConnector {
        connects: Arc<AtomicUsize>,
        configured: Arc<AtomicUsize>,
        dropped: Arc<AtomicUsize>,
        addresses: Arc<Mutex<Vec<SocketAddr>>>,
    }

    struct Stream(Arc<AtomicUsize>);

    impl Drop for Stream {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl Connector for FakeConnector {
        type Stream = Stream;

        fn connect(&self, address: SocketAddr, _: Duration) -> io::Result<Self::Stream> {
            self.connects.fetch_add(1, Ordering::SeqCst);
            self.addresses.lock().unwrap().push(address);
            Ok(Stream(Arc::clone(&self.dropped)))
        }

        fn configure(&self, _: &Self::Stream, _: Duration) -> io::Result<()> {
            self.configured.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn target(generation: u64, revision: u64, port: u16) -> DialTarget {
        DialTarget::new(
            "a".repeat(64),
            generation,
            "database",
            revision,
            SocketAddr::from(([127, 0, 0, 1], port)),
        )
        .unwrap()
    }

    #[test]
    fn exact_target_is_checked_before_and_after_connect() {
        let expected = target(7, 11, 15432);
        let connector = FakeConnector::default();
        let dialer = PrivateDialer::with_connector(
            Authority {
                snapshots: Arc::new(Mutex::new(vec![expected.clone()])),
            },
            connector.clone(),
        );
        dialer.connect(&expected, 1_000, 5_000).unwrap();
        assert_eq!(connector.connects.load(Ordering::SeqCst), 1);
        assert_eq!(connector.configured.load(Ordering::SeqCst), 1);
        assert_eq!(connector.dropped.load(Ordering::SeqCst), 1);
        assert_eq!(*connector.addresses.lock().unwrap(), vec![expected.address()]);
    }

    #[test]
    fn replacement_membership_change_and_spoofed_target_never_escape_authority() {
        for changed in [target(8, 11, 15432), target(7, 12, 15432), target(7, 11, 25432)] {
            let expected = target(7, 11, 15432);
            let connector = FakeConnector::default();
            let dialer = PrivateDialer::with_connector(
                Authority {
                    snapshots: Arc::new(Mutex::new(vec![changed])),
                },
                connector.clone(),
            );
            assert!(matches!(
                dialer.connect(&expected, 1_000, 5_000),
                Err(HostError::Conflict(_))
            ));
            assert_eq!(connector.connects.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn authority_change_during_connect_discards_the_stream() {
        let expected = target(7, 11, 15432);
        let connector = FakeConnector::default();
        let dialer = PrivateDialer::with_connector(
            Authority {
                snapshots: Arc::new(Mutex::new(vec![expected.clone(), target(7, 12, 15432)])),
            },
            connector.clone(),
        );
        assert!(matches!(
            dialer.connect(&expected, 1_000, 5_000),
            Err(HostError::Conflict(_))
        ));
        assert_eq!(connector.connects.load(Ordering::SeqCst), 1);
        assert_eq!(connector.configured.load(Ordering::SeqCst), 1);
        assert_eq!(connector.dropped.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn malformed_targets_and_unbounded_deadlines_are_rejected_before_connect() {
        assert!(DialTarget::new("name", 1, "database", 1, "127.0.0.1:5432".parse().unwrap()).is_err());
        let expected = target(7, 11, 15432);
        let connector = FakeConnector::default();
        let dialer = PrivateDialer::with_connector(
            Authority {
                snapshots: Arc::new(Mutex::new(vec![expected.clone()])),
            },
            connector.clone(),
        );
        assert!(dialer.connect(&expected, 99, 5_000).is_err());
        assert!(dialer.connect(&expected, 1_000, 30_001).is_err());
        assert_eq!(connector.connects.load(Ordering::SeqCst), 0);
    }
}
