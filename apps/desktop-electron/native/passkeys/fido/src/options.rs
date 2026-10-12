// SPDX-License-Identifier: Apache-2.0
//! The node's WebAuthn options as the client hands them over (`{ publicKey }` with base64url values, the JSON form of
//! `PublicKeyCredentialCreationOptions` and `PublicKeyCredentialRequestOptions`), checked against the bounds of what the
//! shell passes to a security key; the relying party rule; `clientDataJSON` as a browser writes it. The shapes, bounds
//! and rules are the Windows app's (`apps/desktop/src-tauri/src/passkey.rs`), so both shells accept and refuse the same.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::{FAILED, REFUSED, b64, b64url};

/// Bounds of what the shell passes to the authenticator.
const MAX_ID_BYTES: usize = 1023;
const MAX_LIST: usize = 64;
const MAX_TEXT: usize = 256;
const MAX_PRF_INPUT: usize = 256;
const DEFAULT_TIMEOUT_MS: u32 = 120_000;
const MIN_TIMEOUT_MS: u32 = 30_000;
const MAX_TIMEOUT_MS: u32 = 600_000;

/// Bytes given as base64url (with or without padding).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bytes(pub Vec<u8>);

impl<'de> Deserialize<'de> for Bytes {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use base64::Engine as _;
        let text = String::deserialize(d)?;
        b64().decode(text.as_bytes()).map(Bytes).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Deserialize)]
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
    pub attestation: Option<String>,
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

/// The host of a secure origin: https, or plain http on this computer only (the development node).
fn secure_host(origin: &str) -> Option<String> {
    let url = url::Url::parse(origin).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let secure = url.scheme() == "https" || (url.scheme() == "http" && matches!(host.as_str(), "localhost" | "127.0.0.1"));
    secure.then_some(host)
}

/// WebAuthn's rule as a browser applies it: the relying party id must be the origin's host or a registrable parent
/// domain of it (a single label only for `localhost`, the development node); https, plain http only on this computer.
pub fn check_relying_party(rp_id: &str, origin: &str) -> Result<(), &'static str> {
    let host = secure_host(origin).ok_or(REFUSED)?;
    let rp = rp_id.to_ascii_lowercase();
    let registrable = rp.contains('.') || rp == "localhost";
    let covers = host == rp || host.ends_with(&format!(".{rp}"));
    if registrable && covers && !rp.is_empty() && rp == rp_id { Ok(()) } else { Err(REFUSED) }
}

/// The relying party id of an assertion: the options' `rpId`, else the origin's host (the browser's default).
pub fn request_rp_id(options: &RequestOptions, origin: &str) -> Result<String, &'static str> {
    match &options.rp_id {
        Some(rp) => Ok(rp.clone()),
        None => secure_host(origin).ok_or(REFUSED),
    }
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

/// The timeout the shell grants the security key (the node asks for minutes; the user may need to find the key).
pub fn timeout_ms(requested: Option<u32>) -> u32 {
    requested.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ORIGIN: &str = "https://app.tavrn.org";

    /// The node's registration options as webauthn-rs serialises them (with the PRF input tavrn-node adds).
    pub fn creation() -> Value {
        json!({ "publicKey": {
            "rp": { "name": "tavrn", "id": "tavrn.org" },
            "user": { "id": "AZKjm8Wq3P1Xn2l3m4n5oQ", "name": "alice", "displayName": "Alice" },
            "challenge": "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA",
            "pubKeyCredParams": [{ "type": "public-key", "alg": -7 }, { "type": "public-key", "alg": -257 }],
            "timeout": 300000,
            "excludeCredentials": [{ "type": "public-key", "id": "Y3JlZC0x", "transports": ["usb", "nfc-x"] }],
            "authenticatorSelection": { "residentKey": "preferred", "requireResidentKey": false, "userVerification": "required" },
            "attestation": "none",
            "extensions": { "credentialProtectionPolicy": "userVerificationRequired", "uvm": true, "credProps": true, "prf": { "eval": { "first": "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc" } } }
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
    fn the_nodes_options_are_read() {
        let o = parse_creation(&creation()).unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!((o.rp.id.as_str(), o.rp.name.as_str()), ("tavrn.org", "tavrn"));
        assert_eq!((o.user.id.0.len(), o.challenge.0.len()), (16, 32));
        assert_eq!(o.pub_key_cred_params.iter().map(|p| p.alg).collect::<Vec<_>>(), [-7, -257]);
        assert_eq!(o.exclude_credentials[0].id.0, b"cred-1");
        assert_eq!(o.attestation.as_deref(), Some("none"));
        assert_eq!(o.extensions.prf.and_then(|p| p.eval).map(|e| e.first.0), Some(vec![7u8; 32]));
        let r = parse_request(&request()).unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!((r.rp_id.as_deref(), r.allow_credentials.len(), r.user_verification.as_deref()), (Some("tavrn.org"), 1, Some("required")));
        // A discoverable sign-in: no allow list, no PRF; the relying party is the origin's host.
        let bare =
            parse_request(&json!({ "publicKey": { "challenge": "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA" } })).unwrap_or_else(|e| unreachable!("{e}"));
        assert!(bare.allow_credentials.is_empty() && bare.rp_id.is_none() && bare.extensions.prf.is_none());
        assert_eq!(request_rp_id(&bare, ORIGIN).as_deref(), Ok("app.tavrn.org"));
        assert_eq!(request_rp_id(&bare, "http://evil.example"), Err(REFUSED));
        assert_eq!((timeout_ms(bare.timeout), timeout_ms(Some(1)), timeout_ms(Some(u32::MAX)), timeout_ms(r.timeout)), (120_000, 30_000, 600_000, 300_000));
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
    }

    #[test]
    fn client_data_is_what_a_browser_writes() {
        let data = client_data(Ceremony::Create, &[1, 2, 3], ORIGIN);
        assert_eq!(data, r#"{"type":"webauthn.create","challenge":"AQID","origin":"https://app.tavrn.org","crossOrigin":false}"#);
        let parsed: Value = serde_json::from_str(&client_data(Ceremony::Get, &[0xfb, 0xff], ORIGIN)).unwrap_or_default();
        assert_eq!(parsed["type"], "webauthn.get");
        assert_eq!(parsed["challenge"], "-_8", "base64url without padding");
    }
}
