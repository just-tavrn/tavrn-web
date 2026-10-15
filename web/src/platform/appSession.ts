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
import type { PlatformAuth } from "./types";

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

/**
 * The handoff the app waits for: its session id and the `state` of the page URL. The browser's "back to the app" link
 * (`tavrn://connect?session=…&state=…`, `deepLinks.ts`) wakes it: the app polls at once instead of waiting for its
 * timer, which a phone may have held back while the browser was in front. Nothing else happens: the code still comes
 * from the node and is exchanged with the verifier.
 */
interface Pending {
  session: string;
  state: string;
  wake: () => void;
}

let pending: Pending | null = null;

/** Wakes the waiting sign-in or unlock when `session` and `state` are its own; false otherwise (an old or foreign link). */
export function nudgeAppSession(session: string, state: string): boolean {
  if (!pending || pending.session !== session || pending.state !== state) return false;
  pending.wake();
  return true;
}

/** Registers the handoff while `fn` runs; its waits end early when the handoff is nudged. */
async function whilePending<T>(session: string, state: string, fn: (rearm: () => AbortSignal) => Promise<T>): Promise<T> {
  let controller = new AbortController();
  const rearm = () => {
    controller = new AbortController();
    return controller.signal;
  };
  const me: Pending = { session, state, wake: () => controller.abort() };
  pending = me;
  try {
    return await fn(rearm);
  } finally {
    if (pending === me) pending = null;
  }
}

/** A signal that ends when either does. */
function either(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const both = new AbortController();
  const end = () => both.abort();
  for (const s of [a, b]) {
    if (s.aborted) end();
    else s.addEventListener("abort", end, { once: true });
  }
  return both.signal;
}

/** Polls until the session is ready (null when cancelled); network hiccups are retried, the node's answers are not. */
async function pollUntilReady(run: AppSessionRun, sessionId: string, rearm: () => AbortSignal = () => new AbortController().signal): Promise<ConnectSessionStatus | null> {
  const sleep = run.sleep ?? wait;
  let lastPoll = 0;
  for (;;) {
    if (run.signal?.aborted) return null;
    // A nudge ends the wait, but never makes the polls closer than the protocol allows.
    const nudge = rearm();
    await sleep(APP_SESSION_POLL_MS, either(run.signal, nudge));
    const early = APP_SESSION_POLL_MS - (Date.now() - lastPoll);
    if (nudge.aborted && lastPoll && early > 0) await sleep(early, run.signal);
    if (run.signal?.aborted) return null;
    lastPoll = Date.now();
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
  const state = randomUrlSafe();
  const url = connectPageUrl(run.web, created.session_id, state, run.mode ?? "login", { method: run.method, key: keys?.publicKey });
  let done = false;
  try {
    await run.open(url);
    run.onPage?.(url);
    return await whilePending(created.session_id, state, async (rearm) => {
      for (;;) {
        const status = await pollUntilReady(run, created.session_id, rearm);
        if (!status) return null;
        if (!status.code) continue;
        // Material that does not open only means no passkey unlock: the recovery key remains.
        const unlock = status.sealed_unlock && keys ? keys.open(status.sealed_unlock, created.session_id) : null;
        const device = run.device ? await run.device().catch(() => null) : null;
        const session = await run.api.auth.connectToken({ code: status.code, code_verifier: verifier, device });
        done = true;
        return { session, unlock };
      }
    });
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
    const state = randomUrlSafe();
    const url = connectPageUrl(run.web, created.session_id, state, "login", { method: "passkey", key: keys.publicKey });
    let done = false;
    try {
      await run.open(url);
      run.onPage?.(url);
      const status = await whilePending(created.session_id, state, (rearm) => pollUntilReady(run, created.session_id, rearm));
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

/**
 * The shells' sign-in and unlock on the node's page (`PlatformAuth` of `tauri.ts` and `electron.ts`): the page in a
 * window of the shell without any native API (FEDERATION.md §8 step 3, docs/DESKTOP.md); `open` and `close` are the
 * shell's window commands.
 */
export function nodePageAuth(o: { deviceName: string; open: (url: string) => Promise<void>; close: () => Promise<void> }): Required<PlatformAuth> {
  return {
    signInOnNodePage: (req) =>
      runAppSession({
        api: req.api,
        web: req.endpoints.web,
        domain: req.endpoints.domain,
        deviceName: o.deviceName,
        mode: req.mode,
        method: req.method,
        open: o.open,
        close: o.close,
        onPage: req.onPage,
        device: req.device,
        signal: req.signal,
      }),
    // Passkey unlock of the signed-in app: the same window, an unlock session (FEDERATION.md §8 step 3).
    unlockOnNodePage: (req) =>
      runAppUnlock({
        api: req.api,
        web: req.endpoints.web,
        domain: req.endpoints.domain,
        deviceName: o.deviceName,
        open: o.open,
        close: o.close,
        onPage: req.onPage,
        signal: req.signal,
      }),
    reopen: o.open,
  };
}
