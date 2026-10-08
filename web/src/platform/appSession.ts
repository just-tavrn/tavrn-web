// SPDX-License-Identifier: Apache-2.0
/**
 * App sessions of the connect flow (FEDERATION.md §8 step 3, capability `connect.app`): how the desktop app signs in
 * on its node's own web client, where passkeys, single sign-on and the captcha work. The app keeps a PKCE verifier,
 * creates an app session with the challenge, opens `<web>/connect?session=…` (a window of the shell without any
 * native API, or the system browser), polls the session until the user confirmed there and exchanges the one-time
 * code with the verifier for a session of a new device. Device keys are created in the app afterwards, never by the
 * page.
 *
 * Every handoff carries a fresh X25519 key in the page URL's fragment (`#k=`): after a passkey ceremony the page seals
 * the PRF output to it, and the app unlocks its key store with it like a browser does ("Sealed unlock material",
 * `crypto/sealedUnlock.ts`). An **unlock** session does only that for a signed-in app ({@link runAppUnlock}).
 */
import { TavrnApiError, createPkce, randomUrlSafe, type AuthResponse, type ConnectSessionStatus, type DeviceProof, type TavrnApi } from "@tavrn/sdk";
import { ensureCrypto } from "@tavrn/e2ee";
import { createUnlockKeyPair, unlockFragment, type UnlockKeyPair, type UnlockMaterial } from "../crypto/sealedUnlock";

/** The protocol allows a poll at most every 2 seconds. */
export const APP_SESSION_POLL_MS = 2000;

/** Capability of nodes that offer app sessions. */
export const APP_SESSION_CAPABILITY = "connect.app";

export type NodePageMode = "login" | "register";
/** A sign-in method the page starts at once (`method=`); registration keeps the older `mode=register`. */
export type NodePageMethod = "passkey" | "sso";

/**
 * `<web>/connect?session=…&state=…[&mode=register][&method=…][#k=<key>]` (`mode=register` opens the page's
 * registration, `method` starts one sign-in method at once, `k` is the app's key for sealed unlock material).
 */
export function connectPageUrl(web: string, sessionId: string, state: string, mode: NodePageMode, opts: { method?: NodePageMethod; key?: string } = {}): string {
  const url = new URL(`${web.replace(/\/+$/, "")}/connect`);
  url.searchParams.set("session", sessionId);
  url.searchParams.set("state", state);
  if (mode === "register") url.searchParams.set("mode", "register");
  else if (opts.method) url.searchParams.set("method", opts.method);
  if (opts.key) url.hash = unlockFragment(opts.key);
  return url.toString();
}

/** A fresh key pair for one handoff, or null when the crypto module cannot load (the app then asks for the recovery key). */
async function defaultKeys(): Promise<UnlockKeyPair | null> {
  try {
    await ensureCrypto();
    return createUnlockKeyPair();
  } catch {
    return null;
  }
}

/** A connect error the client raises itself (`errors.<code>` in the translations). */
function connectError(code: string, message: string): Error {
  return Object.assign(new Error(message), { problem: { code } });
}

export interface AppSessionRun {
  /** API client of the node (no session). */
  api: TavrnApi;
  /** Origin of the node's web client (`web` of its discovery document). */
  web: string;
  /** Identity domain of the node: the code must come from it. */
  domain: string;
  /** Name of the device the sign-in creates, shown on the page. */
  deviceName: string;
  mode?: NodePageMode;
  /** Starts this sign-in method on the page at once. */
  method?: NodePageMethod;
  /** Shows the page (the shell's window). */
  open: (url: string) => Promise<void>;
  /** Closes the page's window (when done or cancelled). */
  close: () => Promise<void>;
  /** The page's URL, for "open in the browser instead". */
  onPage?: (url: string) => void;
  /** A proof of this app's device of the last account (the exchange then continues that device). */
  device?: () => Promise<DeviceProof | null>;
  signal?: AbortSignal;
  /** Waits between polls (tests replace it). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The handoff's key pair for sealed unlock material (tests replace it). */
  keys?: () => Promise<UnlockKeyPair | null>;
}

/** A finished sign-in: the session of the new device and, after a passkey sign-in, what unlocks its key store. */
export interface AppSessionResult {
  session: AuthResponse;
  unlock: UnlockMaterial | null;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * After a finished handoff the sign-in window stays open this long (in the background: the app continues at once), so
 * the node's page in it can sign its own session out first (docs/DESKTOP.md "Signing in").
 */
export const APP_CLOSE_GRACE_MS = 4000;

/** Closes the page's window: at once after a cancel or an error, after {@link APP_CLOSE_GRACE_MS} when it is done. */
function closeWindow(run: AppSessionRun, done: boolean): Promise<void> | void {
  if (!done) return run.close().catch(() => undefined);
  void (async () => {
    await (run.sleep ?? wait)(APP_CLOSE_GRACE_MS, run.signal);
    await run.close().catch(() => undefined);
  })();
}

/** Polls until the session is ready (null when cancelled); network hiccups are retried, the node's answers are not. */
async function pollUntilReady(run: AppSessionRun, sessionId: string): Promise<ConnectSessionStatus | null> {
  const sleep = run.sleep ?? wait;
  for (;;) {
    if (run.signal?.aborted) return null;
    await sleep(APP_SESSION_POLL_MS, run.signal);
    if (run.signal?.aborted) return null;
    let status;
    try {
      status = await run.api.auth.pollConnectSession(sessionId);
    } catch (e) {
      // A network hiccup is not the end of the sign-in; the node's answers (410, 404, 429 …) are.
      if (e instanceof TavrnApiError) throw e;
      continue;
    }
    if (status.status !== "ready") continue;
    if (status.node !== run.domain) throw new Error(`The sign-in came from ${status.node ?? "an unknown node"}, not ${run.domain}`);
    return status;
  }
}

/** Runs the sign-in on the node's page: the session of a new device (and its unlock material), or null when cancelled. */
export async function runAppSession(run: AppSessionRun): Promise<AppSessionResult | null> {
  const { verifier, challenge } = await createPkce();
  const created = await run.api.auth.createConnectSession({ code_challenge: challenge, device_name: run.deviceName });
  const keys = await (run.keys ?? defaultKeys)();
  const url = connectPageUrl(run.web, created.session_id, randomUrlSafe(), run.mode ?? "login", { method: run.method, key: keys?.publicKey });
  let done = false;
  try {
    await run.open(url);
    run.onPage?.(url);
    for (;;) {
      const status = await pollUntilReady(run, created.session_id);
      if (!status) return null;
      if (!status.code) continue;
      // Material that does not open only means no passkey unlock: the recovery key remains.
      const unlock = status.sealed_unlock && keys ? keys.open(status.sealed_unlock, created.session_id) : null;
      const device = run.device ? await run.device().catch(() => null) : null;
      const session = await run.api.auth.connectToken({ code: status.code, code_verifier: verifier, device });
      done = true;
      return { session, unlock };
    }
  } finally {
    keys?.dispose();
    await closeWindow(run, done);
  }
}

/**
 * Passkey unlock of a signed-in app (an `unlock` session): `run.api` must carry the app's session. The page runs only
 * the passkey assertion and returns the sealed PRF output. Rejects with `connect.unlock_unsupported` when the node (or
 * the crypto module) cannot do it, checked before any window opens; null when cancelled.
 */
export async function runAppUnlock(run: Omit<AppSessionRun, "mode" | "method" | "device">): Promise<UnlockMaterial | null> {
  const { challenge } = await createPkce();
  const keys = await (run.keys ?? defaultKeys)();
  try {
    if (!keys) throw connectError("connect.unlock_unsupported", "No key for the sealed unlock material");
    const created = await run.api.auth.createConnectSession({ code_challenge: challenge, device_name: run.deviceName, purpose: "unlock" });
    // Nodes that know unlock sessions name the purpose; older ones would treat this as a sign-in.
    const first = await run.api.auth.pollConnectSession(created.session_id);
    if (first.purpose !== "unlock") throw connectError("connect.unlock_unsupported", "The node has no unlock sessions");
    const url = connectPageUrl(run.web, created.session_id, randomUrlSafe(), "login", { method: "passkey", key: keys.publicKey });
    let done = false;
    try {
      await run.open(url);
      run.onPage?.(url);
      const status = await pollUntilReady(run, created.session_id);
      if (!status) return null;
      const material = status.sealed_unlock ? keys.open(status.sealed_unlock, created.session_id) : null;
      if (!material) throw connectError("connect.unlock_failed", "The unlock material did not open");
      done = true;
      return material;
    } finally {
      await closeWindow(run, done);
    }
  } finally {
    keys?.dispose();
  }
}
