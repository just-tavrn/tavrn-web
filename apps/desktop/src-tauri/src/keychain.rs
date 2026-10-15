// SPDX-License-Identifier: Apache-2.0
//! The OS keychain (docs/DESKTOP.md "Keys in the OS keychain"): the client's local key store (IndexedDB) is
//! encrypted with a *local storage key* derived from the account's master secret. In a browser that key is persisted
//! next to the data; in the app it lives here instead, in the Secret Service (Linux), the Credential Manager (Windows)
//! or the Keychain (macOS, later), so the files of the webview alone open nothing.
//!
//! Entries: service `org.tavrn.desktop`, user `local-key/<home node origin>/<account address>`. The node part is
//! never taken from the client: it is the home node of the settings file, so the page can only reach the entries of
//! the node it talks to. Values are exactly 32 bytes (an AES-256 key). Only the main window's bundled client can call
//! the commands (capabilities/main.json); remote pages and embed frames cannot.
//!
//! `TAVRN_DESKTOP_KEYCHAIN=memory` keeps the entries in memory for this process only (the WebDriver smoke test under
//! xvfb, where no Secret Service runs); `=unavailable` behaves like a session without one (the fallback). Neither
//! weakens anything: the keys are then not persisted at all.

use std::sync::{Arc, Mutex};

use keyring_core::{CredentialStore, Error};
use serde::Serialize;
use tauri::State;
use zeroize::Zeroizing;

use crate::commands::Settings;
pub use crate::node_url::{MAX_ACCOUNT, valid_account};

/// Service name of every entry: the app's identifier.
pub const SERVICE: &str = "org.tavrn.desktop";

/// Length of a stored secret: the AES-256 local storage key.
pub const SECRET_LEN: usize = 32;

/// Environment switch of the backend (see the module documentation).
pub const BACKEND_ENV: &str = "TAVRN_DESKTOP_KEYCHAIN";

/// Error codes the client sees (`keychain.*`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeychainError {
    /// No keychain service, or it refused access (locked, no Secret Service on a bare session).
    Unavailable,
    /// An account address or a secret the shell does not accept.
    Invalid,
    /// No home node chosen yet.
    NoNode,
    /// The stored value is not a key of this app.
    Corrupt,
}

impl KeychainError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unavailable => "keychain.unavailable",
            Self::Invalid => "keychain.invalid",
            Self::NoNode => "keychain.no_node",
            Self::Corrupt => "keychain.corrupt",
        }
    }
}

impl From<Error> for KeychainError {
    fn from(e: Error) -> Self {
        match e {
            Error::BadDataFormat(..) | Error::BadEncoding(_) | Error::Ambiguous(_) => Self::Corrupt,
            Error::Invalid(..) | Error::TooLong(..) => Self::Invalid,
            other => {
                // A locked keyring, no Secret Service on D-Bus, a denied access: the client only learns "unavailable".
                // The store's message names no secret (at most the entry's account).
                eprintln!("tavrn: the keychain is unavailable: {other}");
                Self::Unavailable
            }
        }
    }
}

/// The entry's user name: scoped by the home node's origin and the account.
pub fn entry_user(node: &str, account: &str) -> Result<String, KeychainError> {
    if !valid_account(account) {
        return Err(KeychainError::Invalid);
    }
    let node = crate::node_url::validate(node).map_err(|_| KeychainError::NoNode)?;
    Ok(format!("local-key/{node}/{}", account.to_ascii_lowercase()))
}

/// Which keychain holds the entries, as Settings → App names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Backend {
    SecretService,
    CredentialManager,
    Keychain,
    Memory,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Status {
    pub backend: Backend,
    /// The keychain answered a lookup just now.
    pub available: bool,
}

/// The credential store of this installation (or none: every call then fails with `keychain.unavailable`).
pub struct Keychain {
    store: Option<Arc<CredentialStore>>,
    backend: Backend,
    /// One call at a time: the platform stores do not promise safe concurrent access to one credential.
    serial: Mutex<()>,
}

impl Keychain {
    /// The OS keychain, or the backend `TAVRN_DESKTOP_KEYCHAIN` asks for.
    pub fn from_env() -> Self {
        Self::for_setting(std::env::var(BACKEND_ENV).ok().as_deref())
    }

    /// `memory`, `unavailable`, anything else: the OS keychain.
    pub fn for_setting(setting: Option<&str>) -> Self {
        match setting {
            Some("memory") => Self::memory(),
            Some("unavailable") => Self::unavailable(),
            _ => Self::os(),
        }
    }

    fn with(store: Option<Arc<CredentialStore>>, backend: Backend) -> Self {
        Self { store, backend, serial: Mutex::new(()) }
    }

    /// The platform's keychain; a platform without one (or a failed start) yields an unavailable keychain.
    pub fn os() -> Self {
        match os_store() {
            Ok((store, backend)) => Self::with(Some(store), backend),
            Err(e) => {
                eprintln!("tavrn: no OS keychain: {e}");
                Self::unavailable()
            }
        }
    }

    /// Entries in this process's memory only (tests, the smoke test).
    pub fn memory() -> Self {
        match keyring_core::mock::Store::new() {
            Ok(store) => Self::with(Some(store), Backend::Memory),
            Err(_) => Self::unavailable(),
        }
    }

    pub fn unavailable() -> Self {
        Self::with(None, Backend::None)
    }

    pub fn backend(&self) -> Backend {
        self.backend
    }

    fn entry(&self, user: &str) -> Result<keyring_core::Entry, KeychainError> {
        let store = self.store.as_ref().ok_or(KeychainError::Unavailable)?;
        Ok(store.build(SERVICE, user, None)?)
    }

    fn serial(&self) -> std::sync::MutexGuard<'_, ()> {
        self.serial.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The secret of `user`, or none (wiped when dropped, also after it went to the client).
    pub fn get(&self, user: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeychainError> {
        let _serial = self.serial();
        match self.entry(user)?.get_secret().map(Zeroizing::new) {
            Ok(secret) if secret.len() == SECRET_LEN => Ok(Some(secret)),
            Ok(_) => Err(KeychainError::Corrupt),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Stores (or replaces) the secret of `user`.
    pub fn set(&self, user: &str, secret: &[u8]) -> Result<(), KeychainError> {
        if secret.len() != SECRET_LEN {
            return Err(KeychainError::Invalid);
        }
        let _serial = self.serial();
        Ok(self.entry(user)?.set_secret(secret)?)
    }

    /// Removes the entry of `user`; a missing entry is fine.
    pub fn delete(&self, user: &str) -> Result<(), KeychainError> {
        let _serial = self.serial();
        match self.entry(user)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// Which keychain, and does it answer (a lookup of an entry that never exists)?
    pub fn status(&self) -> Status {
        let available = self.store.is_some() && self.get("probe").is_ok();
        Status { backend: self.backend, available }
    }
}

#[cfg(target_os = "linux")]
fn os_store() -> Result<(Arc<CredentialStore>, Backend), Error> {
    Ok((zbus_secret_service_keyring_store::Store::new()?, Backend::SecretService))
}

#[cfg(windows)]
fn os_store() -> Result<(Arc<CredentialStore>, Backend), Error> {
    Ok((windows_native_keyring_store::Store::new()?, Backend::CredentialManager))
}

#[cfg(target_os = "macos")]
fn os_store() -> Result<(Arc<CredentialStore>, Backend), Error> {
    Ok((apple_native_keyring_store::keychain::Store::new()?, Backend::Keychain))
}

#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
fn os_store() -> Result<(Arc<CredentialStore>, Backend), Error> {
    Err(Error::NotSupportedByStore("no keychain on this platform".into()))
}

// ---- commands (the client: web/src/platform/tauriShell.ts) ----

fn user_for(settings: &Settings, account: &str) -> Result<String, String> {
    let node = settings.config.lock().map_err(|_| "config.unavailable".to_string())?.node.clone();
    entry_user(node.as_deref().ok_or(KeychainError::NoNode.code())?, account).map_err(|e| e.code().to_string())
}

/// Keychain calls may block (D-Bus, an unlock prompt of the keyring): never on the main thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, KeychainError> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|_| KeychainError::Unavailable.code().to_string())?.map_err(|e| e.code().to_string())
}

/// The local storage key of `account` on the home node, or null.
#[tauri::command]
pub async fn keychain_get(settings: State<'_, Settings>, keychain: State<'_, Arc<Keychain>>, account: String) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    let user = user_for(&settings, &account)?;
    let keychain = Arc::clone(&keychain);
    blocking(move || keychain.get(&user)).await
}

/// Stores the local storage key of `account` on the home node (exactly 32 bytes).
#[tauri::command]
pub async fn keychain_set(
    settings: State<'_, Settings>,
    keychain: State<'_, Arc<Keychain>>,
    account: String,
    secret: Zeroizing<Vec<u8>>,
) -> Result<(), String> {
    let user = user_for(&settings, &account)?;
    let keychain = Arc::clone(&keychain);
    blocking(move || keychain.set(&user, &secret)).await
}

/// Removes the entry of `account` on the home node (sign-out, lock on close, identity reset).
#[tauri::command]
pub async fn keychain_delete(settings: State<'_, Settings>, keychain: State<'_, Arc<Keychain>>, account: String) -> Result<(), String> {
    let user = user_for(&settings, &account)?;
    let keychain = Arc::clone(&keychain);
    blocking(move || keychain.delete(&user)).await
}

/// Which keychain the app uses and whether it answers (Settings → App).
#[tauri::command]
pub async fn keychain_status(keychain: State<'_, Arc<Keychain>>) -> Result<Status, String> {
    let keychain = Arc::clone(&keychain);
    blocking(move || Ok(keychain.status())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; SECRET_LEN] = [7; SECRET_LEN];

    #[test]
    fn entries_are_scoped_by_node_and_account() {
        assert_eq!(entry_user("https://tavrn.example", "alice@tavrn.example"), Ok("local-key/https://tavrn.example/alice@tavrn.example".into()));
        assert_eq!(entry_user("https://Tavrn.Example/", "Alice@Tavrn.Example"), Ok("local-key/https://tavrn.example/alice@tavrn.example".into()), "normalized");
        assert_eq!(entry_user("http://127.0.0.1:8080", "bob@localhost"), Ok("local-key/http://127.0.0.1:8080/bob@localhost".into()));
        assert_ne!(entry_user("https://a.example", "x@a.example"), entry_user("https://b.example", "x@a.example"), "another node, another entry");
    }

    #[test]
    fn odd_accounts_and_nodes_are_refused() {
        for bad in [
            "",
            "alice",
            "@tavrn.example",
            "alice@",
            "a/b@tavrn.example",
            "alice@tavrn.example/x",
            "alice@x:",
            "alice@x:123456",
            "alice@.x",
            "a lice@x",
            "alice@x@y",
            "ä@x",
        ] {
            assert_eq!(entry_user("https://tavrn.example", bad), Err(KeychainError::Invalid), "{bad:?}");
        }
        assert_eq!(entry_user("https://tavrn.example", &format!("{}@x", "a".repeat(MAX_ACCOUNT))), Err(KeychainError::Invalid));
        assert!(valid_account("bob@localhost:8080"));
        assert_eq!(entry_user("http://evil.example", "alice@tavrn.example"), Err(KeychainError::NoNode));
        assert_eq!(entry_user("", "alice@tavrn.example"), Err(KeychainError::NoNode));
    }

    #[test]
    fn the_memory_keychain_stores_reads_and_deletes() {
        let k = Keychain::memory();
        let user = "local-key/https://tavrn.example/alice@tavrn.example";
        assert_eq!(k.get(user), Ok(None));
        assert_eq!(k.set(user, &KEY), Ok(()));
        assert_eq!(k.get(user), Ok(Some(Zeroizing::new(KEY.to_vec()))));
        assert_eq!(k.get("local-key/https://tavrn.example/bob@tavrn.example"), Ok(None), "entries do not leak between accounts");
        assert_eq!(k.set(user, &[9; SECRET_LEN]), Ok(()));
        assert_eq!(k.get(user), Ok(Some(Zeroizing::new(vec![9; SECRET_LEN]))), "replaced");
        assert_eq!(k.delete(user), Ok(()));
        assert_eq!(k.get(user), Ok(None));
        assert_eq!(k.delete(user), Ok(()), "deleting twice is fine");
        assert_eq!(k.status(), Status { backend: Backend::Memory, available: true });
    }

    #[test]
    fn only_32_byte_keys_are_stored() {
        let k = Keychain::memory();
        assert_eq!(k.set("u", &[1; 31]), Err(KeychainError::Invalid));
        assert_eq!(k.set("u", &[1; 33]), Err(KeychainError::Invalid));
        assert_eq!(k.set("u", &[]), Err(KeychainError::Invalid));
        assert_eq!(k.get("u"), Ok(None));
    }

    #[test]
    fn a_foreign_value_is_reported_as_corrupt() -> Result<(), Error> {
        let k = Keychain::memory();
        k.entry("u").map_err(|_| Error::NoDefaultStore)?.set_secret(b"not a key")?;
        assert_eq!(k.get("u"), Err(KeychainError::Corrupt));
        Ok(())
    }

    #[test]
    fn without_a_keychain_every_call_fails_as_unavailable() {
        let k = Keychain::unavailable();
        assert_eq!(k.get("u"), Err(KeychainError::Unavailable));
        assert_eq!(k.set("u", &KEY), Err(KeychainError::Unavailable));
        assert_eq!(k.delete("u"), Err(KeychainError::Unavailable));
        assert_eq!(k.status(), Status { backend: Backend::None, available: false });
    }

    #[test]
    fn platform_failures_map_to_unavailable() {
        assert_eq!(KeychainError::from(Error::NoStorageAccess("locked".into())), KeychainError::Unavailable);
        assert_eq!(KeychainError::from(Error::PlatformFailure("no secret service".into())), KeychainError::Unavailable);
        assert_eq!(KeychainError::from(Error::NoDefaultStore), KeychainError::Unavailable);
        assert_eq!(KeychainError::from(Error::TooLong("user".into(), 10)), KeychainError::Invalid);
        assert_eq!(KeychainError::Unavailable.code(), "keychain.unavailable");
    }

    /// The real keychain of this machine: desktop.yml runs it with gnome-keyring in a D-Bus session
    /// (`cargo test -- --ignored os_keychain`).
    #[test]
    #[ignore = "needs an unlocked keychain (desktop.yml starts gnome-keyring)"]
    fn os_keychain_round_trip() {
        let k = Keychain::os();
        assert_ne!(k.backend(), Backend::None, "no keychain could be opened");
        assert!(k.status().available, "the keychain does not answer");
        let user = format!("local-key/https://tavrn.example/test-{}@tavrn.example", std::process::id());
        assert_eq!(k.get(&user), Ok(None));
        assert_eq!(k.set(&user, &KEY), Ok(()));
        assert_eq!(k.get(&user), Ok(Some(Zeroizing::new(KEY.to_vec()))));
        assert_eq!(k.delete(&user), Ok(()));
        assert_eq!(k.get(&user), Ok(None));
    }

    #[test]
    fn the_setting_selects_the_test_backends() {
        assert_eq!(Keychain::for_setting(Some("memory")).backend(), Backend::Memory);
        assert_eq!(Keychain::for_setting(Some("unavailable")).backend(), Backend::None);
    }
}
