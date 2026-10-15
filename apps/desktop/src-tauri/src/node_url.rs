// SPDX-License-Identifier: Apache-2.0
//! The home node URL of the node picker, checked again here before the shell persists it (the client checks
//! the same rules in `web/src/platform/nodeUrl.ts`): https only (plain http only for a development node on this
//! computer: `localhost`, `127.0.0.1`), no credentials, no path, query or fragment. The result is the origin.

use tauri::Url;

/// Longer input is refused before parsing.
const MAX_LENGTH: usize = 300;
/// Hosts that may be reached over plain HTTP (a node in development mode on this computer).
const DEV_HOSTS: [&str; 2] = ["localhost", "127.0.0.1"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeUrlError {
    Invalid,
    Insecure,
    Credentials,
    Path,
}

impl NodeUrlError {
    /// The error code the client translates (`node_picker.error.*`).
    pub fn code(self) -> &'static str {
        match self {
            Self::Invalid => "node_url.invalid",
            Self::Insecure => "node_url.insecure",
            Self::Credentials => "node_url.credentials",
            Self::Path => "node_url.path",
        }
    }
}

/// Validates a node URL and returns its origin (`https://tavrn.example`, `http://127.0.0.1:8300`).
pub fn validate(input: &str) -> Result<String, NodeUrlError> {
    let text = input.trim();
    if text.is_empty() || text.len() > MAX_LENGTH {
        return Err(NodeUrlError::Invalid);
    }
    let url = Url::parse(text).map_err(|_| NodeUrlError::Invalid)?;
    let host = url.host_str().filter(|h| !h.is_empty()).ok_or(NodeUrlError::Invalid)?;
    match url.scheme() {
        "https" => {}
        "http" if DEV_HOSTS.contains(&host) => {}
        "http" => return Err(NodeUrlError::Insecure),
        _ => return Err(NodeUrlError::Invalid),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(NodeUrlError::Credentials);
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(NodeUrlError::Path);
    }
    Ok(url.origin().ascii_serialization())
}

/// Longest account address accepted (local part, `@`, domain with an optional port).
pub const MAX_ACCOUNT: usize = 320;

/// An account address as the client's key store names accounts: `local@domain` or `local@domain:port`.
pub fn valid_account(account: &str) -> bool {
    if account.is_empty() || account.len() > MAX_ACCOUNT {
        return false;
    }
    let Some((local, host)) = account.split_once('@') else { return false };
    let (domain, port) = host.split_once(':').map_or((host, None), |(d, p)| (d, Some(p)));
    let local_ok = !local.is_empty() && local.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    let domain_ok = !domain.is_empty()
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && domain.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'));
    let port_ok = port.is_none_or(|p| !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()));
    local_ok && domain_ok && port_ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Vectors {
        accept: Vec<(String, String)>,
        refuse: Vec<(String, String)>,
        domains: Domains,
    }

    #[derive(serde::Deserialize)]
    struct Domains {
        valid: Vec<String>,
        invalid: Vec<String>,
    }

    /// The cases both shells test against (apps/shared-vectors/node_url.json, also read by the Electron shell's
    /// `node_url.test.ts`): https origins (normalized), plain http only for a development node on this computer, no
    /// credentials, paths, queries or fragments, nothing else; node domains without IP literals and ports.
    #[test]
    fn the_shared_vectors_of_both_shells() {
        let v: Vectors = serde_json::from_str(include_str!("../../../shared-vectors/node_url.json")).unwrap_or_else(|e| unreachable!("vectors: {e}"));
        assert!(!v.accept.is_empty() && !v.refuse.is_empty());
        for (input, normalized) in &v.accept {
            assert_eq!(validate(input).as_deref(), Ok(normalized.as_str()), "{input}");
        }
        for (input, code) in &v.refuse {
            assert_eq!(validate(input).map_err(NodeUrlError::code), Err(code.as_str()), "{input}");
        }
        for d in &v.domains.valid {
            assert!(crate::resolve::valid_domain(d), "{d}");
        }
        for d in &v.domains.invalid {
            assert!(!crate::resolve::valid_domain(d), "{d}");
        }
    }

    #[test]
    fn error_codes() {
        assert_eq!(NodeUrlError::Invalid.code(), "node_url.invalid");
        assert_eq!(NodeUrlError::Insecure.code(), "node_url.insecure");
        assert_eq!(NodeUrlError::Credentials.code(), "node_url.credentials");
        assert_eq!(NodeUrlError::Path.code(), "node_url.path");
    }
}
