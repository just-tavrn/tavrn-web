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

    #[test]
    fn accepts_https_origins_and_normalizes_them() {
        assert_eq!(validate("https://tavrn.example"), Ok("https://tavrn.example".into()));
        assert_eq!(validate("  https://Tavrn.Example/  "), Ok("https://tavrn.example".into()));
        assert_eq!(validate("https://chat.tavrn.example:8443/"), Ok("https://chat.tavrn.example:8443".into()));
        assert_eq!(validate("https://tavrn.example:443"), Ok("https://tavrn.example".into()));
        assert_eq!(validate("https://bücher.example"), Ok("https://xn--bcher-kva.example".into()));
    }

    #[test]
    fn plain_http_only_for_a_development_node_on_this_computer() {
        assert_eq!(validate("http://localhost:8080"), Ok("http://localhost:8080".into()));
        assert_eq!(validate("http://127.0.0.1:8300/"), Ok("http://127.0.0.1:8300".into()));
        for bad in ["http://evil", "http://tavrn.example", "http://192.168.1.2", "http://localhost.evil.example", "http://127.0.0.2"] {
            assert_eq!(validate(bad), Err(NodeUrlError::Insecure), "{bad}");
        }
    }

    #[test]
    fn refuses_credentials() {
        assert_eq!(validate("https://user:pw@tavrn.example"), Err(NodeUrlError::Credentials));
        assert_eq!(validate("https://user@tavrn.example"), Err(NodeUrlError::Credentials));
        assert_eq!(validate("https://:pw@tavrn.example"), Err(NodeUrlError::Credentials));
    }

    #[test]
    fn refuses_paths_queries_and_fragments() {
        for bad in
            ["https://tavrn.example/app", "https://tavrn.example/?x=1", "https://tavrn.example/?", "https://tavrn.example/#top", "https://tavrn.example//"]
        {
            assert_eq!(validate(bad), Err(NodeUrlError::Path), "{bad}");
        }
    }

    #[test]
    fn refuses_other_schemes_and_garbage() {
        let long = format!("https://{}.example", "a".repeat(300));
        for bad in [
            "",
            "   ",
            "tavrn.example",
            "ftp://tavrn.example",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "tauri://localhost",
            "https://",
            "https://exa mple.org",
            long.as_str(),
        ] {
            assert_eq!(validate(bad), Err(NodeUrlError::Invalid), "{bad}");
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
