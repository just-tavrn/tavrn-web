// SPDX-License-Identifier: Apache-2.0
/**
 * App sessions of the connect flow (FEDERATION.md §8 step 3, capability `connect.app`): how the desktop app signs in
 * on its node's own web client, where passkeys, single sign-on and the captcha work. The app keeps a PKCE verifier,
 * creates an app session with the challenge, opens `<web>/connect?session=…` (a window of the shell without any
 * native API, or the system browser), polls the session until the user confirmed there and exchanges the one-time
 * code with the verifier for a session of a new device. Device keys are created in the app afterwards, never by the
 * page.
 */
import { TavrnApiError, createPkce, randomUrlSafe, type AuthResponse, type DeviceProof, type TavrnApi } from "@tavrn/sdk";

/** The protocol allows a poll at most every 2 seconds. */
export const APP_SESSION_POLL_MS = 2000;

/** Capability of nodes that offer app sessions. */
export const APP_SESSION_CAPABILITY = "connect.app";

export type NodePageMode = "login" | "register";

/** `<web>/connect?session=…&state=…` (`mode=register` opens the page's registration). */
export function connectPageUrl(web: string, sessionId: string, state: string, mode: NodePageMode): string {
  const url = new URL(`${web.replace(/\/+$/, "")}/connect`);
  url.searchParams.set("session", sessionId);
  url.searchParams.set("state", state);
  if (mode === "register") url.searchParams.set("mode", "register");
  return url.toString();
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

/** Runs the sign-in on the node's page: the session of a new device, or null when cancelled. */
export async function runAppSession(run: AppSessionRun): Promise<AuthResponse | null> {
  const sleep = run.sleep ?? wait;
  const { verifier, challenge } = await createPkce();
  const created = await run.api.auth.createConnectSession({ code_challenge: challenge, device_name: run.deviceName });
  const url = connectPageUrl(run.web, created.session_id, randomUrlSafe(), run.mode ?? "login");
  try {
    await run.open(url);
    run.onPage?.(url);
    for (;;) {
      if (run.signal?.aborted) return null;
      await sleep(APP_SESSION_POLL_MS, run.signal);
      if (run.signal?.aborted) return null;
      let status;
      try {
        status = await run.api.auth.pollConnectSession(created.session_id);
      } catch (e) {
        // A network hiccup is not the end of the sign-in; the node's answers (410, 404, 429 …) are.
        if (e instanceof TavrnApiError) throw e;
        continue;
      }
      if (status.status !== "ready" || !status.code) continue;
      if (status.node !== run.domain) throw new Error(`The sign-in came from ${status.node ?? "an unknown node"}, not ${run.domain}`);
      const device = run.device ? await run.device().catch(() => null) : null;
      return await run.api.auth.connectToken({ code: status.code, code_verifier: verifier, device });
    }
  } finally {
    await run.close().catch(() => undefined);
  }
}
