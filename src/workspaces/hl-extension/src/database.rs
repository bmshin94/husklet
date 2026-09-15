//! Host-owned database connections for extensions.
//!
//! These types deliberately cannot carry credential values. The broker resolves
//! the named keys behind its boundary and returns only opaque identities.

use std::collections::{BTreeMap, BTreeSet};

use crate::{ContainerGrant, ContainerSelector, CredentialGrant, HostError, NetworkGrant};

const TEXT_LIMIT: usize = 128;
const QUERY_LIMIT: usize = 1024 * 1024;
const PAGE_ROWS_LIMIT: u32 = 1_000;
const PAGE_BYTES_LIMIT: u32 = 4 * 1024 * 1024;
const IDENTIFIER_LIMIT: usize = 63;

fn bounded(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && !value.contains('\0')
}

macro_rules! opaque_impl {
    ($name:ident) => {
        impl $name {
            pub const LIMIT: usize = 128;
            pub fn new(value: impl Into<String>) -> Result<Self, HostError> {
                let value = value.into();
                bounded(&value, Self::LIMIT)
                    .then_some(Self(value))
                    .ok_or_else(|| HostError::Conflict(concat!(stringify!($name), " is invalid").into()))
            }
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl TryFrom<String> for $name {
            type Error = HostError;
            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }
        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, serde::Deserialize, serde::Serialize)]
#[serde(try_from = "String", into = "String")]
pub struct PostgresLeaseId(String);
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, serde::Deserialize, serde::Serialize)]
#[serde(try_from = "String", into = "String")]
pub struct PostgresQueryId(String);
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, serde::Deserialize, serde::Serialize)]
#[serde(try_from = "String", into = "String")]
pub struct PostgresCursor(String);
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, serde::Deserialize, serde::Serialize)]
#[serde(try_from = "String", into = "String")]
pub struct QueryOperationToken(String);
opaque_impl!(PostgresLeaseId);
opaque_impl!(PostgresQueryId);
opaque_impl!(PostgresCursor);
opaque_impl!(QueryOperationToken);

/// Secret-free intent for one exact database endpoint.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct PostgresConnection {
    pub container_id: String,
    pub container_generation: u64,
    pub network: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    /// Exact host credential keys. Values never cross this boundary.
    pub credential_keys: Vec<String>,
}

impl PostgresConnection {
    pub const CREDENTIAL_LIMIT: usize = 8;

    /// Validates syntax and the extension's exact resource grants.
    pub fn authorize(
        &self,
        containers: &ContainerGrant,
        networks: &NetworkGrant,
        credentials: &CredentialGrant,
    ) -> Result<(), HostError> {
        let container_allowed = containers.selectors.iter().any(|selector| match selector {
            ContainerSelector::Id { id } => id.eq_ignore_ascii_case(&self.container_id),
            ContainerSelector::All { all } => *all,
            ContainerSelector::Name { .. } => false,
        });
        if !container_allowed {
            return Err(HostError::Conflict("exact container id is not granted".into()));
        }
        if !matches!(self.container_id.len(), 32 | 64)
            || !self.container_id.bytes().all(|byte| byte.is_ascii_hexdigit())
            || self.container_generation == 0
            || self.port == 0
            || !bounded(&self.network, 255)
            || !networks.permits_reference(&self.network)
            || !bounded(&self.database, TEXT_LIMIT)
            || !bounded(&self.user, TEXT_LIMIT)
            || self.credential_keys.is_empty()
            || self.credential_keys.len() > Self::CREDENTIAL_LIMIT
            || self.credential_keys.iter().collect::<BTreeSet<_>>().len() != self.credential_keys.len()
            || self.credential_keys.iter().any(|key| !credentials.permits_use(key))
        {
            return Err(HostError::Conflict(
                "invalid or ungranted postgres connection intent".into(),
            ));
        }
        Ok(())
    }
}

/// Version of a named secret observed only by the host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialRevision {
    pub key: String,
    pub revision: u64,
}

/// Opaque lease plus the host-private authority binding used for revocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PostgresLease {
    pub id: PostgresLeaseId,
    container_id: String,
    container_generation: u64,
    credentials: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PostgresLeaseRevocation {
    ContainerReplaced,
    CredentialRotated { key: String },
}

impl PostgresLease {
    pub fn bind(
        id: PostgresLeaseId,
        connection: &PostgresConnection,
        revisions: &[CredentialRevision],
    ) -> Result<Self, HostError> {
        let credentials = revisions
            .iter()
            .map(|item| (item.key.clone(), item.revision))
            .collect::<BTreeMap<_, _>>();
        if credentials.len() != connection.credential_keys.len()
            || connection
                .credential_keys
                .iter()
                .any(|key| !credentials.contains_key(key))
            || revisions.iter().any(|item| item.revision == 0)
        {
            return Err(HostError::Conflict(
                "credential revisions do not exactly bind the request".into(),
            ));
        }
        Ok(Self {
            id,
            container_id: connection.container_id.clone(),
            container_generation: connection.container_generation,
            credentials,
        })
    }

    pub fn validate(
        &self,
        container_id: &str,
        generation: u64,
        revisions: &[CredentialRevision],
    ) -> Result<(), PostgresLeaseRevocation> {
        if self.container_id != container_id || self.container_generation != generation {
            return Err(PostgresLeaseRevocation::ContainerReplaced);
        }
        let current = revisions
            .iter()
            .map(|item| (&item.key, item.revision))
            .collect::<BTreeMap<_, _>>();
        for (key, revision) in &self.credentials {
            if current.get(key) != Some(revision) {
                return Err(PostgresLeaseRevocation::CredentialRotated { key: key.clone() });
            }
        }
        Ok(())
    }
}

/// A validated, bounded query start. `operation` is the reconciliation key;
/// callers must inspect it after a lost reply and must never blindly replay SQL.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct PostgresQuery {
    pub operation: QueryOperationToken,
    pub statement: String,
    pub page_rows: u32,
    pub page_bytes: u32,
}

/// A catalogue view selected by the extension without accepting SQL text.
///
/// The host translates this closed set into a fixed `pg_catalog` query. This is
/// the read-only surface for database browsers; caller-provided SQL remains a
/// separate `postgres:write` operation even when it begins with `SELECT`.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(tag = "resource", rename_all = "snake_case", deny_unknown_fields)]
pub enum PostgresCatalogueResource {
    Schemas,
    Relations { schema: String },
    Columns { schema: String, relation: String },
    Indexes { schema: String, relation: String },
}

/// Bounded, replay-safe request for one host-generated catalogue query.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct PostgresCatalogueQuery {
    pub operation: QueryOperationToken,
    pub resource: PostgresCatalogueResource,
    pub page_rows: u32,
    pub page_bytes: u32,
}

impl PostgresCatalogueQuery {
    fn identifier(value: &str) -> Result<(), HostError> {
        if bounded(value, IDENTIFIER_LIMIT) {
            Ok(())
        } else {
            Err(HostError::Conflict("postgres catalogue identifier is invalid".into()))
        }
    }

    fn literal(value: &str) -> String {
        let hex = value
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        format!("pg_catalog.convert_from(pg_catalog.decode('{hex}', 'hex'), 'UTF8')")
    }

    /// Produces SQL exclusively from host-owned templates and quoted data.
    pub fn query(&self) -> Result<PostgresQuery, HostError> {
        let statement = match &self.resource {
            PostgresCatalogueResource::Schemas => String::from(
                "SELECT n.nspname AS schema FROM pg_catalog.pg_namespace AS n \
                 WHERE n.nspname !~ '^pg_temp_' AND pg_catalog.has_schema_privilege(n.oid, 'USAGE') \
                 ORDER BY n.nspname",
            ),
            PostgresCatalogueResource::Relations { schema } => {
                Self::identifier(schema)?;
                format!(
                    "SELECT c.relname AS relation, CASE c.relkind \
                     WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table' \
                     WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view' \
                     WHEN 'f' THEN 'foreign_table' ELSE c.relkind::text END AS kind \
                     FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace \
                     WHERE n.nspname = {} AND c.relkind IN ('r','p','v','m','f') \
                     AND pg_catalog.has_table_privilege(c.oid, 'SELECT') ORDER BY c.relname",
                    Self::literal(schema)
                )
            }
            PostgresCatalogueResource::Columns { schema, relation } => {
                Self::identifier(schema)?;
                Self::identifier(relation)?;
                format!(
                    "SELECT a.attname AS column, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, \
                     a.attnotnull::text AS not_null, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default \
                     FROM pg_catalog.pg_attribute AS a JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid \
                     JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace \
                     LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                     WHERE n.nspname = {} AND c.relname = {} AND a.attnum > 0 AND NOT a.attisdropped \
                     AND pg_catalog.has_table_privilege(c.oid, 'SELECT') ORDER BY a.attnum",
                    Self::literal(schema),
                    Self::literal(relation)
                )
            }
            PostgresCatalogueResource::Indexes { schema, relation } => {
                Self::identifier(schema)?;
                Self::identifier(relation)?;
                format!(
                    "SELECT i.relname AS index, x.indisunique::text AS unique, x.indisprimary::text AS primary, \
                     pg_catalog.pg_get_indexdef(i.oid) AS definition FROM pg_catalog.pg_index AS x \
                     JOIN pg_catalog.pg_class AS t ON t.oid = x.indrelid \
                     JOIN pg_catalog.pg_class AS i ON i.oid = x.indexrelid \
                     JOIN pg_catalog.pg_namespace AS n ON n.oid = t.relnamespace \
                     WHERE n.nspname = {} AND t.relname = {} \
                     AND pg_catalog.has_table_privilege(t.oid, 'SELECT') ORDER BY i.relname",
                    Self::literal(schema),
                    Self::literal(relation)
                )
            }
        };
        PostgresQuery::new(self.operation.clone(), statement, self.page_rows, self.page_bytes)
    }
}

impl PostgresQuery {
    pub fn new(
        operation: QueryOperationToken,
        statement: impl Into<String>,
        page_rows: u32,
        page_bytes: u32,
    ) -> Result<Self, HostError> {
        let statement = statement.into();
        let query = Self {
            operation,
            statement,
            page_rows,
            page_bytes,
        };
        query.validate()?;
        Ok(query)
    }

    /// Revalidates values decoded from the untrusted socket.
    pub fn validate(&self) -> Result<(), HostError> {
        if !bounded(&self.statement, QUERY_LIMIT)
            || !(1..=PAGE_ROWS_LIMIT).contains(&self.page_rows)
            || !(1..=PAGE_BYTES_LIMIT).contains(&self.page_bytes)
        {
            return Err(HostError::Conflict("query or page bound is invalid".into()));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PostgresQueryState {
    Running,
    Completed,
    Cancelled,
    Failed,
}

/// State observed for one exact lease and query pair.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct PostgresStateReceipt {
    pub lease: PostgresLeaseId,
    pub query: PostgresQueryId,
    pub state: PostgresQueryState,
}

/// Explicit result of a start-or-reconcile call.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(tag = "disposition", rename_all = "snake_case")]
pub enum PostgresStartOutcome {
    Started {
        lease: PostgresLeaseId,
        operation: QueryOperationToken,
        query: PostgresQueryId,
    },
    Reconciled {
        lease: PostgresLeaseId,
        operation: QueryOperationToken,
        query: PostgresQueryId,
        state: PostgresQueryState,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(tag = "disposition", rename_all = "snake_case")]
pub enum PostgresOpenOutcome {
    Opened {
        operation: QueryOperationToken,
        lease: PostgresLeaseId,
    },
    Reconciled {
        operation: QueryOperationToken,
        lease: PostgresLeaseId,
    },
}

/// One bounded page. Cursor is opaque; an absent cursor means completion.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct PostgresPage {
    /// Exact connection lease this receipt belongs to.
    pub lease: PostgresLeaseId,
    /// Exact query this receipt belongs to.
    pub query: PostgresQueryId,
    /// Cursor presented to produce this page. `None` identifies the first page.
    pub cursor: Option<PostgresCursor>,
    pub columns: Vec<String>,
    /// Text-format PostgreSQL cells; `None` is SQL NULL.
    pub rows: Vec<Vec<Option<String>>>,
    pub next_cursor: Option<PostgresCursor>,
    pub bytes: u32,
}

impl PostgresPage {
    pub fn validate(
        &self,
        requested: &PostgresQuery,
        lease: &PostgresLeaseId,
        query: &PostgresQueryId,
        cursor: Option<&PostgresCursor>,
    ) -> Result<(), HostError> {
        if &self.lease != lease
            || &self.query != query
            || self.cursor.as_ref() != cursor
            || self.next_cursor.as_ref().is_some_and(|next| Some(next) == cursor)
            || self.rows.len() > requested.page_rows as usize
            || self.bytes > requested.page_bytes
            || self.columns.len() > 256
            || self.rows.iter().any(|row| row.len() != self.columns.len())
        {
            return Err(HostError::Failed("broker returned an invalid page".into()));
        }
        Ok(())
    }
}

/// Host boundary. Implementations resolve credential values internally,
/// authenticate, and persist operation-token reconciliation records.
pub trait PostgresBroker: Send + Sync {
    fn open_once(
        &self,
        installation: &hl_rpc::InstallationIdentity,
        operation: &QueryOperationToken,
        connection: &PostgresConnection,
    ) -> Result<PostgresOpenOutcome, HostError>;
    fn start_once(
        &self,
        installation: &hl_rpc::InstallationIdentity,
        lease: &PostgresLeaseId,
        query: &PostgresQuery,
    ) -> Result<PostgresStartOutcome, HostError>;
    fn status(
        &self,
        installation: &hl_rpc::InstallationIdentity,
        lease: &PostgresLeaseId,
        query: &PostgresQueryId,
    ) -> Result<PostgresQueryState, HostError>;
    fn page(
        &self,
        installation: &hl_rpc::InstallationIdentity,
        lease: &PostgresLeaseId,
        query: &PostgresQueryId,
        cursor: Option<&PostgresCursor>,
    ) -> Result<PostgresPage, HostError>;
    fn cancel(
        &self,
        installation: &hl_rpc::InstallationIdentity,
        lease: &PostgresLeaseId,
        query: &PostgresQueryId,
    ) -> Result<PostgresQueryState, HostError>;
    fn close_query(
        &self,
        installation: &hl_rpc::InstallationIdentity,
        lease: &PostgresLeaseId,
        query: &PostgresQueryId,
    ) -> Result<(), HostError>;
    fn close_lease(
        &self,
        installation: &hl_rpc::InstallationIdentity,
        lease: &PostgresLeaseId,
    ) -> Result<(), HostError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> PostgresConnection {
        PostgresConnection {
            container_id: "a".repeat(64),
            container_generation: 7,
            network: "db".into(),
            port: 5432,
            database: "app".into(),
            user: "reader".into(),
            credential_keys: vec!["postgres.password".into()],
        }
    }

    fn grants() -> (ContainerGrant, CredentialGrant) {
        (
            ContainerGrant {
                selectors: vec![ContainerSelector::Id { id: "a".repeat(64) }],
                create: false,
            },
            CredentialGrant {
                r#use: vec!["postgres.password".into()],
                ..CredentialGrant::default()
            },
        )
    }

    #[test]
    fn connection_requires_exact_id_and_opaque_use_authority_and_serializes_no_secret() {
        let request = connection();
        let (containers, credentials) = grants();
        let networks = NetworkGrant {
            selectors: vec![crate::NetworkSelector::Name { name: "db".into() }],
            create: false,
        };
        request.authorize(&containers, &networks, &credentials).unwrap();
        let encoded = serde_json::to_string(&request).unwrap();
        assert!(encoded.contains("postgres.password"));
        assert!(!encoded.contains("secret-value"));
        let names_only = ContainerGrant {
            selectors: vec![ContainerSelector::Name { name: "db".into() }],
            create: false,
        };
        assert!(request.authorize(&names_only, &networks, &credentials).is_err());
        assert!(request
            .authorize(&containers, &NetworkGrant::default(), &credentials)
            .is_err());
        assert!(request
            .authorize(&containers, &networks, &CredentialGrant::default())
            .is_err());
        let exposure_only = CredentialGrant {
            read: vec!["postgres.password".into()],
            expose_to_execution: vec!["postgres.password".into()],
            ..CredentialGrant::default()
        };
        assert!(request.authorize(&containers, &networks, &exposure_only).is_err());
    }

    #[test]
    fn lease_revokes_on_replacement_or_referenced_rotation_only() {
        let request = connection();
        let revisions = [CredentialRevision {
            key: "postgres.password".into(),
            revision: 4,
        }];
        let lease = PostgresLease::bind(PostgresLeaseId::new("lease-1").unwrap(), &request, &revisions).unwrap();
        assert_eq!(lease.validate(&request.container_id, 7, &revisions), Ok(()));
        assert_eq!(
            lease.validate(&request.container_id, 8, &revisions),
            Err(PostgresLeaseRevocation::ContainerReplaced)
        );
        assert_eq!(
            lease.validate(
                &request.container_id,
                7,
                &[CredentialRevision {
                    key: "postgres.password".into(),
                    revision: 5
                }]
            ),
            Err(PostgresLeaseRevocation::CredentialRotated {
                key: "postgres.password".into()
            })
        );
        let mut extra = revisions.to_vec();
        extra.push(CredentialRevision {
            key: "unrelated".into(),
            revision: 9,
        });
        assert_eq!(lease.validate(&request.container_id, 7, &extra), Ok(()));
    }

    #[test]
    fn query_and_page_bounds_are_enforced_and_reconciliation_is_explicit() {
        let query = PostgresQuery::new(QueryOperationToken::new("op-1").unwrap(), "select 1", 2, 128).unwrap();
        assert!(PostgresQuery::new(QueryOperationToken::new("op-2").unwrap(), "", 2, 128).is_err());
        assert!(PostgresQuery::new(QueryOperationToken::new("op-3").unwrap(), "select 1", 1_001, 128).is_err());
        let page = PostgresPage {
            lease: PostgresLeaseId::new("lease-1").unwrap(),
            query: PostgresQueryId::new("query-1").unwrap(),
            cursor: None,
            columns: vec!["n".into()],
            rows: vec![vec![Some("1".into())], vec![Some("2".into())]],
            next_cursor: Some(PostgresCursor::new("next").unwrap()),
            bytes: 64,
        };
        page.validate(
            &query,
            &PostgresLeaseId::new("lease-1").unwrap(),
            &PostgresQueryId::new("query-1").unwrap(),
            None,
        )
        .unwrap();
        assert!(page
            .validate(
                &query,
                &PostgresLeaseId::new("lease-1").unwrap(),
                &PostgresQueryId::new("another-query").unwrap(),
                None,
            )
            .is_err());
        assert!(page
            .validate(
                &query,
                &PostgresLeaseId::new("another-lease").unwrap(),
                &PostgresQueryId::new("query-1").unwrap(),
                None,
            )
            .is_err());
        assert!(page
            .validate(
                &query,
                &PostgresLeaseId::new("lease-1").unwrap(),
                &PostgresQueryId::new("query-1").unwrap(),
                Some(&PostgresCursor::new("wrong-page").unwrap()),
            )
            .is_err());
        let stalled = PostgresPage {
            cursor: Some(PostgresCursor::new("page-2").unwrap()),
            next_cursor: Some(PostgresCursor::new("page-2").unwrap()),
            ..page.clone()
        };
        assert!(stalled
            .validate(
                &query,
                &PostgresLeaseId::new("lease-1").unwrap(),
                &PostgresQueryId::new("query-1").unwrap(),
                Some(&PostgresCursor::new("page-2").unwrap()),
            )
            .is_err());
        let too_many = PostgresPage {
            rows: vec![vec![Some("1".into())], vec![Some("2".into())], vec![Some("3".into())]],
            ..page
        };
        assert!(too_many
            .validate(
                &query,
                &PostgresLeaseId::new("lease-1").unwrap(),
                &PostgresQueryId::new("query-1").unwrap(),
                None,
            )
            .is_err());
        let outcome = PostgresStartOutcome::Reconciled {
            lease: PostgresLeaseId::new("lease-1").unwrap(),
            operation: QueryOperationToken::new("op-1").unwrap(),
            query: PostgresQueryId::new("query-1").unwrap(),
            state: PostgresQueryState::Completed,
        };
        assert!(serde_json::to_string(&outcome).unwrap().contains("reconciled"));
    }

    #[test]
    fn opaque_id_deserialization_enforces_bounds() {
        assert!(serde_json::from_str::<PostgresLeaseId>("\"\"").is_err());
        assert!(serde_json::from_str::<QueryOperationToken>(&format!("\"{}\"", "x".repeat(129))).is_err());
        assert!(QueryOperationToken::new("bad\0token").is_err());
    }

    #[test]
    fn catalogue_queries_are_closed_bounded_templates_and_quote_identifiers_as_data() {
        let request = PostgresCatalogueQuery {
            operation: QueryOperationToken::new("catalogue-1").unwrap(),
            resource: PostgresCatalogueResource::Columns {
                schema: "tenant'; DELETE FROM users; --".into(),
                relation: "orders'2026".into(),
            },
            page_rows: 100,
            page_bytes: 64 * 1024,
        };
        let query = request.query().unwrap();
        assert_eq!(query.operation.as_str(), "catalogue-1");
        assert_eq!(query.page_rows, 100);
        assert_eq!(query.page_bytes, 64 * 1024);
        assert!(query.statement.contains(
            "n.nspname = pg_catalog.convert_from(pg_catalog.decode('74656e616e74273b2044454c4554452046524f4d2075736572733b202d2d', 'hex'), 'UTF8')"
        ));
        assert!(!query.statement.contains("DELETE FROM users"));
        assert!(query.statement.contains("pg_catalog.has_table_privilege"));

        let overlong = PostgresCatalogueQuery {
            resource: PostgresCatalogueResource::Relations { schema: "s".repeat(64) },
            ..request
        };
        assert!(overlong.query().is_err());
        let unbounded = PostgresCatalogueQuery {
            operation: QueryOperationToken::new("catalogue-2").unwrap(),
            resource: PostgresCatalogueResource::Schemas,
            page_rows: 1_001,
            page_bytes: 64 * 1024,
        };
        assert!(unbounded.query().is_err());
    }
}
