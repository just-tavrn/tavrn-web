// SPDX-License-Identifier: Apache-2.0
//! The whole mapping against a software authenticator and the node's own verifier: tavrn-node's options (webauthn-rs
//! `start_passkey_registration` / `start_passkey_authentication`, with the PRF input the node adds) go through
//! `prepare_create` / `prepare_get`; the software passkey of `webauthn-authenticator-rs` answers the CTAP request (the
//! client data hash the shell computed, the request's relying party, user, algorithms and lists); its bytes become the
//! answers of Mozilla's crate as a security key over USB would produce them; `finish_create` / `finish_get` write the
//! browser's JSON, which webauthn-rs must accept exactly as the node does. Only the USB transport itself is not
//! exercised (a real key; docs/DESKTOP.md "Passkeys on Linux").

use authenticator::authenticatorservice::{RegisterArgs, SignArgs};
use authenticator::ctap2::attestation::{AttestationObject, AttestationStatement, AuthenticatorData};
use authenticator::ctap2::server::{
    AuthenticationExtensionsClientOutputs, AuthenticationExtensionsPRFOutputs, AuthenticatorAttachment, CredentialProperties, PublicKeyCredentialDescriptor,
    UserVerificationRequirement,
};
use authenticator::{Assertion, GetAssertionResult, MakeCredentialsResult};
use serde_json::{Value, json};
use tavrn_fido::ctap::{finish_create, finish_get, prepare_create, prepare_get};
use tavrn_fido::{REFUSED, b64url};
use webauthn_authenticator_rs::AuthenticatorBackendHashedClientData;
use webauthn_authenticator_rs::softpasskey::SoftPasskey;
use webauthn_rs::prelude::{Passkey, PublicKeyCredential, RegisterPublicKeyCredential, Url, Uuid, Webauthn, WebauthnBuilder};
use webauthn_rs_proto::{
    AuthenticatorSelectionCriteria, PubKeyCredParams, PublicKeyCredentialCreationOptions, PublicKeyCredentialRequestOptions, RelyingParty, User,
    UserVerificationPolicy,
};

/// The node's relying party and the origin of its web client (the shell's settings: `web`, else the node).
const RP_ID: &str = "tavrn.example";
const ORIGIN: &str = "https://app.tavrn.example";
/// What tavrn-node puts into `extensions.prf.eval.first` (the secret storage PRF input, ENCRYPTION.md §2.4).
const PRF_INPUT: &str = "dGF2cm4gc2VjcmV0IHN0b3JhZ2UgcHJmIHYx";

fn node() -> Webauthn {
    let origin = Url::parse(ORIGIN).unwrap_or_else(|e| unreachable!("{e}"));
    WebauthnBuilder::new(RP_ID, &origin).and_then(|b| b.rp_name("tavrn").build()).unwrap_or_else(|e| unreachable!("{e}"))
}

fn uv(req: UserVerificationRequirement) -> UserVerificationPolicy {
    match req {
        UserVerificationRequirement::Required => UserVerificationPolicy::Required,
        UserVerificationRequirement::Preferred => UserVerificationPolicy::Preferred,
        UserVerificationRequirement::Discouraged => UserVerificationPolicy::Discouraged_DO_NOT_USE,
    }
}

/// The software passkey as a CTAP2 key behind Mozilla's crate: it gets what `RegisterArgs` carries (the hash, not the
/// client data) and its answer is parsed as the crate parses a key's attestation object.
fn soft_register(key: &mut SoftPasskey, args: &RegisterArgs) -> MakeCredentialsResult {
    let options = PublicKeyCredentialCreationOptions {
        rp: RelyingParty { name: args.relying_party.name.clone().unwrap_or_default(), id: args.relying_party.id.clone() },
        user: User {
            id: args.user.id.clone().into(),
            name: args.user.name.clone().unwrap_or_default(),
            display_name: args.user.display_name.clone().unwrap_or_default(),
        },
        // The authenticator signs the hash; it never sees the challenge.
        challenge: vec![0u8; 32].into(),
        pub_key_cred_params: args.pub_cred_params.iter().map(|p| PubKeyCredParams { type_: "public-key".into(), alg: p.alg as i64 }).collect(),
        timeout: None,
        exclude_credentials: None,
        authenticator_selection: Some(AuthenticatorSelectionCriteria {
            authenticator_attachment: None,
            resident_key: None,
            require_resident_key: false,
            user_verification: uv(args.user_verification_req),
        }),
        hints: None,
        attestation: None,
        attestation_formats: None,
        extensions: None,
    };
    let reg = key.perform_register(args.client_data_hash.to_vec(), options, 60_000).unwrap_or_else(|e| unreachable!("{e:?}"));
    let att_obj: AttestationObject = serde_cbor::from_slice(reg.response.attestation_object.as_ref()).unwrap_or_else(|e| unreachable!("{e}"));
    MakeCredentialsResult {
        att_obj,
        attachment: AuthenticatorAttachment::CrossPlatform,
        // What the crate reports for a key with hmac-secret and a discoverable credential.
        extensions: AuthenticationExtensionsClientOutputs {
            cred_props: Some(CredentialProperties { rk: true }),
            prf: Some(AuthenticationExtensionsPRFOutputs { enabled: Some(true), results: None }),
            ..Default::default()
        },
    }
}

fn soft_sign(key: &mut SoftPasskey, args: &SignArgs, prf: Option<Vec<u8>>) -> GetAssertionResult {
    let options = PublicKeyCredentialRequestOptions {
        challenge: vec![0u8; 32].into(),
        timeout: None,
        rp_id: args.relying_party_id.clone(),
        allow_credentials: args
            .allow_list
            .iter()
            .map(|d| webauthn_rs_proto::AllowCredentials { type_: "public-key".into(), id: d.id.clone().into(), transports: None })
            .collect(),
        user_verification: uv(args.user_verification_req),
        hints: None,
        extensions: None,
    };
    let a = key.perform_auth(args.client_data_hash.to_vec(), options, 60_000).unwrap_or_else(|e| unreachable!("{e:?}"));
    let auth_data: AuthenticatorData =
        serde_cbor::value::from_value(serde_cbor::Value::Bytes(a.response.authenticator_data.to_vec())).unwrap_or_else(|e| unreachable!("{e}"));
    GetAssertionResult {
        assertion: Assertion {
            credentials: Some(PublicKeyCredentialDescriptor { id: a.raw_id.to_vec(), transports: vec![] }),
            auth_data,
            signature: a.response.signature.to_vec(),
            user: None,
        },
        attachment: AuthenticatorAttachment::CrossPlatform,
        extensions: AuthenticationExtensionsClientOutputs {
            prf: prf.map(|first| AuthenticationExtensionsPRFOutputs {
                enabled: None,
                results: Some(authenticator::ctap2::server::AuthenticationExtensionsPRFValues { first, second: None }),
            }),
            ..Default::default()
        },
    }
}

/// The node's options as the client receives them (`{ publicKey }` JSON), with the node's PRF input.
fn with_prf(mut options: Value) -> Value {
    options["publicKey"]["extensions"]["prf"] = json!({ "eval": { "first": PRF_INPUT } });
    options
}

/// Registers a passkey through the mapping; the node verifies it.
fn register(webauthn: &Webauthn, key: &mut SoftPasskey) -> Passkey {
    let (options, state) =
        webauthn.start_passkey_registration(Uuid::from_bytes([3; 16]), "alice@tavrn.example", "Alice", None).unwrap_or_else(|e| unreachable!("{e}"));
    let options = with_prf(serde_json::to_value(&options).unwrap_or_default());
    let prepared = prepare_create(&options, ORIGIN).unwrap_or_else(|e| unreachable!("{e}"));
    let result = finish_create(&prepared, soft_register(key, &prepared.args)).unwrap_or_else(|e| unreachable!("{e}"));
    assert_eq!(result.prf, None);
    let c = &result.credential;
    assert_eq!(c["clientExtensionResults"], json!({ "prf": { "enabled": true }, "credProps": { "rk": true } }));
    assert_eq!((c["authenticatorAttachment"].as_str(), c["response"]["transports"].clone()), (Some("cross-platform"), json!(["usb"])));
    let credential: RegisterPublicKeyCredential = serde_json::from_value(c.clone()).unwrap_or_else(|e| unreachable!("{e}"));
    webauthn.finish_passkey_registration(&credential, &state).unwrap_or_else(|e| unreachable!("the node refused the registration: {e}"))
}

#[test]
fn a_passkey_registered_and_used_through_the_shell_is_accepted_by_the_node() {
    let webauthn = node();
    let mut key = SoftPasskey::new(true);
    let passkey = register(&webauthn, &mut key);

    // Sign-in, second factor, re-authentication: the node's options with the PRF input.
    let (options, state) = webauthn.start_passkey_authentication(std::slice::from_ref(&passkey)).unwrap_or_else(|e| unreachable!("{e}"));
    let options = with_prf(serde_json::to_value(&options).unwrap_or_default());
    let prepared = prepare_get(&options, ORIGIN).unwrap_or_else(|e| unreachable!("{e}"));
    assert_eq!((prepared.args.relying_party_id.as_str(), prepared.args.allow_list.len()), (RP_ID, 1));
    let result = finish_get(&prepared, soft_sign(&mut key, &prepared.args, Some(vec![9; 32]))).unwrap_or_else(|e| unreachable!("{e}"));
    assert_eq!(result.prf.as_deref(), Some(b64url(&[9; 32]).as_str()), "the PRF output apart");
    assert_eq!(result.credential["clientExtensionResults"], json!({}));
    let credential: PublicKeyCredential = serde_json::from_value(result.credential.clone()).unwrap_or_else(|e| unreachable!("{e}"));
    let auth = webauthn.finish_passkey_authentication(&credential, &state).unwrap_or_else(|e| unreachable!("the node refused the assertion: {e}"));
    assert!(auth.user_verified());

    // The PRF unlock: the client's own options (a local challenge, the node's rp id, the credential, the PRF input).
    let local = json!({ "publicKey": {
        "rpId": RP_ID,
        "challenge": b64url(&[4; 32]),
        "allowCredentials": [{ "type": "public-key", "id": b64url(passkey.cred_id().as_ref()) }],
        "userVerification": "required",
        "timeout": 120000,
        "extensions": { "prf": { "eval": { "first": PRF_INPUT } } }
    } });
    let prepared = prepare_get(&local, ORIGIN).unwrap_or_else(|e| unreachable!("{e}"));
    let prf = prepared.args.extensions.prf.as_ref().and_then(|p| p.eval.as_ref()).map(|e| e.first.clone());
    assert_eq!(prf.as_deref(), Some(&b"tavrn secret storage prf v1"[..]));
    let result = finish_get(&prepared, soft_sign(&mut key, &prepared.args, Some(vec![6; 32]))).unwrap_or_else(|e| unreachable!("{e}"));
    assert_eq!(result.prf, Some(b64url(&[6; 32])));
}

#[test]
fn the_node_refuses_what_was_signed_for_another_origin() {
    let webauthn = node();
    let mut key = SoftPasskey::new(true);
    let passkey = register(&webauthn, &mut key);
    // A subdomain of the relying party passes the shell's rule, but it is not the node's web origin.
    let (options, state) = webauthn.start_passkey_authentication(std::slice::from_ref(&passkey)).unwrap_or_else(|e| unreachable!("{e}"));
    let options = serde_json::to_value(&options).unwrap_or_default();
    let prepared = prepare_get(&options, "https://other.tavrn.example").unwrap_or_else(|e| unreachable!("{e}"));
    let result = finish_get(&prepared, soft_sign(&mut key, &prepared.args, None)).unwrap_or_else(|e| unreachable!("{e}"));
    let credential: PublicKeyCredential = serde_json::from_value(result.credential).unwrap_or_else(|e| unreachable!("{e}"));
    assert!(webauthn.finish_passkey_authentication(&credential, &state).is_err(), "the origin in clientDataJSON is checked");
    // An origin outside the relying party never reaches the key.
    assert_eq!(prepare_get(&options, "https://evil.example").err(), Some(REFUSED));
}

#[test]
fn the_attestation_is_anonymized_as_browsers_do() {
    let webauthn = node();
    let (options, _) =
        webauthn.start_passkey_registration(Uuid::from_bytes([3; 16]), "alice@tavrn.example", "Alice", None).unwrap_or_else(|e| unreachable!("{e}"));
    let options = serde_json::to_value(&options).unwrap_or_default();
    let prepared = prepare_create(&options, ORIGIN).unwrap_or_else(|e| unreachable!("{e}"));
    let mut key = SoftPasskey::new(true);
    let result = finish_create(&prepared, soft_register(&mut key, &prepared.args)).unwrap_or_else(|e| unreachable!("{e}"));
    let bytes = tavrn_fido_test_b64(result.credential["response"]["attestationObject"].as_str().unwrap_or_default());
    let att: AttestationObject = serde_cbor::from_slice(&bytes).unwrap_or_else(|e| unreachable!("{e}"));
    assert!(matches!(att.att_stmt, AttestationStatement::None), "the key's packed attestation is replaced by none");
}

fn tavrn_fido_test_b64(text: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(text).unwrap_or_default()
}
