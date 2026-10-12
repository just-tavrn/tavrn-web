// SPDX-License-Identifier: Apache-2.0
/**
 * Passkeys of the Linux app (docs/DESKTOP.md "Passkeys on Linux"), the Windows app's `passkey_create` and `passkey_get`
 * (`apps/desktop/src-tauri/src/passkey.rs`) for the Electron shell: the bundled client's origin (`app://tavrn`) can never
 * be under the node's relying party id, and Electron has no WebAuthn dialog on Linux, so the shell runs the ceremony with
 * FIDO2 security keys over USB itself, through the native module `native/passkeys` (Mozilla's CTAP2 library):
 *
 * - the client passes the node's options unchanged; the shell takes the **web origin of the node the app is connected
 *   to** from its settings (`web`, else the node URL; never the page's) and the module writes `clientDataJSON` with it,
 *   refusing a relying party id this origin does not belong to (`passkey.refused`);
 * - the answer is the credential as `PublicKeyCredential.toJSON()` and the PRF output apart (base64url), for the key
 *   store only;
 * - what the user has to do (touch the key, choose one of several keys or passkeys, enter the key's PIN) shows in the
 *   shell's own dialog (`passkey_window.ts`, `passkey_dialog.ts`): the PIN never passes through the web page, it goes
 *   from the dialog to the key's PIN protocol and is neither kept nor logged;
 * - one ceremony at a time; cancelling the dialog cancels the ceremony (`passkey.cancelled`).
 *
 * `passkeyStatus` tells the client whether the native path exists and how many keys are plugged in, so it offers
 * passkeys in the app while a key is there and the browser (any other passkey) otherwise.
 */
import { createRequire } from "node:module";
import type { Settings } from "./config.ts";
import { check, type ArgsCheck, type IpcRegistry } from "./ipc.ts";
import type { DialogAnswer, DialogView } from "./passkey_dialog.ts";

/** The error codes of the Windows app (the client turns them into the browser's DOMException names). */
export const CODES = ["passkey.cancelled", "passkey.exists", "passkey.refused", "passkey.unavailable", "passkey.failed"] as const;
export type PasskeyCode = (typeof CODES)[number];

/** The largest options document the shell passes on (the node's are a few hundred bytes). */
export const MAX_OPTIONS = 64 * 1024;

/** The native module (`native/passkeys`, `@tavrn/passkeys-native`), or a stand-in with the same functions. */
export interface PasskeyNative {
  available(): boolean;
  keys(): { present: number; usable: number };
  create(options: string, origin: string, onEvent: (event: string) => void, onDone: (error: string | null, result: string | null) => void): void;
  get(options: string, origin: string, onEvent: (event: string) => void, onDone: (error: string | null, result: string | null) => void): void;
  pin(pin: string | null): boolean;
  account(index: number | null): boolean;
  cancel(): void;
}

/** The module's events (`native/passkeys/src/lib.rs`). */
export type PasskeyEvent =
  | { kind: "touch" }
  | { kind: "select_key" }
  | { kind: "pin"; invalid: boolean; retries: number | null }
  | { kind: "accounts"; names: string[] }
  | { kind: "uv_invalid"; retries: number | null }
  | { kind: "problem"; problem: string };

/** What `passkeyStatus` answers (the client's `PasskeyStatus` in `electronBridge.ts`). */
export interface PasskeyStatus {
  /** The shell has the native path (the module loaded). */
  available: boolean;
  /** FIDO security keys plugged in. */
  present: number;
  /** Of those, the ones the app may open (udev access for the user of the seat). */
  usable: number;
}

/** The answer of a ceremony (the Windows app's `NativeResult`). */
export interface NativeResult {
  credential: Record<string, unknown>;
  prf: string | null;
}

export type Ceremony = "create" | "get";

/** The shell's dialog for one ceremony (`passkey_window.ts`). */
export interface PasskeyPrompt {
  /** Shows the dialog for a ceremony with the relying party `rp`; the user's answers go to `answer`. */
  open(ceremony: Ceremony, rp: string, answer: (a: DialogAnswer) => void): void;
  show(view: DialogView): void;
  /** The ceremony is over: the dialog closes, unless it shows a problem (then the user closes it). */
  done(): void;
}

const num = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255 ? (v as number) : null);

/** A module event, checked (anything else is dropped). */
export function parseEvent(json: string): PasskeyEvent | null {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (e?.kind) {
    case "touch":
    case "select_key":
      return { kind: e.kind };
    case "pin":
      return { kind: "pin", invalid: e.invalid === true, retries: num(e.retries) };
    case "uv_invalid":
      return { kind: "uv_invalid", retries: num(e.retries) };
    case "accounts":
      return Array.isArray(e.names) && e.names.length <= 64 ? { kind: "accounts", names: e.names.map((n) => (typeof n === "string" ? n.slice(0, 256) : "")) } : null;
    case "problem":
      return typeof e.problem === "string" ? { kind: "problem", problem: e.problem.slice(0, 64) } : null;
    default:
      return null;
  }
}

/** The dialog's view for a module event. */
export function viewOf(e: PasskeyEvent): DialogView {
  switch (e.kind) {
    case "touch":
      return { view: "touch" };
    case "select_key":
      return { view: "select_key" };
    case "pin":
      return { view: "pin", invalid: e.invalid, retries: e.retries, length: false };
    case "accounts":
      return { view: "accounts", names: e.names };
    case "uv_invalid":
      return { view: "uv_invalid", retries: e.retries };
    case "problem":
      return { view: "problem", problem: e.problem };
  }
}

/** A PIN the key's PIN protocol accepts: 4 to 63 bytes of UTF-8, at least 4 characters (CTAP 2.1 §6.5.5.7). */
export function validPin(pin: string): boolean {
  return [...pin].length >= 4 && Buffer.byteLength(pin, "utf8") <= 63;
}

/** A refusal of the module as one of the codes (anything else is `passkey.failed`). */
export function codeOf(e: unknown): PasskeyCode {
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  return (CODES as readonly string[]).includes(text) ? (text as PasskeyCode) : "passkey.failed";
}

/** The module's answer, checked: a credential with an id, a PRF output or null. */
export function parseResult(json: string | null): NativeResult {
  try {
    const r = JSON.parse(json ?? "") as { credential?: unknown; prf?: unknown };
    const c = r?.credential as Record<string, unknown> | undefined;
    if (!c || typeof c !== "object" || typeof c.id !== "string") throw new Error("no credential");
    return { credential: c, prf: typeof r.prf === "string" ? r.prf : null };
  } catch {
    throw "passkey.failed";
  }
}

/** The relying party the user is asked for (the dialog names it): the options' `rp.id` or `rpId`, else the origin's host. */
export function relyingParty(options: Record<string, unknown>, origin: string): string {
  const pk = (options.publicKey ?? {}) as { rp?: { id?: unknown }; rpId?: unknown };
  const rp = typeof pk.rp?.id === "string" ? pk.rp.id : typeof pk.rpId === "string" ? pk.rpId : null;
  if (rp) return rp.slice(0, 253);
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
}

/** The native module (copied to `dist/native/passkeys.node` by the build), or why there is none. */
export function nativePasskeyModule(file: string): PasskeyNative | { unavailable: string } {
  try {
    return createRequire(import.meta.url)(file) as PasskeyNative;
  } catch (e) {
    return { unavailable: `the passkeys module does not load (${file}): ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
  }
}

export interface PasskeysOptions {
  /** The module, or why there is none (the app runs without; the client keeps the browser for passkeys). */
  native: PasskeyNative | { unavailable: string };
  /** The node's web origin from the settings (`web`, else `node`), or null before a node is chosen. */
  origin: () => string | null;
  prompt: PasskeyPrompt;
  log?: (message: string) => void;
}

/** The ceremonies of the app, one at a time. */
export class Passkeys {
  readonly #native: PasskeyNative | null;
  readonly #origin: () => string | null;
  readonly #prompt: PasskeyPrompt;
  #busy = false;

  constructor(options: PasskeysOptions) {
    if ("unavailable" in options.native) {
      (options.log ?? ((m: string) => console.error(m)))(`tavrn: no native passkeys: ${options.native.unavailable}`);
      this.#native = null;
    } else {
      this.#native = options.native;
    }
    this.#origin = options.origin;
    this.#prompt = options.prompt;
  }

  /** Cancels a running ceremony (the app quits). */
  cancel(): void {
    if (this.#busy) this.#native?.cancel();
  }

  status(): PasskeyStatus {
    const native = this.#native;
    if (!native?.available()) return { available: false, present: 0, usable: 0 };
    const keys = native.keys();
    return { available: true, present: keys.present, usable: keys.usable };
  }

  /** Runs a ceremony with the node's (or the client's PRF) options; rejects with one of {@link CODES}. */
  run(ceremony: Ceremony, options: Record<string, unknown>): Promise<NativeResult> {
    const native = this.#native;
    if (!native?.available()) return Promise.reject("passkey.unavailable");
    const origin = this.#origin();
    if (!origin) return Promise.reject("passkey.refused");
    if (this.#busy) return Promise.reject("passkey.failed");
    const json = JSON.stringify(options);
    this.#busy = true;
    return new Promise<NativeResult>((resolve, reject) => {
      let over = false;
      const finish = (error: unknown, result: string | null) => {
        if (over) return;
        over = true;
        this.#busy = false;
        this.#prompt.done();
        if (error !== null) reject(codeOf(error));
        else {
          try {
            resolve(parseResult(result));
          } catch (e) {
            reject(e);
          }
        }
      };
      const answer = (a: DialogAnswer) => {
        if (over) return;
        if (a.type === "pin") {
          // A PIN the key would refuse is asked again at once; it never leaves the shell.
          if (validPin(a.pin)) native.pin(a.pin);
          else this.#prompt.show({ view: "pin", invalid: false, retries: null, length: true });
        } else if (a.type === "account") {
          native.account(a.index);
        } else {
          native.cancel();
        }
      };
      const onEvent = (raw: string) => {
        const event = parseEvent(raw);
        if (event && !over) this.#prompt.show(viewOf(event));
      };
      // Options the module refuses (bounds, a relying party outside the origin) never open the dialog. The module's
      // events and its answer arrive later (on the event loop), so the dialog is open before the first of them.
      try {
        native[ceremony](json, origin, onEvent, (error, result) => finish(error, result));
      } catch (e) {
        over = true;
        this.#busy = false;
        reject(codeOf(e));
        return;
      }
      this.#prompt.open(ceremony, relyingParty(options, origin), answer);
    });
  }
}

/** One plain object (structured-cloned from the page) of at most {@link MAX_OPTIONS} bytes as JSON, with `publicKey`. */
export function optionsCheck(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const pk = (value as { publicKey?: unknown }).publicKey;
  if (typeof pk !== "object" || pk === null || Array.isArray(pk)) return false;
  try {
    return JSON.stringify(value).length <= MAX_OPTIONS;
  } catch {
    return false;
  }
}

export interface PasskeyDeps {
  passkeys: Passkeys;
}

/** The `passkeys` namespace of the bridge (the Windows app's `passkey_create`, `passkey_get`; `passkeyStatus` for Linux). */
export function registerPasskeyHandlers(registry: IpcRegistry, deps: PasskeyDeps): void {
  const options: ArgsCheck = check.args([optionsCheck]);
  registry.handle("passkeys", "passkeyCreate", options, (o: Record<string, unknown>) => deps.passkeys.run("create", o));
  registry.handle("passkeys", "passkeyGet", options, (o: Record<string, unknown>) => deps.passkeys.run("get", o));
  registry.handle("passkeys", "passkeyStatus", check.args([]), () => deps.passkeys.status());
}

/** The origin a ceremony runs for: the node's web client from the settings, else the node (`openConnect` uses the same). */
export function settingsOrigin(settings: Settings): string | null {
  const { web, node } = settings.get();
  return web ?? node;
}
