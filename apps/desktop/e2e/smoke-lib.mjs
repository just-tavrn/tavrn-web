// SPDX-License-Identifier: Apache-2.0
/** Helpers of the WebDriver smoke test (smoke.mjs), kept apart so `node --test` can check them. */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

/**
 * The environment of the processes the test starts: GTK on X11 and no WAYLAND_DISPLAY, so the app renders on xvfb's
 * X display (WSLg sets WAYLAND_DISPLAY, and GTK prefers Wayland: the windows would open on the desktop).
 */
export function childEnv(base, extra = {}) {
  const env = { ...base, ...extra, GDK_BACKEND: "x11" };
  delete env.WAYLAND_DISPLAY;
  return env;
}

/** The node's `/` is its web client, not the placeholder of a node built without one (or a debug build whose tree is gone). */
export function servesWebClient(html) {
  return !/Web client not embedded/.test(html) && /<html/i.test(html);
}

/** `pgrep -f -x` pattern of the app binary with any arguments (regex characters of the path escaped). */
export function appProcessPattern(app) {
  return `${app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( .*)?`;
}

/** Minimal CBOR (RFC 8949): integers, byte strings (Uint8Array), text and maps (Map, entries in the given order). */
export function cbor(value) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
    if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value, "utf8")]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error(`cbor: unsupported value ${String(value)}`);
}

/**
 * What a browser with a platform authenticator returns from `navigator.credentials.create()` for the node's options:
 * a new ES256 credential, attestation "none", user present and verified, PRF supported. The sign-in window of the Linux
 * app (WebKitGTK) has no WebAuthn, so the smoke test registers its passkey this way over the API.
 */
export function softPasskeyRegistration({ rpId, origin, challenge }) {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = randomBytes(16);
  const coseKey = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
  const length = Buffer.alloc(2);
  length.writeUInt16BE(credentialId.length);
  // rpIdHash, flags UP | UV | AT, sign count 0, AAGUID of zeros, the credential id and its public key.
  const authData = Buffer.concat([createHash("sha256").update(rpId).digest(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, credentialId, coseKey]);
  const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
  const id = credentialId.toString("base64url");
  return {
    credentialId: id,
    credential: {
      id,
      rawId: id,
      type: "public-key",
      authenticatorAttachment: "platform",
      response: { clientDataJSON: clientDataJSON.toString("base64url"), attestationObject: attestationObject.toString("base64url"), transports: ["internal"] },
      clientExtensionResults: { prf: { enabled: true } },
    },
  };
}

/** The app's key for sealed unlock material, as the sign-in page keeps it in its sessionStorage: [session id, key]. */
export function keptUnlockKey(entries) {
  for (const [name, value] of entries) {
    const id = name.match(/^tavrn\.connect\.key\.([A-Za-z0-9_-]{43})$/)?.[1];
    if (id && /^[A-Za-z0-9_-]{43}$/.test(value)) return [id, value];
  }
  return null;
}
