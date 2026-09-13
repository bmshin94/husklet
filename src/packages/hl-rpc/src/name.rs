//! The identity of the peer on the other end of a socket.

/// Identity of a connected peer. Also the key its grant and state are stored
/// under, so the alphabet is narrow enough to be a directory component and a
/// container name without further escaping.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, serde::Serialize)]
#[serde(transparent)]
pub struct PeerName(String);

/// Opaque identity of one installed peer generation.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, serde::Serialize)]
#[serde(transparent)]
pub struct InstallationIdentity(String);

impl InstallationIdentity {
    pub const LENGTH: usize = 32;

    pub fn new(value: impl Into<String>) -> Result<Self, InstallationRejection> {
        let value = value.into();
        if value.len() != Self::LENGTH
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(InstallationRejection);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> serde::Deserialize<'de> for InstallationIdentity {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

impl PeerName {
    /// Longest name accepted.
    pub const LIMIT: usize = 64;

    /// # Errors
    /// Returns `Rejection` when the name is empty, over-long, or contains
    /// anything outside the permitted alphabet.
    pub fn new(value: impl Into<String>) -> Result<Self, Rejection> {
        let value = value.into();
        if value.is_empty() || value.len() > Self::LIMIT {
            return Err(Rejection);
        }
        let permitted = value
            .chars()
            .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || "._-".contains(character));
        if !permitted || value.starts_with(['.', '-']) {
            return Err(Rejection);
        }
        Ok(Self(value))
    }

    /// The name as written.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for PeerName {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<'de> serde::Deserialize<'de> for PeerName {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

/// Why a name was refused.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Rejection;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InstallationRejection;

impl std::fmt::Display for InstallationRejection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("installation identity must be exactly 32 lowercase hexadecimal characters")
    }
}

impl std::error::Error for InstallationRejection {}

impl std::fmt::Display for Rejection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "name must be 1 to {} characters of a-z, 0-9, dot, underscore, or hyphen",
            PeerName::LIMIT
        )
    }
}

impl std::error::Error for Rejection {}

#[cfg(test)]
mod tests {
    use super::{InstallationIdentity, PeerName};

    #[test]
    fn a_name_outside_the_alphabet_is_refused_at_construction() {
        for refused in ["", "Upper", "has space", "-leading", ".leading", "a/b"] {
            assert!(PeerName::new(refused).is_err(), "{refused:?} must be refused");
        }
        for accepted in ["containers", "a.b_c-1"] {
            assert!(PeerName::new(accepted).is_ok(), "{accepted:?} must be accepted");
        }
    }

    #[test]
    fn deserializing_applies_the_same_refusals() {
        let refused: Result<PeerName, _> = serde_json::from_str("\"Upper\"");
        assert!(refused.is_err(), "a wire name must not bypass construction");
        let accepted: PeerName = serde_json::from_str("\"containers\"").expect("valid");
        assert_eq!(accepted.as_str(), "containers");
    }

    #[test]
    fn installation_identity_is_fixed_width_lowercase_hex() {
        assert!(InstallationIdentity::new("0123456789abcdef0123456789abcdef").is_ok());
        for refused in [
            "0123456789abcdef0123456789abcde",
            "0123456789abcdef0123456789abcdef0",
            "0123456789abcdef0123456789abcdeG",
        ] {
            assert!(InstallationIdentity::new(refused).is_err());
        }
    }
}
