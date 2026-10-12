// SPDX-License-Identifier: Apache-2.0
/**
 * A software security key for the Playwright specs (docs/DESKTOP.md "Passkeys on Linux", "Development and tests
 * (Electron)"): the native module's functions (`PasskeyNative`) over an in-memory FIDO2 key with ES256 credentials,
 * discoverable credentials, a PIN and hmac-secret, so the shell's whole path (bridge, origin from the settings, the
 * dialog with the PIN, the client's flows, the node's verification) runs without a real key. Only a development build
 * uses it, and only when `TAVRN_DESKTOP_TEST_PASSKEYS` is set (`pin=<PIN>` for a key with a PIN, `nopin` for one
 * without); a package never does (`index.ts`).
 */
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { PasskeyNative } from "./passkeys.ts";

export const TEST_PASSKEYS_ENV = "TAVRN_DESKTOP_TEST_PASSKEYS";

/** The software key the environment asks for, or null. */
export function softKeyFromEnv(env: NodeJS.ProcessEnv): SoftKey | null {
  const value = env[TEST_PASSKEYS_ENV]?.trim();
  if (!value) return null;
  if (value === "nopin") return new SoftKey(null);
  const pin = /^pin=(.{4,63})$/.exec(value)?.[1];
  return pin ? new SoftKey(pin) : null;
}

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

/** A minimal CBOR encoder (unsigned and negative integers, byte and text strings, maps): what the key writes. */
export function cbor(value: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
    if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof value === "number" && Number.isInteger(value)) return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as Record<string, unknown>);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

interface Credential {
  id: Buffer;
  rpId: string;
  userId: Buffer;
  name: string;
  key: KeyObject;
  publicKey: KeyObject;
  /** The hmac-secret of the credential (CredRandom). */
  secret: Buffer;
  counter: number;
}

type Done = (error: string | null, result: string | null) => void;
type Pk = Record<string, unknown>;

/** WebAuthn's relying party rule (`options.rs`): the rp id must be the origin's host or a parent domain of it. */
function covers(rpId: string, origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname;
  const secure = url.protocol === "https:" || (url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1"));
  return secure && (rpId.includes(".") || rpId === "localhost") && (host === rpId || host.endsWith(`.${rpId}`));
}

/** The software key. One ceremony at a time, like the module. */
export class SoftKey implements PasskeyNative {
  readonly #pin: string | null;
  readonly #credentials: Credential[] = [];
  #retries = 8;
  #waiting: { pin?: (pin: string | null) => void; account?: (index: number | null) => void } = {};
  #cancel: (() => void) | null = null;

  constructor(pin: string | null) {
    this.#pin = pin;
  }

  available(): boolean {
    return true;
  }

  keys(): { present: number; usable: number } {
    return { present: 1, usable: 1 };
  }

  /** Tests: the public key of a credential. */
  publicKeyOf(id: string): KeyObject | null {
    return this.#credentials.find((c) => b64url(c.id) === id)?.publicKey ?? null;
  }

  create(options: string, origin: string, onEvent: (e: string) => void, onDone: Done): void {
    const pk = this.#start(options);
    const rp = pk.rp as { id: string };
    if (!covers(rp.id, origin)) throw new Error("passkey.refused");
    this.#run(onDone, async (step) => {
      await step(0);
      const sel = (pk.authenticatorSelection ?? {}) as { userVerification?: string };
      await this.#verify(sel.userVerification, onEvent, step);
      onEvent(JSON.stringify({ kind: "touch" }));
      await step(30);
      const excluded = ((pk.excludeCredentials ?? []) as Array<{ id: string }>).map((d) => d.id);
      if (this.#credentials.some((c) => c.rpId === rp.id && excluded.includes(b64url(c.id)))) throw "passkey.exists";
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const user = pk.user as { id: string; name: string; displayName: string };
      const cred: Credential = { id: randomBytes(16), rpId: rp.id, userId: Buffer.from(user.id, "base64url"), name: user.displayName || user.name, key: privateKey, publicKey, secret: randomBytes(32), counter: 0 };
      this.#credentials.push(cred);
      const jwk = publicKey.export({ format: "jwk" });
      const cose = cbor(
        new Map<number, unknown>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x!, "base64url")],
          [-3, Buffer.from(jwk.y!, "base64url")],
        ]),
      );
      const idLen = Buffer.from([cred.id.length >> 8, cred.id.length & 0xff]);
      // Flags: user present, user verified, attested credential data.
      const authData = Buffer.concat([sha256(Buffer.from(rp.id)), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), idLen, cred.id, cose]);
      const clientData = JSON.stringify({ type: "webauthn.create", challenge: pk.challenge, origin, crossOrigin: false });
      const ext: Record<string, unknown> = { credProps: { rk: true } };
      if ((pk.extensions as { prf?: unknown } | undefined)?.prf) ext.prf = { enabled: true };
      const credential = {
        id: b64url(cred.id),
        rawId: b64url(cred.id),
        type: "public-key",
        authenticatorAttachment: "cross-platform",
        response: { clientDataJSON: b64url(Buffer.from(clientData)), attestationObject: b64url(cbor({ fmt: "none", attStmt: {}, authData })), transports: ["usb"] },
        clientExtensionResults: ext,
      };
      return { credential, prf: null };
    });
  }

  get(options: string, origin: string, onEvent: (e: string) => void, onDone: Done): void {
    const pk = this.#start(options);
    const rpId = typeof pk.rpId === "string" ? pk.rpId : new URL(origin).hostname;
    if (!covers(rpId, origin)) throw new Error("passkey.refused");
    this.#run(onDone, async (step) => {
      // Like the module: events and the answer come later, never during the call.
      await step(0);
      await this.#verify(pk.userVerification as string | undefined, onEvent, step);
      onEvent(JSON.stringify({ kind: "touch" }));
      await step(30);
      const allow = ((pk.allowCredentials ?? []) as Array<{ id: string }>).map((d) => d.id);
      const found = this.#credentials.filter((c) => c.rpId === rpId && (!allow.length || allow.includes(b64url(c.id))));
      if (!found.length) throw "passkey.cancelled";
      let cred = found[0]!;
      if (found.length > 1 && !allow.length) {
        onEvent(JSON.stringify({ kind: "accounts", names: found.map((c) => c.name) }));
        const index = await new Promise<number | null>((resolve) => (this.#waiting.account = resolve));
        if (index === null || !found[index]) throw "passkey.cancelled";
        cred = found[index]!;
      }
      cred.counter += 1;
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(cred.counter);
      const authData = Buffer.concat([sha256(Buffer.from(rpId)), Buffer.from([0x05]), counter]);
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: pk.challenge, origin, crossOrigin: false }));
      const signature = sign("sha256", Buffer.concat([authData, sha256(clientData)]), cred.key);
      // hmac-secret with WebAuthn's PRF salt: SHA-256("WebAuthn PRF" || 0x00 || input).
      const input = (pk.extensions as { prf?: { eval?: { first?: string } } } | undefined)?.prf?.eval?.first;
      const prf = input ? b64url(createHmac("sha256", cred.secret).update(sha256(Buffer.from("WebAuthn PRF\0"), Buffer.from(input, "base64url"))).digest()) : null;
      const credential = {
        id: b64url(cred.id),
        rawId: b64url(cred.id),
        type: "public-key",
        authenticatorAttachment: "cross-platform",
        response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(signature), userHandle: b64url(cred.userId) },
        clientExtensionResults: {},
      };
      return { credential, prf };
    });
  }

  pin(pin: string | null): boolean {
    const waiting = this.#waiting.pin;
    this.#waiting.pin = undefined;
    waiting?.(pin);
    return !!waiting;
  }

  account(index: number | null): boolean {
    const waiting = this.#waiting.account;
    this.#waiting.account = undefined;
    waiting?.(index);
    return !!waiting;
  }

  cancel(): void {
    this.#cancel?.();
  }

  #start(options: string): Pk {
    if (this.#cancel) throw new Error("passkey.failed");
    try {
      const pk = (JSON.parse(options) as { publicKey?: Pk }).publicKey;
      if (pk && typeof pk === "object") return pk;
    } catch {
      /* below */
    }
    throw new Error("passkey.failed");
  }

  /** The key's PIN when the request wants user verification (a key without a PIN verifies nothing). */
  async #verify(uv: string | undefined, onEvent: (e: string) => void, step: (ms: number) => Promise<void>): Promise<void> {
    if (this.#pin === null || uv === "discouraged") return;
    let invalid = false;
    for (;;) {
      if (this.#retries === 0) {
        onEvent(JSON.stringify({ kind: "problem", problem: "pin_blocked" }));
        throw "passkey.failed";
      }
      onEvent(JSON.stringify({ kind: "pin", invalid, retries: invalid ? this.#retries : null }));
      const pin = await new Promise<string | null>((resolve) => (this.#waiting.pin = resolve));
      if (pin === null) throw "passkey.cancelled";
      await step(10);
      if (pin === this.#pin) {
        this.#retries = 8;
        return;
      }
      this.#retries -= 1;
      invalid = true;
    }
  }

  /** Runs a ceremony; a cancel ends it as cancelled wherever it waits. */
  #run(onDone: Done, body: (step: (ms: number) => Promise<void>) => Promise<unknown>): void {
    let cancelled = false;
    let wake: (() => void) | null = null;
    const step = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        if (cancelled) return reject("passkey.cancelled");
        const timer = setTimeout(resolve, ms);
        wake = () => {
          clearTimeout(timer);
          reject("passkey.cancelled");
        };
      });
    this.#cancel = () => {
      cancelled = true;
      this.pin(null);
      this.account(null);
      wake?.();
    };
    void body(step).then(
      (result) => {
        this.#cancel = null;
        onDone(null, JSON.stringify(result));
      },
      (e: unknown) => {
        this.#cancel = null;
        this.#waiting = {};
        onDone(cancelled ? "passkey.cancelled" : typeof e === "string" ? e : "passkey.failed", null);
      },
    );
  }
}
