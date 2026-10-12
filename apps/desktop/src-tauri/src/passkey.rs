// SPDX-License-Identifier: Apache-2.0
//! Passkeys of the Windows app (docs/DESKTOP.md "Passkeys"). The webview's origin (`https://tauri.localhost`) can never
//! be under the node's relying party id, so the browser's WebAuthn cannot run in the app. The shell runs the ceremony
//! natively through the Windows WebAuthn API (webauthn.dll, Windows 10 1903 and newer) instead and, like a browser,
//! writes `clientDataJSON` itself: with the **web origin of the node the app is connected to** (its settings, never an
//! origin from the page) and only for a relying party id that this origin's host is equal to or a subdomain of
//! (PROTOCOL.md §5a.4). The node verifies the result as it verifies a browser's, so it needs no setting for the app.
//!
//! The client (`web/src/platform/tauriPasskeys.ts`) passes the node's options (`{ publicKey }` with base64url values)
//! and gets the credential back as `PublicKeyCredential.toJSON()`; the PRF output (the hmac-secret of the
//! authenticator, for the key store) travels apart and never inside the credential the client sends to the node.
//!
//! Everything here except the calls into webauthn.dll is platform independent and tested on every platform: parsing
//! the options, the relying party check, `clientDataJSON` and the JSON of the results. Other platforms answer
//! `passkey.unavailable` (Linux has no native path yet; macOS has no Tauri build).

use base64::Engine as _;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Runtime, State};

use crate::commands::Settings;

/// The user cancelled, the prompt timed out, or no authenticator holds a matching passkey (a browser's `NotAllowedError`).
pub const CANCELLED: &str = "passkey.cancelled";
/// The authenticator already holds a passkey of the excluded ones (`InvalidStateError`).
pub const EXISTS: &str = "passkey.exists";
/// The relying party id does not belong to the node's origin, or the app has no node yet (`SecurityError`).
pub const REFUSED: &str = "passkey.refused";
/// No native WebAuthn on this system (`NotSupportedError`).
pub const UNAVAILABLE: &str = "passkey.unavailable";
/// Anything else, including options the shell refuses to pass on.
pub const FAILED: &str = "passkey.failed";

/// Bounds of what the shell passes to the operating system.
const MAX_ID_BYTES: usize = 1023;
const MAX_LIST: usize = 64;
const MAX_TEXT: usize = 256;
const MAX_PRF_INPUT: usize = 256;
const DEFAULT_TIMEOUT_MS: u32 = 120_000;
const MIN_TIMEOUT_MS: u32 = 30_000;
const MAX_TIMEOUT_MS: u32 = 600_000;

/// Transports of `webauthn.h` (`WEBAUTHN_CTAP_TRANSPORT_*`), with the names of the WebAuthn JSON.
pub const TRANSPORTS: [(&str, u32); 5] = [("usb", 1), ("nfc", 2), ("ble", 4), ("internal", 0x10), ("hybrid", 0x20)];
/// `WEBAUTHN_CTAP_TRANSPORT_INTERNAL`: the platform authenticator (Windows Hello).
const TRANSPORT_INTERNAL: u32 = 0x10;

fn b64() -> GeneralPurpose {
    GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        GeneralPurposeConfig::new().with_encode_padding(false).with_decode_padding_mode(DecodePaddingMode::Indifferent),
    )
}

/// RFC 4648 §5 base64url without padding.
pub fn b64url(bytes: &[u8]) -> String {
    b64().encode(bytes)
}

/// Bytes given as base64url (with or without padding).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bytes(pub Vec<u8>);

impl<'de> Deserialize<'de> for Bytes {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        b64().decode(text.as_bytes()).map(Bytes).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelyingParty {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: Bytes,
    pub name: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CredentialParameter {
    #[serde(rename = "type")]
    pub kind: String,
    pub alg: i32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Descriptor {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: Bytes,
    #[serde(default)]
    pub transports: Vec<String>,
}

impl Descriptor {
    /// The transports as `WEBAUTHN_CTAP_TRANSPORT_*` bits (unknown names are left out).
    pub fn transport_bits(&self) -> u32 {
        self.transports.iter().filter_map(|t| TRANSPORTS.iter().find(|(name, _)| name == t).map(|(_, bit)| bit)).fold(0, |a, b| a | b)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub authenticator_attachment: Option<String>,
    pub resident_key: Option<String>,
    #[serde(default)]
    pub require_resident_key: bool,
    pub user_verification: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PrfValues {
    pub first: Bytes,
    pub second: Option<Bytes>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PrfInputs {
    pub eval: Option<PrfValues>,
}

/// The extensions the shell knows; the others are ignored, as a browser ignores unknown ones.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Extensions {
    pub prf: Option<PrfInputs>,
}

/// `PublicKeyCredentialCreationOptions` (JSON form).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreationOptions {
    pub rp: RelyingParty,
    pub user: User,
    pub challenge: Bytes,
    pub pub_key_cred_params: Vec<CredentialParameter>,
    pub timeout: Option<u32>,
    #[serde(default)]
    pub exclude_credentials: Vec<Descriptor>,
    #[serde(default)]
    pub authenticator_selection: Selection,
    #[serde(default)]
    pub extensions: Extensions,
}

/// `PublicKeyCredentialRequestOptions` (JSON form).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestOptions {
    pub challenge: Bytes,
    pub timeout: Option<u32>,
    pub rp_id: Option<String>,
    #[serde(default)]
    pub allow_credentials: Vec<Descriptor>,
    pub user_verification: Option<String>,
    #[serde(default)]
    pub extensions: Extensions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Wrapped<T> {
    public_key: T,
}

fn too_long(s: &str) -> bool {
    s.chars().count() > MAX_TEXT
}

fn ids_ok(list: &[Descriptor]) -> bool {
    list.len() <= MAX_LIST && list.iter().all(|d| d.kind == "public-key" && !d.id.0.is_empty() && d.id.0.len() <= MAX_ID_BYTES)
}

fn prf_ok(ext: &Extensions) -> bool {
    ext.prf
        .as_ref()
        .and_then(|p| p.eval.as_ref())
        .is_none_or(|e| e.first.0.len() <= MAX_PRF_INPUT && e.second.as_ref().is_none_or(|s| s.0.len() <= MAX_PRF_INPUT))
}

/// The node's `{ publicKey }` of a registration, checked against the shell's bounds.
pub fn parse_creation(options: &Value) -> Result<CreationOptions, &'static str> {
    let o = serde_json::from_value::<Wrapped<CreationOptions>>(options.clone()).map_err(|_| FAILED)?.public_key;
    let challenge_ok = (16..=64).contains(&o.challenge.0.len());
    let user_ok = !o.user.id.0.is_empty() && o.user.id.0.len() <= 64 && !too_long(&o.user.name) && !too_long(&o.user.display_name);
    let params_ok = !o.pub_key_cred_params.is_empty() && o.pub_key_cred_params.len() <= 16 && o.pub_key_cred_params.iter().all(|p| p.kind == "public-key");
    let ok = challenge_ok && user_ok && params_ok && !too_long(&o.rp.id) && !too_long(&o.rp.name) && ids_ok(&o.exclude_credentials) && prf_ok(&o.extensions);
    if ok { Ok(o) } else { Err(FAILED) }
}

/// The `{ publicKey }` of an assertion (the node's, or the client's own for the PRF), checked against the bounds.
pub fn parse_request(options: &Value) -> Result<RequestOptions, &'static str> {
    let o = serde_json::from_value::<Wrapped<RequestOptions>>(options.clone()).map_err(|_| FAILED)?.public_key;
    let ok =
        (16..=64).contains(&o.challenge.0.len()) && o.rp_id.as_deref().is_none_or(|r| !too_long(r)) && ids_ok(&o.allow_credentials) && prf_ok(&o.extensions);
    if ok { Ok(o) } else { Err(FAILED) }
}

/// The web origin the ceremony runs for: the node's web client from the settings (its document's `web`), else the
/// node itself, as the sign-in window uses (`commands::open_connect`).
pub fn origin_of(config: &crate::config::Config) -> Option<String> {
    config.web.clone().or_else(|| config.node.clone())
}

/// WebAuthn's rule as a browser applies it: the relying party id must be the origin's host or a registrable parent
/// domain of it (a single label only for `localhost`, the development node); https, plain http only on this computer.
pub fn check_relying_party(rp_id: &str, origin: &str) -> Result<(), &'static str> {
    let url = tauri::Url::parse(origin).map_err(|_| REFUSED)?;
    let host = url.host_str().ok_or(REFUSED)?.to_ascii_lowercase();
    let secure = url.scheme() == "https" || (url.scheme() == "http" && matches!(host.as_str(), "localhost" | "127.0.0.1"));
    let rp = rp_id.to_ascii_lowercase();
    let registrable = rp.contains('.') || rp == "localhost";
    let covers = host == rp || host.ends_with(&format!(".{rp}"));
    if secure && registrable && covers && !rp.is_empty() && rp == rp_id { Ok(()) } else { Err(REFUSED) }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ceremony {
    Create,
    Get,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientData<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    challenge: String,
    origin: &'a str,
    cross_origin: bool,
}

/// `clientDataJSON` as a browser writes it (WebAuthn §5.8.1: type, challenge, origin, crossOrigin).
pub fn client_data(ceremony: Ceremony, challenge: &[u8], origin: &str) -> String {
    let kind = match ceremony {
        Ceremony::Create => "webauthn.create",
        Ceremony::Get => "webauthn.get",
    };
    serde_json::to_string(&ClientData { kind, challenge: b64url(challenge), origin, cross_origin: false }).unwrap_or_default()
}

/// The timeout the shell grants the authenticator (the node asks for minutes; the user may need to find a key).
pub fn timeout_ms(requested: Option<u32>) -> u32 {
    requested.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

/// `userVerification` as `WEBAUTHN_USER_VERIFICATION_REQUIREMENT_*`.
pub fn user_verification(value: Option<&str>) -> u32 {
    match value {
        Some("required") => 1,
        Some("preferred") => 2,
        Some("discouraged") => 3,
        _ => 0,
    }
}

/// `authenticatorAttachment` as `WEBAUTHN_AUTHENTICATOR_ATTACHMENT_*`.
pub fn attachment(value: Option<&str>) -> u32 {
    match value {
        Some("platform") => 1,
        Some("cross-platform") => 2,
        _ => 0,
    }
}

/// `(require, prefer)` a discoverable credential, from `residentKey` (or the older `requireResidentKey`).
pub fn resident_key(selection: &Selection) -> (bool, bool) {
    match selection.resident_key.as_deref() {
        Some("required") => (true, false),
        Some("preferred") => (false, true),
        Some(_) => (false, false),
        None => (selection.require_resident_key, false),
    }
}

/// Transport bits as the names of the WebAuthn JSON.
pub fn transport_names(bits: u32) -> Vec<&'static str> {
    TRANSPORTS.iter().filter(|(_, bit)| bits & bit != 0).map(|(name, _)| *name).collect()
}

/// Where the authenticator sits: Windows Hello (`internal`) is the platform, everything else roams.
fn attachment_name(transport: u32) -> Option<&'static str> {
    match transport {
        0 => None,
        t if t & TRANSPORT_INTERNAL != 0 => Some("platform"),
        _ => Some("cross-platform"),
    }
}

/// What webauthn.dll returned for a registration.
#[derive(Debug, Clone, Default)]
pub struct RawRegistration {
    pub credential_id: Vec<u8>,
    pub attestation_object: Vec<u8>,
    /// `dwUsedTransport` (0 when the system does not say).
    pub transport: u32,
    /// The authenticator enabled the PRF (hmac-secret); None when the system does not say.
    pub prf_enabled: Option<bool>,
    /// The credential is discoverable; None when the system does not say.
    pub resident_key: Option<bool>,
}

/// What webauthn.dll returned for an assertion.
#[derive(Debug, Clone, Default)]
pub struct RawAssertion {
    pub credential_id: Vec<u8>,
    pub authenticator_data: Vec<u8>,
    pub signature: Vec<u8>,
    pub user_handle: Vec<u8>,
    pub transport: u32,
    /// The PRF output (`prf.results.first`) when the PRF was asked for and the authenticator gave one.
    pub prf_first: Option<Vec<u8>>,
}

/// The answer to the client: the credential for the node and the PRF output apart (base64url, local use only).
#[derive(Debug, Clone, Serialize)]
pub struct NativeResult {
    pub credential: Value,
    pub prf: Option<String>,
}

/// A registration as `PublicKeyCredential.toJSON()` (`RegistrationResponseJSON`).
pub fn registration_json(raw: &RawRegistration, client_data_json: &str) -> NativeResult {
    let mut ext = serde_json::Map::new();
    if let Some(enabled) = raw.prf_enabled {
        ext.insert("prf".into(), json!({ "enabled": enabled }));
    }
    if let Some(rk) = raw.resident_key {
        ext.insert("credProps".into(), json!({ "rk": rk }));
    }
    let id = b64url(&raw.credential_id);
    let credential = json!({
        "id": id,
        "rawId": id,
        "type": "public-key",
        "authenticatorAttachment": attachment_name(raw.transport),
        "response": {
            "clientDataJSON": b64url(client_data_json.as_bytes()),
            "attestationObject": b64url(&raw.attestation_object),
            "transports": transport_names(raw.transport),
        },
        "clientExtensionResults": Value::Object(ext),
    });
    NativeResult { credential, prf: None }
}

/// An assertion as `PublicKeyCredential.toJSON()` (`AuthenticationResponseJSON`); the PRF output only apart.
pub fn assertion_json(raw: &RawAssertion, client_data_json: &str) -> NativeResult {
    let id = b64url(&raw.credential_id);
    let user_handle = (!raw.user_handle.is_empty()).then(|| b64url(&raw.user_handle));
    let credential = json!({
        "id": id,
        "rawId": id,
        "type": "public-key",
        "authenticatorAttachment": attachment_name(raw.transport),
        "response": {
            "clientDataJSON": b64url(client_data_json.as_bytes()),
            "authenticatorData": b64url(&raw.authenticator_data),
            "signature": b64url(&raw.signature),
            "userHandle": user_handle,
        },
        "clientExtensionResults": {},
    });
    let prf = raw.prf_first.as_deref().filter(|p| p.len() == 32).map(b64url);
    NativeResult { credential, prf }
}

/// An `HRESULT` of webauthn.dll as the client's code (the DOMException mapping of `WebAuthNGetW3CExceptionDOMError`).
pub fn error_code(hresult: u32) -> &'static str {
    match hresult {
        // NTE_USER_CANCELLED, HRESULT_FROM_WIN32(ERROR_CANCELLED), HRESULT_FROM_WIN32(ERROR_TIMEOUT), NTE_NOT_FOUND,
        // NTE_DEVICE_NOT_FOUND: NotAllowedError.
        0x8009_0036 | 0x8007_04C7 | 0x8007_05B4 | 0x8009_0011 | 0x8009_0035 => CANCELLED,
        // NTE_EXISTS: InvalidStateError.
        0x8009_000F => EXISTS,
        // NTE_NOT_SUPPORTED, HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED): ConstraintError, nothing the user can fix here.
        0x8009_0029 | 0x8007_0032 => UNAVAILABLE,
        _ => FAILED,
    }
}

/// The ceremony's origin and the checked relying party id.
fn origin_for(settings: &Settings, rp_id: &str) -> Result<String, String> {
    let origin = settings.config.lock().ok().and_then(|c| origin_of(&c)).ok_or_else(|| REFUSED.to_string())?;
    check_relying_party(rp_id, &origin)?;
    Ok(origin)
}

/// The relying party id of an assertion: the options' `rpId`, else the origin's host (the browser's default).
fn request_rp_id(options: &RequestOptions, settings: &Settings) -> Result<String, String> {
    if let Some(rp) = options.rp_id.clone() {
        return Ok(rp);
    }
    let origin = settings.config.lock().ok().and_then(|c| origin_of(&c)).ok_or_else(|| REFUSED.to_string())?;
    tauri::Url::parse(&origin).ok().and_then(|u| u.host_str().map(str::to_string)).ok_or_else(|| REFUSED.to_string())
}

/// The native window the system's passkey dialog belongs to.
#[cfg(windows)]
fn main_window<R: Runtime>(app: &AppHandle<R>) -> Result<isize, String> {
    use tauri::Manager as _;
    let window = app.get_webview_window(crate::MAIN_WINDOW).ok_or_else(|| FAILED.to_string())?;
    window.hwnd().map(|h| h.0 as isize).map_err(|_| FAILED.to_string())
}

/// Whether the shell can run passkeys natively (`app_info.passkeys`): Windows with webauthn.dll.
pub fn available() -> bool {
    #[cfg(windows)]
    {
        win::api_version().is_some()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Registration (Settings → Security, registration): `options` is the node's `{ publicKey }`.
#[tauri::command]
pub async fn passkey_create<R: Runtime>(app: AppHandle<R>, settings: State<'_, Settings>, options: Value) -> Result<NativeResult, String> {
    let options = parse_creation(&options)?;
    let origin = origin_for(&settings, &options.rp.id)?;
    let client_data = client_data(Ceremony::Create, &options.challenge.0, &origin);
    #[cfg(windows)]
    {
        let hwnd = main_window(&app)?;
        let data = client_data.clone();
        let raw = tauri::async_runtime::spawn_blocking(move || win::make_credential(hwnd, &options, &data)).await.map_err(|_| FAILED.to_string())??;
        Ok(registration_json(&raw, &client_data))
    }
    #[cfg(not(windows))]
    {
        let _ = (app, client_data);
        Err(UNAVAILABLE.into())
    }
}

/// Assertion (sign-in, second factor, re-authentication, the PRF unlock): the node's `{ publicKey }` or the client's
/// own one for the PRF.
#[tauri::command]
pub async fn passkey_get<R: Runtime>(app: AppHandle<R>, settings: State<'_, Settings>, options: Value) -> Result<NativeResult, String> {
    let options = parse_request(&options)?;
    let rp_id = request_rp_id(&options, &settings)?;
    let origin = origin_for(&settings, &rp_id)?;
    let client_data = client_data(Ceremony::Get, &options.challenge.0, &origin);
    #[cfg(windows)]
    {
        let hwnd = main_window(&app)?;
        let data = client_data.clone();
        let raw = tauri::async_runtime::spawn_blocking(move || win::get_assertion(hwnd, &rp_id, &options, &data)).await.map_err(|_| FAILED.to_string())??;
        Ok(assertion_json(&raw, &client_data))
    }
    #[cfg(not(windows))]
    {
        let _ = (app, client_data);
        Err(UNAVAILABLE.into())
    }
}

/// The calls into webauthn.dll. The library is loaded at the first use (`LoadLibraryExW` from System32 only), so the
/// app also starts on a Windows without it (before 10 1903) and offers the node's page there instead.
#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    use windows::Win32::Foundation::{HMODULE, HWND};
    use windows::Win32::Networking::WindowsWebServices::*;
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW};
    use windows::core::{BOOL, HRESULT, HSTRING, PCSTR, PCWSTR, s, w};

    use super::{
        CreationOptions, FAILED, RawAssertion, RawRegistration, RequestOptions, UNAVAILABLE, attachment, error_code, resident_key, timeout_ms,
        user_verification,
    };

    // The constants of webauthn.h that the platform-independent code uses as plain numbers.
    const _: () = assert!(WEBAUTHN_CTAP_TRANSPORT_USB == 1 && WEBAUTHN_CTAP_TRANSPORT_NFC == 2 && WEBAUTHN_CTAP_TRANSPORT_BLE == 4);
    const _: () = assert!(WEBAUTHN_CTAP_TRANSPORT_INTERNAL == 0x10 && WEBAUTHN_CTAP_TRANSPORT_HYBRID == 0x20);
    const _: () = assert!(WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED == 1 && WEBAUTHN_USER_VERIFICATION_REQUIREMENT_PREFERRED == 2);
    const _: () = assert!(WEBAUTHN_USER_VERIFICATION_REQUIREMENT_DISCOURAGED == 3 && WEBAUTHN_USER_VERIFICATION_REQUIREMENT_ANY == 0);
    const _: () = assert!(WEBAUTHN_AUTHENTICATOR_ATTACHMENT_PLATFORM == 1 && WEBAUTHN_AUTHENTICATOR_ATTACHMENT_CROSS_PLATFORM == 2);

    /// What `GetProcAddress` returns: an export without its signature.
    type Proc = unsafe extern "system" fn() -> isize;
    type GetApiVersionNumber = unsafe extern "system" fn() -> u32;
    type MakeCredential = unsafe extern "system" fn(
        HWND,
        *const WEBAUTHN_RP_ENTITY_INFORMATION,
        *const WEBAUTHN_USER_ENTITY_INFORMATION,
        *const WEBAUTHN_COSE_CREDENTIAL_PARAMETERS,
        *const WEBAUTHN_CLIENT_DATA,
        *const WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS,
        *mut *mut WEBAUTHN_CREDENTIAL_ATTESTATION,
    ) -> HRESULT;
    type GetAssertion = unsafe extern "system" fn(
        HWND,
        PCWSTR,
        *const WEBAUTHN_CLIENT_DATA,
        *const WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS,
        *mut *mut WEBAUTHN_ASSERTION,
    ) -> HRESULT;
    type FreeCredentialAttestation = unsafe extern "system" fn(*const WEBAUTHN_CREDENTIAL_ATTESTATION);
    type FreeAssertion = unsafe extern "system" fn(*const WEBAUTHN_ASSERTION);

    struct Api {
        version: u32,
        make_credential: MakeCredential,
        get_assertion: GetAssertion,
        free_attestation: FreeCredentialAttestation,
        free_assertion: FreeAssertion,
    }

    // The function pointers of a library that stays loaded for the app's lifetime.
    unsafe impl Send for Api {}
    unsafe impl Sync for Api {}

    fn load() -> Option<Api> {
        // SAFETY: loading a system library by name from System32 and looking up its documented exports; the
        // transmutes give each export the signature of webauthn.h.
        unsafe {
            let lib: HMODULE = LoadLibraryExW(w!("webauthn.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).ok()?;
            let get = |name: PCSTR| GetProcAddress(lib, name);
            let version: GetApiVersionNumber = std::mem::transmute::<Proc, GetApiVersionNumber>(get(s!("WebAuthNGetApiVersionNumber"))?);
            Some(Api {
                version: version(),
                make_credential: std::mem::transmute::<Proc, MakeCredential>(get(s!("WebAuthNAuthenticatorMakeCredential"))?),
                get_assertion: std::mem::transmute::<Proc, GetAssertion>(get(s!("WebAuthNAuthenticatorGetAssertion"))?),
                free_attestation: std::mem::transmute::<Proc, FreeCredentialAttestation>(get(s!("WebAuthNFreeCredentialAttestation"))?),
                free_assertion: std::mem::transmute::<Proc, FreeAssertion>(get(s!("WebAuthNFreeAssertion"))?),
            })
        }
    }

    fn api() -> Option<&'static Api> {
        static API: OnceLock<Option<Api>> = OnceLock::new();
        API.get_or_init(load).as_ref()
    }

    /// `WebAuthNGetApiVersionNumber()`, or None without webauthn.dll.
    pub fn api_version() -> Option<u32> {
        api().map(|a| a.version)
    }

    /// The structure versions this system reads (webauthn.h "WEBAUTHN_API_VERSION_*"), capped at the ones this build
    /// knows: `(make credential options, get assertion options)`.
    fn option_versions(api: u32) -> (u32, u32) {
        match api {
            0..=2 => (3, 4),
            3 => (4, 5),
            4 | 5 => (5, 6),
            6 => (6, 6),
            _ => (7, 7),
        }
    }

    fn copy(ptr: *const u8, len: u32) -> Vec<u8> {
        if ptr.is_null() || len == 0 {
            return Vec::new();
        }
        // SAFETY: webauthn.dll hands out `len` readable bytes at `ptr` until the result is freed.
        unsafe { std::slice::from_raw_parts(ptr, len as usize).to_vec() }
    }

    /// The credential list of `exclude`/`allow` (the vectors own the memory the pointers name).
    struct CredentialList {
        _ids: Vec<Vec<u8>>,
        _entries: Vec<WEBAUTHN_CREDENTIAL_EX>,
        pointers: Vec<*mut WEBAUTHN_CREDENTIAL_EX>,
        native: WEBAUTHN_CREDENTIAL_LIST,
    }

    fn credential_list(list: &[super::Descriptor]) -> Box<CredentialList> {
        let mut ids: Vec<Vec<u8>> = list.iter().map(|d| d.id.0.clone()).collect();
        let mut entries: Vec<WEBAUTHN_CREDENTIAL_EX> = ids
            .iter_mut()
            .zip(list)
            .map(|(id, d)| WEBAUTHN_CREDENTIAL_EX {
                dwVersion: WEBAUTHN_CREDENTIAL_EX_CURRENT_VERSION,
                cbId: id.len() as u32,
                pbId: id.as_mut_ptr(),
                pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
                dwTransports: d.transport_bits(),
            })
            .collect();
        let mut pointers: Vec<*mut WEBAUTHN_CREDENTIAL_EX> = entries.iter_mut().map(|e| e as *mut _).collect();
        let native = WEBAUTHN_CREDENTIAL_LIST { cCredentials: pointers.len() as u32, ppCredentials: pointers.as_mut_ptr() };
        Box::new(CredentialList { _ids: ids, _entries: entries, pointers, native })
    }

    fn client_data(json: &mut Vec<u8>) -> WEBAUTHN_CLIENT_DATA {
        WEBAUTHN_CLIENT_DATA {
            dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
            cbClientDataJSON: json.len() as u32,
            pbClientDataJSON: json.as_mut_ptr(),
            pwszHashAlgId: WEBAUTHN_HASH_ALGORITHM_SHA_256,
        }
    }

    pub fn make_credential(hwnd: isize, o: &CreationOptions, client_data_json: &str) -> Result<RawRegistration, String> {
        let api = api().ok_or_else(|| UNAVAILABLE.to_string())?;
        let (mc_version, _) = option_versions(api.version);
        let rp_id = HSTRING::from(o.rp.id.as_str());
        let rp_name = HSTRING::from(o.rp.name.as_str());
        let rp = WEBAUTHN_RP_ENTITY_INFORMATION {
            dwVersion: WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION,
            pwszId: PCWSTR(rp_id.as_ptr()),
            pwszName: PCWSTR(rp_name.as_ptr()),
            pwszIcon: PCWSTR::null(),
        };
        let mut user_id = o.user.id.0.clone();
        let user_name = HSTRING::from(o.user.name.as_str());
        let display_name = HSTRING::from(o.user.display_name.as_str());
        let user = WEBAUTHN_USER_ENTITY_INFORMATION {
            dwVersion: WEBAUTHN_USER_ENTITY_INFORMATION_CURRENT_VERSION,
            cbId: user_id.len() as u32,
            pbId: user_id.as_mut_ptr(),
            pwszName: PCWSTR(user_name.as_ptr()),
            pwszIcon: PCWSTR::null(),
            pwszDisplayName: PCWSTR(display_name.as_ptr()),
        };
        let mut params: Vec<WEBAUTHN_COSE_CREDENTIAL_PARAMETER> = o
            .pub_key_cred_params
            .iter()
            .map(|p| WEBAUTHN_COSE_CREDENTIAL_PARAMETER {
                dwVersion: WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION,
                pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
                lAlg: p.alg,
            })
            .collect();
        let cose = WEBAUTHN_COSE_CREDENTIAL_PARAMETERS { cCredentialParameters: params.len() as u32, pCredentialParameters: params.as_mut_ptr() };
        let mut json = client_data_json.as_bytes().to_vec();
        let data = client_data(&mut json);
        let mut exclude = credential_list(&o.exclude_credentials);
        // The PRF: `bEnablePrf` where the system has it (API 6), the hmac-secret extension before.
        let wants_prf = o.extensions.prf.is_some();
        let mut hmac_secret: BOOL = BOOL::from(true);
        let mut extension = WEBAUTHN_EXTENSION {
            pwszExtensionIdentifier: WEBAUTHN_EXTENSIONS_IDENTIFIER_HMAC_SECRET,
            cbExtension: std::mem::size_of::<BOOL>() as u32,
            pvExtension: &mut hmac_secret as *mut BOOL as *mut c_void,
        };
        let extensions =
            if wants_prf && mc_version < 6 { WEBAUTHN_EXTENSIONS { cExtensions: 1, pExtensions: &mut extension } } else { WEBAUTHN_EXTENSIONS::default() };
        let (require_rk, prefer_rk) = resident_key(&o.authenticator_selection);
        let options = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS {
            dwVersion: mc_version,
            dwTimeoutMilliseconds: timeout_ms(o.timeout),
            Extensions: extensions,
            dwAuthenticatorAttachment: attachment(o.authenticator_selection.authenticator_attachment.as_deref()),
            bRequireResidentKey: BOOL::from(require_rk),
            dwUserVerificationRequirement: user_verification(o.authenticator_selection.user_verification.as_deref()),
            dwAttestationConveyancePreference: WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE,
            pExcludeCredentialList: if o.exclude_credentials.is_empty() { std::ptr::null_mut() } else { &mut exclude.native },
            bPreferResidentKey: BOOL::from(prefer_rk),
            bEnablePrf: BOOL::from(wants_prf && mc_version >= 6),
            ..Default::default()
        };
        let mut result: *mut WEBAUTHN_CREDENTIAL_ATTESTATION = std::ptr::null_mut();
        // SAFETY: every pointer names memory owned by this frame that outlives the blocking call; the result is
        // copied and freed with the library's own function.
        let hr = unsafe { (api.make_credential)(HWND(hwnd as *mut c_void), &rp, &user, &cose, &data, &options, &mut result) };
        let _ = (&exclude.pointers, &params, &json, &user_id);
        if hr.is_err() {
            return Err(error_code(hr.0 as u32).to_string());
        }
        if result.is_null() {
            return Err(FAILED.into());
        }
        // SAFETY: a non-null result of a successful call, read within its version and freed once.
        unsafe {
            let a = &*result;
            let prf_enabled = if a.dwVersion >= 5 { Some(a.bPrfEnabled.as_bool()) } else { hmac_secret_output(&a.Extensions) };
            let raw = RawRegistration {
                credential_id: copy(a.pbCredentialId, a.cbCredentialId),
                attestation_object: copy(a.pbAttestationObject, a.cbAttestationObject),
                transport: if a.dwVersion >= 3 { a.dwUsedTransport } else { 0 },
                prf_enabled: if wants_prf { prf_enabled.or(Some(false)) } else { None },
                resident_key: (a.dwVersion >= 4).then(|| a.bResidentKey.as_bool()),
            };
            (api.free_attestation)(result);
            if raw.credential_id.is_empty() || raw.attestation_object.is_empty() { Err(FAILED.into()) } else { Ok(raw) }
        }
    }

    /// The hmac-secret extension's output of a registration (a BOOL), where the system reports it that way.
    unsafe fn hmac_secret_output(extensions: &WEBAUTHN_EXTENSIONS) -> Option<bool> {
        // SAFETY: `cExtensions` entries at `pExtensions`, each with its identifier and value, as webauthn.dll filled them.
        unsafe {
            if extensions.pExtensions.is_null() {
                return None;
            }
            let list = std::slice::from_raw_parts(extensions.pExtensions, extensions.cExtensions as usize);
            list.iter()
                .find(|e| !e.pwszExtensionIdentifier.is_null() && e.pwszExtensionIdentifier.to_string().is_ok_and(|id| id == "hmac-secret"))
                .filter(|e| !e.pvExtension.is_null() && e.cbExtension as usize >= std::mem::size_of::<BOOL>())
                .map(|e| (*(e.pvExtension as *const BOOL)).as_bool())
        }
    }

    pub fn get_assertion(hwnd: isize, rp_id: &str, o: &RequestOptions, client_data_json: &str) -> Result<RawAssertion, String> {
        let api = api().ok_or_else(|| UNAVAILABLE.to_string())?;
        let (_, ga_version) = option_versions(api.version);
        let rp = HSTRING::from(rp_id);
        let mut json = client_data_json.as_bytes().to_vec();
        let data = client_data(&mut json);
        let mut allow = credential_list(&o.allow_credentials);
        // The PRF input goes as is: without WEBAUTHN_AUTHENTICATOR_HMAC_SECRET_VALUES_FLAG, Windows derives the
        // hmac-secret salt as WebAuthn's PRF extension does (SHA-256("WebAuthn PRF" || 0x00 || input)), so the output
        // equals a browser's for the same passkey and input.
        let eval = o.extensions.prf.as_ref().and_then(|p| p.eval.as_ref()).filter(|_| ga_version >= 6);
        let mut first = eval.map(|e| e.first.0.clone()).unwrap_or_default();
        let mut second = eval.and_then(|e| e.second.as_ref()).map(|s| s.0.clone()).unwrap_or_default();
        let mut salt = WEBAUTHN_HMAC_SECRET_SALT {
            cbFirst: first.len() as u32,
            pbFirst: first.as_mut_ptr(),
            cbSecond: second.len() as u32,
            pbSecond: if second.is_empty() { std::ptr::null_mut() } else { second.as_mut_ptr() },
        };
        let mut salts =
            WEBAUTHN_HMAC_SECRET_SALT_VALUES { pGlobalHmacSalt: &mut salt, cCredWithHmacSecretSaltList: 0, pCredWithHmacSecretSaltList: std::ptr::null_mut() };
        let mut app_id_used = BOOL::from(false);
        let options = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS {
            dwVersion: ga_version,
            dwTimeoutMilliseconds: timeout_ms(o.timeout),
            dwUserVerificationRequirement: user_verification(o.user_verification.as_deref()),
            pbU2fAppId: &mut app_id_used,
            // No list: a discoverable passkey (the passkey-only sign-in).
            pAllowCredentialList: if o.allow_credentials.is_empty() { std::ptr::null_mut() } else { &mut allow.native },
            pHmacSecretSaltValues: if eval.is_some() { &mut salts } else { std::ptr::null_mut() },
            ..Default::default()
        };
        let mut result: *mut WEBAUTHN_ASSERTION = std::ptr::null_mut();
        // SAFETY: as in make_credential.
        let hr = unsafe { (api.get_assertion)(HWND(hwnd as *mut c_void), PCWSTR(rp.as_ptr()), &data, &options, &mut result) };
        let _ = (&allow.pointers, &json, &first, &second);
        if hr.is_err() {
            return Err(error_code(hr.0 as u32).to_string());
        }
        if result.is_null() {
            return Err(FAILED.into());
        }
        // SAFETY: as in make_credential.
        unsafe {
            let a = &*result;
            let prf_first = if a.dwVersion >= 3 && !a.pHmacSecret.is_null() {
                let s = &*a.pHmacSecret;
                Some(copy(s.pbFirst, s.cbFirst)).filter(|p| p.len() == 32)
            } else {
                None
            };
            let raw = RawAssertion {
                credential_id: copy(a.Credential.pbId, a.Credential.cbId),
                authenticator_data: copy(a.pbAuthenticatorData, a.cbAuthenticatorData),
                signature: copy(a.pbSignature, a.cbSignature),
                user_handle: copy(a.pbUserId, a.cbUserId),
                transport: if a.dwVersion >= 4 { a.dwUsedTransport } else { 0 },
                prf_first,
            };
            (api.free_assertion)(result);
            first.fill(0);
            if raw.credential_id.is_empty() || raw.signature.is_empty() { Err(FAILED.into()) } else { Ok(raw) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "https://app.tavrn.org";

    /// The node's registration options as webauthn-rs serialises them (with the PRF input tavrn-node adds).
    fn creation() -> Value {
        json!({ "publicKey": {
            "rp": { "name": "tavrn", "id": "tavrn.org" },
            "user": { "id": "AZKjm8Wq3P1Xn2l3m4n5oQ", "name": "alice", "displayName": "Alice" },
            "challenge": "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA",
            "pubKeyCredParams": [{ "type": "public-key", "alg": -7 }, { "type": "public-key", "alg": -257 }],
            "timeout": 300000,
            "excludeCredentials": [{ "type": "public-key", "id": "Y3JlZC0x", "transports": ["internal", "hybrid", "nfc-x"] }],
            "authenticatorSelection": { "residentKey": "preferred", "requireResidentKey": false, "userVerification": "required" },
            "attestation": "none",
            "extensions": { "credentialProtectionPolicy": "userVerificationRequired", "enforceCredentialProtectionPolicy": false, "uvm": true, "credProps": true, "prf": { "eval": { "first": "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc" } } }
        } })
    }

    fn request() -> Value {
        json!({ "publicKey": {
            "challenge": "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA",
            "timeout": 300000,
            "rpId": "tavrn.org",
            "allowCredentials": [{ "type": "public-key", "id": "Y3JlZC0x" }],
            "userVerification": "required",
            "extensions": { "prf": { "eval": { "first": "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc" } } }
        }, "mediation": "optional" })
    }

    #[test]
    fn the_nodes_registration_options_map_to_the_windows_request() {
        let o = parse_creation(&creation()).unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!((o.rp.id.as_str(), o.rp.name.as_str()), ("tavrn.org", "tavrn"));
        assert_eq!(o.user.id.0.len(), 16);
        assert_eq!(o.challenge.0.len(), 32);
        assert_eq!(o.pub_key_cred_params.iter().map(|p| p.alg).collect::<Vec<_>>(), [-7, -257]);
        assert_eq!(o.exclude_credentials[0].id.0, b"cred-1");
        assert_eq!(o.exclude_credentials[0].transport_bits(), 0x10 | 0x20, "unknown transports are left out");
        assert_eq!(resident_key(&o.authenticator_selection), (false, true));
        assert_eq!(user_verification(o.authenticator_selection.user_verification.as_deref()), 1);
        assert_eq!(attachment(o.authenticator_selection.authenticator_attachment.as_deref()), 0);
        assert_eq!(o.extensions.prf.and_then(|p| p.eval).map(|e| e.first.0), Some(vec![7u8; 32]));
        assert_eq!(timeout_ms(o.timeout), 300_000);
    }

    #[test]
    fn the_request_options_map_to_the_windows_request() {
        let o = parse_request(&request()).unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!(o.rp_id.as_deref(), Some("tavrn.org"));
        assert_eq!(o.allow_credentials.len(), 1);
        assert_eq!(user_verification(o.user_verification.as_deref()), 1);
        assert!(o.extensions.prf.and_then(|p| p.eval).is_some());
        // A discoverable sign-in: no allow list, no PRF.
        let bare =
            parse_request(&json!({ "publicKey": { "challenge": "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA" } })).unwrap_or_else(|e| unreachable!("{e}"));
        assert!(bare.allow_credentials.is_empty() && bare.rp_id.is_none() && bare.extensions.prf.is_none());
        assert_eq!(timeout_ms(bare.timeout), 120_000);
        assert_eq!(timeout_ms(Some(1)), 30_000);
        assert_eq!(timeout_ms(Some(u32::MAX)), 600_000);
    }

    #[test]
    fn options_outside_the_bounds_are_refused() {
        let mut short = creation();
        short["publicKey"]["challenge"] = json!("AAAA");
        let mut no_params = creation();
        no_params["publicKey"]["pubKeyCredParams"] = json!([]);
        let mut other_type = creation();
        other_type["publicKey"]["excludeCredentials"][0]["type"] = json!("password");
        let mut long_name = creation();
        long_name["publicKey"]["user"]["name"] = json!("x".repeat(300));
        let mut big_prf = creation();
        big_prf["publicKey"]["extensions"]["prf"]["eval"]["first"] = json!(b64url(&[0u8; 300]));
        let mut not_b64 = creation();
        not_b64["publicKey"]["user"]["id"] = json!("not base64!");
        for bad in [short, no_params, other_type, long_name, big_prf, not_b64, json!({}), json!({ "publicKey": null })] {
            assert_eq!(parse_creation(&bad).err(), Some(FAILED), "{bad}");
        }
        let mut many = request();
        many["publicKey"]["allowCredentials"] = json!(vec![json!({ "type": "public-key", "id": "Y3JlZC0x" }); 65]);
        assert_eq!(parse_request(&many).err(), Some(FAILED));
    }

    #[test]
    fn only_the_nodes_origin_and_its_relying_party_ids() {
        for (rp, origin) in [("tavrn.org", ORIGIN), ("app.tavrn.org", ORIGIN), ("tavrn.org", "https://tavrn.org"), ("localhost", "http://localhost:8300")] {
            assert_eq!(check_relying_party(rp, origin), Ok(()), "{rp} {origin}");
        }
        for (rp, origin) in [
            ("evil.example", ORIGIN),
            ("org", ORIGIN),
            ("pp.tavrn.org", ORIGIN),
            ("web.app.tavrn.org", ORIGIN),
            ("tavrn.org", "http://app.tavrn.org"),
            ("TAVRN.org", ORIGIN),
            ("", ORIGIN),
            ("tavrn.org", "not an origin"),
        ] {
            assert_eq!(check_relying_party(rp, origin), Err(REFUSED), "{rp} {origin}");
        }
        let delegated = crate::config::Config { node: Some("https://app.tavrn.org".into()), web: Some("https://web.tavrn.org".into()), ..Default::default() };
        assert_eq!(origin_of(&delegated).as_deref(), Some("https://web.tavrn.org"), "the node's web client first");
        let plain = crate::config::Config { node: Some("https://tavrn.example".into()), ..Default::default() };
        assert_eq!(origin_of(&plain).as_deref(), Some("https://tavrn.example"));
        assert_eq!(origin_of(&crate::config::Config::default()), None);
    }

    #[test]
    fn client_data_is_what_a_browser_writes() {
        let data = client_data(Ceremony::Create, &[1, 2, 3], ORIGIN);
        assert_eq!(data, r#"{"type":"webauthn.create","challenge":"AQID","origin":"https://app.tavrn.org","crossOrigin":false}"#);
        let parsed: Value = serde_json::from_str(&client_data(Ceremony::Get, &[0xfb, 0xff], ORIGIN)).unwrap_or_default();
        assert_eq!(parsed["type"], "webauthn.get");
        assert_eq!(parsed["challenge"], "-_8", "base64url without padding");
    }

    #[test]
    fn a_registration_is_the_browsers_registration_json() {
        let data = client_data(Ceremony::Create, &[9; 32], ORIGIN);
        let raw = RawRegistration {
            credential_id: b"cred-1".to_vec(),
            attestation_object: vec![0xa3, 1, 2],
            transport: 0x10,
            prf_enabled: Some(true),
            resident_key: Some(true),
        };
        let r = registration_json(&raw, &data);
        assert_eq!(r.prf, None);
        let c = &r.credential;
        assert_eq!((c["id"].as_str(), c["rawId"].as_str(), c["type"].as_str()), (Some("Y3JlZC0x"), Some("Y3JlZC0x"), Some("public-key")));
        assert_eq!(c["authenticatorAttachment"], "platform");
        assert_eq!(c["response"]["transports"], json!(["internal"]));
        assert_eq!(c["response"]["attestationObject"], "owEC");
        assert_eq!(b64().decode(c["response"]["clientDataJSON"].as_str().unwrap_or_default()).ok(), Some(data.into_bytes()));
        assert_eq!(c["clientExtensionResults"], json!({ "prf": { "enabled": true }, "credProps": { "rk": true } }));
        // The node reads it with webauthn-rs' own type.
        let parsed: Result<webauthn_rs_proto::RegisterPublicKeyCredential, _> = serde_json::from_value(c.clone());
        let parsed = parsed.unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!(parsed.raw_id.as_ref(), b"cred-1");
        // A security key over USB; a system that reports nothing.
        let usb = registration_json(&RawRegistration { transport: 1, ..raw.clone() }, "{}");
        assert_eq!(
            (usb.credential["authenticatorAttachment"].as_str(), usb.credential["response"]["transports"].clone()),
            (Some("cross-platform"), json!(["usb"]))
        );
        let quiet = registration_json(&RawRegistration { transport: 0, prf_enabled: None, resident_key: None, ..raw }, "{}");
        assert_eq!((quiet.credential["authenticatorAttachment"].clone(), quiet.credential["clientExtensionResults"].clone()), (Value::Null, json!({})));
    }

    #[test]
    fn an_assertion_is_the_browsers_assertion_json_with_the_prf_apart() {
        let data = client_data(Ceremony::Get, &[9; 32], ORIGIN);
        let raw = RawAssertion {
            credential_id: b"cred-1".to_vec(),
            authenticator_data: vec![1; 37],
            signature: vec![2; 70],
            user_handle: vec![3; 16],
            transport: 0x20,
            prf_first: Some(vec![5; 32]),
        };
        let r = assertion_json(&raw, &data);
        assert_eq!(r.prf.as_deref(), Some("BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU"));
        let c = &r.credential;
        assert_eq!(c["authenticatorAttachment"], "cross-platform", "a phone over hybrid roams");
        assert_eq!(c["response"]["userHandle"], b64url(&[3; 16]));
        assert_eq!(c["clientExtensionResults"], json!({}), "the PRF output never goes to the node");
        assert!(!c.to_string().contains("BQUFBQUF"));
        let parsed: Result<webauthn_rs_proto::PublicKeyCredential, _> = serde_json::from_value(c.clone());
        let parsed = parsed.unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!(parsed.get_user_unique_id(), Some(&[3u8; 16][..]));
        // No user handle (a credential that is not discoverable), and a PRF output of the wrong size.
        let plain = assertion_json(&RawAssertion { user_handle: Vec::new(), prf_first: Some(vec![5; 16]), ..raw }, &data);
        assert_eq!((plain.credential["response"]["userHandle"].clone(), plain.prf), (Value::Null, None));
    }

    #[test]
    fn the_options_webauthn_rs_writes_are_read() {
        use webauthn_rs_proto::*;
        let id = base64urlsafedata::Base64UrlSafeData::from(vec![1u8; 16]);
        let creation = CreationChallengeResponse {
            public_key: PublicKeyCredentialCreationOptions {
                rp: RelyingParty { name: "tavrn".into(), id: "tavrn.org".into() },
                user: User { id: id.clone(), name: "alice".into(), display_name: "Alice".into() },
                challenge: vec![2u8; 32].into(),
                pub_key_cred_params: vec![PubKeyCredParams { type_: "public-key".into(), alg: -7 }],
                timeout: Some(300_000),
                exclude_credentials: Some(vec![PublicKeyCredentialDescriptor {
                    type_: "public-key".into(),
                    id: id.clone(),
                    transports: Some(vec![AuthenticatorTransport::Usb]),
                }]),
                authenticator_selection: Some(AuthenticatorSelectionCriteria {
                    authenticator_attachment: Some(AuthenticatorAttachment::CrossPlatform),
                    resident_key: Some(ResidentKeyRequirement::Required),
                    require_resident_key: true,
                    user_verification: UserVerificationPolicy::Required,
                }),
                hints: None,
                attestation: Some(AttestationConveyancePreference::None),
                attestation_formats: None,
                extensions: None,
            },
        };
        let o = parse_creation(&serde_json::to_value(&creation).unwrap_or_default()).unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!((o.user.id.0.len(), o.challenge.0.len(), o.exclude_credentials[0].transport_bits()), (16, 32, 1));
        assert_eq!(resident_key(&o.authenticator_selection), (true, false));
        assert_eq!(attachment(o.authenticator_selection.authenticator_attachment.as_deref()), 2);
        let request = RequestChallengeResponse {
            public_key: PublicKeyCredentialRequestOptions {
                challenge: vec![2u8; 32].into(),
                timeout: Some(300_000),
                rp_id: "tavrn.org".into(),
                allow_credentials: vec![],
                user_verification: UserVerificationPolicy::Required,
                hints: None,
                extensions: None,
            },
            mediation: None,
        };
        let o = parse_request(&serde_json::to_value(&request).unwrap_or_default()).unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!(o.rp_id.as_deref(), Some("tavrn.org"));
    }

    #[test]
    fn windows_errors_become_the_browsers_errors() {
        assert_eq!(error_code(0x8009_0036), CANCELLED, "NTE_USER_CANCELLED");
        assert_eq!(error_code(0x8007_05B4), CANCELLED, "timeout");
        assert_eq!(error_code(0x8009_0011), CANCELLED, "no matching passkey");
        assert_eq!(error_code(0x8009_000F), EXISTS, "NTE_EXISTS");
        assert_eq!(error_code(0x8009_0029), UNAVAILABLE);
        assert_eq!(error_code(0x8009_0027), FAILED, "NTE_INVALID_PARAMETER");
    }

    #[test]
    fn other_platforms_have_no_native_path() {
        assert_eq!(available(), cfg!(windows) && available());
        #[cfg(not(windows))]
        assert!(!available());
    }
}
