// SPDX-License-Identifier: Apache-2.0
//! From the node's options to the CTAP requests of Mozilla's `authenticator` crate, and from the security key's answers
//! to the browser's `PublicKeyCredential.toJSON()` (the Windows app's `registration_json` and `assertion_json`). Pure
//! functions: the transport is [`crate::usb`]; the tests run them against a software authenticator and the node's own
//! WebAuthn verifier (`tests/soft_authenticator.rs`).

use authenticator::authenticatorservice::{RegisterArgs, SignArgs};
use authenticator::ctap2::commands::StatusCode;
use authenticator::ctap2::server::{
    AuthenticationExtensionsClientInputs, AuthenticationExtensionsPRFInputs, AuthenticationExtensionsPRFValues, AuthenticatorAttachment,
    PublicKeyCredentialDescriptor, PublicKeyCredentialParameters, PublicKeyCredentialUserEntity, RelyingParty, ResidentKeyRequirement, Transport,
    UserVerificationRequirement,
};
use authenticator::errors::{AuthenticatorError, CommandError, HIDError, PinError, U2FTokenError};
use authenticator::{RegisterResult, SignResult};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};

use crate::options::{self, Ceremony, CreationOptions, Descriptor, Extensions, RequestOptions, Selection};
use crate::{CANCELLED, EXISTS, FAILED, UNAVAILABLE, b64url};

/// A ceremony ready for the security key: the request, the `clientDataJSON` it signs and the shell's timeout.
#[derive(Debug, Clone)]
pub struct Prepared<A> {
    pub args: A,
    pub client_data_json: String,
    pub timeout_ms: u32,
    /// Registration: the attestation is replaced by `none` (the node asks for none; browsers do the same).
    anonymize: bool,
    /// Assertion: the allowed credential ids (a CTAP2.0 key may leave the credential out of its answer).
    allow: Vec<Vec<u8>>,
}

/// The answer to the client: the credential for the node and the PRF output apart (base64url, local use only).
#[derive(Debug, Clone, Serialize)]
pub struct NativeResult {
    pub credential: Value,
    pub prf: Option<String>,
}

/// The hash a security key signs: SHA-256 of `clientDataJSON`.
pub fn client_data_hash(client_data_json: &str) -> [u8; 32] {
    Sha256::digest(client_data_json.as_bytes()).into()
}

fn user_verification(value: Option<&str>) -> UserVerificationRequirement {
    match value {
        Some("required") => UserVerificationRequirement::Required,
        Some("discouraged") => UserVerificationRequirement::Discouraged,
        _ => UserVerificationRequirement::Preferred,
    }
}

/// `residentKey` (or the older `requireResidentKey`) as the request's requirement.
fn resident_key(selection: &Selection) -> ResidentKeyRequirement {
    match selection.resident_key.as_deref() {
        Some("required") => ResidentKeyRequirement::Required,
        Some("preferred") => ResidentKeyRequirement::Preferred,
        Some(_) => ResidentKeyRequirement::Discouraged,
        None if selection.require_resident_key => ResidentKeyRequirement::Required,
        None => ResidentKeyRequirement::Discouraged,
    }
}

fn descriptors(list: &[Descriptor]) -> Vec<PublicKeyCredentialDescriptor> {
    let transport = |t: &str| match t {
        "usb" => Some(Transport::USB),
        "nfc" => Some(Transport::NFC),
        "ble" => Some(Transport::BLE),
        "internal" => Some(Transport::Internal),
        _ => None,
    };
    list.iter().map(|d| PublicKeyCredentialDescriptor { id: d.id.0.clone(), transports: d.transports.iter().filter_map(|t| transport(t)).collect() }).collect()
}

/// WebAuthn's `prf` input for the key (the crate derives the hmac-secret salt as WebAuthn's PRF extension does,
/// SHA-256("WebAuthn PRF" || 0x00 || input), so the output equals a browser's for the same passkey and input).
fn prf_input(ext: &Extensions) -> Option<AuthenticationExtensionsPRFInputs> {
    let prf = ext.prf.as_ref()?;
    let eval = prf.eval.as_ref().map(|e| AuthenticationExtensionsPRFValues { first: e.first.0.clone(), second: e.second.as_ref().map(|s| s.0.clone()) });
    Some(AuthenticationExtensionsPRFInputs { eval, eval_by_credential: None })
}

/// A registration (Settings → Security, registration): the node's options, checked; the origin must cover its rp id.
pub fn prepare_create(options: &Value, origin: &str) -> Result<Prepared<RegisterArgs>, &'static str> {
    let o: CreationOptions = options::parse_creation(options)?;
    options::check_relying_party(&o.rp.id, origin)?;
    // Algorithms the crate does not know are skipped, as a browser skips them; none left: nothing a key could make.
    let params: Vec<PublicKeyCredentialParameters> = o.pub_key_cred_params.iter().filter_map(|p| PublicKeyCredentialParameters::try_from(p.alg).ok()).collect();
    if params.is_empty() {
        return Err(UNAVAILABLE);
    }
    let client_data_json = options::client_data(Ceremony::Create, &o.challenge.0, origin);
    let prf = prf_input(&o.extensions);
    let args = RegisterArgs {
        client_data_hash: client_data_hash(&client_data_json),
        relying_party: RelyingParty { id: o.rp.id.clone(), name: Some(o.rp.name.clone()) },
        origin: origin.to_string(),
        user: PublicKeyCredentialUserEntity { id: o.user.id.0.clone(), name: Some(o.user.name.clone()), display_name: Some(o.user.display_name.clone()) },
        pub_cred_params: params,
        exclude_list: descriptors(&o.exclude_credentials),
        user_verification_req: user_verification(o.authenticator_selection.user_verification.as_deref()),
        resident_key_req: resident_key(&o.authenticator_selection),
        extensions: AuthenticationExtensionsClientInputs { cred_props: Some(true), prf, ..Default::default() },
        pin: None,
        use_ctap1_fallback: false,
    };
    let anonymize = o.attestation.as_deref().is_none_or(|a| a == "none");
    Ok(Prepared { args, client_data_json, timeout_ms: options::timeout_ms(o.timeout), anonymize, allow: Vec::new() })
}

/// An assertion (sign-in, second factor, re-authentication, the PRF unlock): the node's `{ publicKey }` or the client's
/// own one for the PRF.
pub fn prepare_get(options: &Value, origin: &str) -> Result<Prepared<SignArgs>, &'static str> {
    let o: RequestOptions = options::parse_request(options)?;
    let rp_id = options::request_rp_id(&o, origin)?;
    options::check_relying_party(&rp_id, origin)?;
    let client_data_json = options::client_data(Ceremony::Get, &o.challenge.0, origin);
    let args = SignArgs {
        client_data_hash: client_data_hash(&client_data_json),
        origin: origin.to_string(),
        relying_party_id: rp_id,
        // No list: a discoverable passkey (the passkey-only sign-in).
        allow_list: descriptors(&o.allow_credentials),
        user_verification_req: user_verification(o.user_verification.as_deref()),
        user_presence_req: true,
        extensions: AuthenticationExtensionsClientInputs { prf: prf_input(&o.extensions), ..Default::default() },
        pin: None,
        use_ctap1_fallback: false,
    };
    let allow = o.allow_credentials.iter().map(|d| d.id.0.clone()).collect();
    Ok(Prepared { args, client_data_json, timeout_ms: options::timeout_ms(o.timeout), anonymize: false, allow })
}

fn attachment(a: &AuthenticatorAttachment) -> Value {
    match a {
        AuthenticatorAttachment::Platform => json!("platform"),
        AuthenticatorAttachment::CrossPlatform => json!("cross-platform"),
        AuthenticatorAttachment::Unknown => Value::Null,
    }
}

/// The security key's registration as `PublicKeyCredential.toJSON()` (`RegistrationResponseJSON`).
pub fn finish_create(prepared: &Prepared<RegisterArgs>, mut result: RegisterResult) -> Result<NativeResult, &'static str> {
    if prepared.anonymize {
        result.att_obj.anonymize();
    }
    let credential_id = result.att_obj.auth_data.credential_data.as_ref().map(|c| c.credential_id.clone()).filter(|id| !id.is_empty()).ok_or(FAILED)?;
    let attestation_object = serde_cbor::to_vec(&result.att_obj).map_err(|_| FAILED)?;
    let mut ext = serde_json::Map::new();
    // PRF: the key enabled hmac-secret for the passkey (the crate reports it as `prf.enabled` when the PRF was asked).
    if let Some(enabled) = result.extensions.prf.as_ref().and_then(|p| p.enabled) {
        ext.insert("prf".into(), json!({ "enabled": enabled }));
    }
    if let Some(props) = &result.extensions.cred_props {
        ext.insert("credProps".into(), json!({ "rk": props.rk }));
    }
    let id = b64url(&credential_id);
    let credential = json!({
        "id": id,
        "rawId": id,
        "type": "public-key",
        "authenticatorAttachment": attachment(&result.attachment),
        "response": {
            "clientDataJSON": b64url(prepared.client_data_json.as_bytes()),
            "attestationObject": b64url(&attestation_object),
            "transports": ["usb"],
        },
        "clientExtensionResults": Value::Object(ext),
    });
    Ok(NativeResult { credential, prf: None })
}

/// The security key's assertion as `PublicKeyCredential.toJSON()` (`AuthenticationResponseJSON`); the PRF output
/// (`prf.results.first`, 32 bytes) only apart.
pub fn finish_get(prepared: &Prepared<SignArgs>, result: SignResult) -> Result<NativeResult, &'static str> {
    let a = &result.assertion;
    // CTAP2.0 may leave the credential out when the allow list named exactly one.
    let credential_id = match (&a.credentials, prepared.allow.as_slice()) {
        (Some(c), _) => c.id.clone(),
        (None, [only]) => only.clone(),
        (None, _) => return Err(FAILED),
    };
    if credential_id.is_empty() || a.signature.is_empty() || (!prepared.allow.is_empty() && !prepared.allow.contains(&credential_id)) {
        return Err(FAILED);
    }
    let user_handle = a.user.as_ref().map(|u| u.id.clone()).filter(|id| !id.is_empty()).map(|id| b64url(&id));
    let id = b64url(&credential_id);
    let credential = json!({
        "id": id,
        "rawId": id,
        "type": "public-key",
        "authenticatorAttachment": attachment(&result.attachment),
        "response": {
            "clientDataJSON": b64url(prepared.client_data_json.as_bytes()),
            "authenticatorData": b64url(&a.auth_data.to_vec()),
            "signature": b64url(&a.signature),
            "userHandle": user_handle,
        },
        "clientExtensionResults": {},
    });
    let prf = result.extensions.prf.as_ref().and_then(|p| p.results.as_ref()).map(|r| &r.first).filter(|f| f.len() == 32).map(|f| b64url(f));
    Ok(NativeResult { credential, prf })
}

/// A CTAP status as the client's code.
fn status_code(code: &StatusCode) -> &'static str {
    match code {
        StatusCode::NoCredentials | StatusCode::NotAllowed | StatusCode::OperationDenied | StatusCode::KeepaliveCancel | StatusCode::UserActionTimeout => {
            CANCELLED
        }
        StatusCode::CredentialExcluded => EXISTS,
        StatusCode::UnsupportedAlgorithm | StatusCode::UnsupportedOption | StatusCode::UnsupportedExtension => UNAVAILABLE,
        _ => FAILED,
    }
}

/// The crate's error as the client's code (the browser's DOMException: `passkey.cancelled` is `NotAllowedError`).
pub fn error_code(e: &AuthenticatorError) -> &'static str {
    match e {
        AuthenticatorError::CancelledByUser => CANCELLED,
        AuthenticatorError::CredentialExcluded => EXISTS,
        // A timeout of the transport, or no matching passkey on a U2F key.
        AuthenticatorError::U2FToken(U2FTokenError::NotAllowed) => CANCELLED,
        AuthenticatorError::U2FToken(U2FTokenError::InvalidState) => EXISTS,
        AuthenticatorError::U2FToken(U2FTokenError::NotSupported | U2FTokenError::ConstraintError) => UNAVAILABLE,
        AuthenticatorError::UnsupportedOption(_) | AuthenticatorError::NoConfiguredTransports | AuthenticatorError::Platform => UNAVAILABLE,
        AuthenticatorError::HIDError(HIDError::Command(CommandError::StatusCode(code, _))) => status_code(code),
        AuthenticatorError::PinError(PinError::PinRequired) => CANCELLED,
        _ => FAILED,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::REFUSED;
    use authenticator::ctap2::server::{AuthenticationExtensionsClientOutputs, AuthenticationExtensionsPRFOutputs};
    use serde_json::json;

    const ORIGIN: &str = "https://app.tavrn.org";

    fn creation() -> Value {
        json!({ "publicKey": {
            "rp": { "name": "tavrn", "id": "tavrn.org" },
            "user": { "id": "AZKjm8Wq3P1Xn2l3m4n5oQ", "name": "alice", "displayName": "Alice" },
            "challenge": "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA",
            "pubKeyCredParams": [{ "type": "public-key", "alg": -7 }, { "type": "public-key", "alg": -4242 }, { "type": "public-key", "alg": -257 }],
            "timeout": 300000,
            "excludeCredentials": [{ "type": "public-key", "id": "Y3JlZC0x", "transports": ["usb", "hybrid"] }],
            "authenticatorSelection": { "residentKey": "required", "requireResidentKey": true, "userVerification": "required" },
            "attestation": "none",
            "extensions": { "credProps": true, "prf": { "eval": { "first": "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc" } } }
        } })
    }

    fn request() -> Value {
        json!({ "publicKey": {
            "challenge": "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA",
            "rpId": "tavrn.org",
            "allowCredentials": [{ "type": "public-key", "id": "Y3JlZC0x" }],
            "userVerification": "required",
            "extensions": { "prf": { "eval": { "first": "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc" } } }
        } })
    }

    #[test]
    fn a_registration_becomes_the_keys_request() {
        let p = prepare_create(&creation(), ORIGIN).unwrap_or_else(|e| unreachable!("{e}"));
        let a = &p.args;
        assert_eq!(a.client_data_hash, client_data_hash(&p.client_data_json), "the key signs the hash of the shell's clientDataJSON");
        let data: Value = serde_json::from_str(&p.client_data_json).unwrap_or_default();
        assert_eq!((data["type"].as_str(), data["origin"].as_str()), (Some("webauthn.create"), Some(ORIGIN)));
        assert_eq!((a.relying_party.id.as_str(), a.relying_party.name.as_deref(), a.origin.as_str()), ("tavrn.org", Some("tavrn"), ORIGIN));
        assert_eq!((a.user.id.len(), a.user.name.as_deref(), a.user.display_name.as_deref()), (16, Some("alice"), Some("Alice")));
        assert_eq!(a.pub_cred_params.iter().map(|p| p.alg as i64).collect::<Vec<_>>(), [-7, -257], "an unknown algorithm is skipped");
        assert_eq!((a.exclude_list[0].id.as_slice(), a.exclude_list[0].transports.as_slice()), (&b"cred-1"[..], &[Transport::USB][..]));
        assert_eq!((a.resident_key_req, a.user_verification_req), (ResidentKeyRequirement::Required, UserVerificationRequirement::Required));
        assert_eq!(a.extensions.cred_props, Some(true));
        let prf = a.extensions.prf.as_ref().and_then(|p| p.eval.as_ref()).map(|e| e.first.clone());
        assert_eq!(prf, Some(vec![7u8; 32]), "the PRF input goes as is; the crate derives the salt");
        assert!(a.pin.is_none() && !a.use_ctap1_fallback);
        assert_eq!(p.timeout_ms, 300_000);
        // Preferences and their defaults.
        let mut preferred = creation();
        preferred["publicKey"]["authenticatorSelection"] = json!({ "residentKey": "preferred", "userVerification": "discouraged" });
        let p = prepare_create(&preferred, ORIGIN).unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!((p.args.resident_key_req, p.args.user_verification_req), (ResidentKeyRequirement::Preferred, UserVerificationRequirement::Discouraged));
        let mut legacy = creation();
        legacy["publicKey"]["authenticatorSelection"] = json!({ "requireResidentKey": true });
        let p = prepare_create(&legacy, ORIGIN).unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!((p.args.resident_key_req, p.args.user_verification_req), (ResidentKeyRequirement::Required, UserVerificationRequirement::Preferred));
    }

    #[test]
    fn an_assertion_becomes_the_keys_request() {
        let p = prepare_get(&request(), ORIGIN).unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!(p.args.client_data_hash, client_data_hash(&p.client_data_json));
        assert_eq!((p.args.relying_party_id.as_str(), p.args.allow_list.len(), p.args.user_presence_req), ("tavrn.org", 1, true));
        assert_eq!(p.args.user_verification_req, UserVerificationRequirement::Required);
        assert!(p.args.extensions.prf.as_ref().and_then(|e| e.eval.as_ref()).is_some());
        assert_eq!(p.timeout_ms, 120_000);
        // The passkey-only sign-in: no list, the rp id from the node's options.
        let p = prepare_get(&json!({ "publicKey": { "challenge": "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA", "rpId": "tavrn.org" } }), ORIGIN)
            .unwrap_or_else(|e| unreachable!("{e}"));
        assert!(p.args.allow_list.is_empty() && p.args.extensions.prf.is_none());
    }

    #[test]
    fn only_the_nodes_origin_signs() {
        assert_eq!(prepare_create(&creation(), "https://evil.example").err(), Some(REFUSED));
        assert_eq!(prepare_get(&request(), "https://evil.example").err(), Some(REFUSED));
        assert_eq!(prepare_get(&request(), "http://app.tavrn.org").err(), Some(REFUSED), "plain http only on this computer");
        let mut odd = creation();
        odd["publicKey"]["pubKeyCredParams"] = json!([{ "type": "public-key", "alg": -4242 }]);
        assert_eq!(prepare_create(&odd, ORIGIN).err(), Some(UNAVAILABLE), "no algorithm a key could use");
        assert_eq!(prepare_create(&json!({}), ORIGIN).err(), Some(FAILED));
    }

    #[test]
    fn the_prf_output_and_properties_of_the_answers() {
        let p = prepare_get(&request(), ORIGIN).unwrap_or_else(|e| unreachable!("{e}"));
        let outputs = |first: Vec<u8>| AuthenticationExtensionsClientOutputs {
            prf: Some(AuthenticationExtensionsPRFOutputs { enabled: None, results: Some(AuthenticationExtensionsPRFValues { first, second: None }) }),
            ..Default::default()
        };
        let raw_auth_data = [vec![1u8; 32], vec![0x05, 0, 0, 0, 7]].concat();
        let result = |credentials: Option<Vec<u8>>, first: Vec<u8>| SignResult {
            assertion: authenticator::Assertion {
                credentials: credentials.map(|id| PublicKeyCredentialDescriptor { id, transports: vec![] }),
                auth_data: serde_cbor::value::from_value(serde_cbor::Value::Bytes(raw_auth_data.clone())).unwrap_or_else(|e| unreachable!("{e}")),
                signature: vec![2; 70],
                user: Some(PublicKeyCredentialUserEntity { id: vec![3; 16], name: None, display_name: None }),
            },
            attachment: AuthenticatorAttachment::CrossPlatform,
            extensions: outputs(first),
        };
        let r = finish_get(&p, result(Some(b"cred-1".to_vec()), vec![5; 32])).unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!(r.prf.as_deref(), Some("BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU"));
        let c = &r.credential;
        assert_eq!((c["id"].as_str(), c["authenticatorAttachment"].as_str()), (Some("Y3JlZC0x"), Some("cross-platform")));
        assert_eq!(c["response"]["userHandle"], b64url(&[3; 16]));
        assert_eq!(c["response"]["authenticatorData"], b64url(&raw_auth_data), "the key's bytes as they came");
        assert_eq!(c["clientExtensionResults"], json!({}), "the PRF output never goes to the node");
        assert!(!c.to_string().contains("BQUFBQUF"));
        // CTAP2.0: no credential in the answer, one in the allow list; a PRF output of the wrong size counts as none.
        let r = finish_get(&p, result(None, vec![5; 16])).unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!((r.credential["id"].as_str(), r.prf), (Some("Y3JlZC0x"), None));
        assert_eq!(finish_get(&p, result(Some(b"other".to_vec()), vec![5; 32])).err(), Some(FAILED), "a credential the node did not allow");
    }

    #[test]
    fn the_keys_errors_become_the_browsers() {
        let status = |code| AuthenticatorError::HIDError(HIDError::Command(CommandError::StatusCode(code, None)));
        assert_eq!(error_code(&AuthenticatorError::CancelledByUser), CANCELLED);
        assert_eq!(error_code(&AuthenticatorError::U2FToken(U2FTokenError::NotAllowed)), CANCELLED, "the timeout");
        assert_eq!(error_code(&status(StatusCode::NoCredentials)), CANCELLED, "no matching passkey on the key");
        assert_eq!(error_code(&status(StatusCode::OperationDenied)), CANCELLED);
        assert_eq!(error_code(&AuthenticatorError::CredentialExcluded), EXISTS);
        assert_eq!(error_code(&status(StatusCode::CredentialExcluded)), EXISTS);
        assert_eq!(error_code(&status(StatusCode::UnsupportedAlgorithm)), UNAVAILABLE);
        assert_eq!(error_code(&AuthenticatorError::NoConfiguredTransports), UNAVAILABLE);
        assert_eq!(error_code(&AuthenticatorError::PinError(PinError::PinBlocked)), FAILED);
        assert_eq!(error_code(&status(StatusCode::KeyStoreFull)), FAILED);
    }
}
