// SPDX-License-Identifier: Apache-2.0
/**
 * Desktop app: signing in on the node's own web client (docs/DESKTOP.md "Signing in", FEDERATION.md §8 step 3).
 * Passkeys, single sign-on and the captcha cannot run in the app (its origin is not the node's), so the app opens the
 * node's `/connect` page with an app session in a window of its own (or the system browser) and waits until the user
 * confirmed there. Offered while the node announces `connect.app`; otherwise the app keeps password and TOTP.
 * A button for a passkey or single sign-on starts that method on the page at once (`method=`); a passkey sign-in there
 * hands its sealed unlock material back with the session, which unlocks the key store like a browser login.
 */
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AuthResponse } from "@tavrn/sdk";
import { api, publicApi } from "../../lib/api";
import type { UnlockMaterial } from "../../crypto/sealedUnlock";
import { deviceProofFor } from "../../crypto/e2ee";
import { lastAccount } from "../../stores/auth";
import { describeError } from "../../stores/toasts";
import { useT } from "../../i18n";
import { originHost, originUrl, originWsUrl, platform, webOrigin } from "../../platform";
import type { NodePageMethod, NodePageMode } from "../../platform";
import { APP_SESSION_CAPABILITY } from "../../platform/appSession";
import { Button, ErrorText } from "../ui";

interface Run {
  mode: NodePageMode;
  method?: NodePageMethod;
  url: string | null;
  error: string | null;
  controller: AbortController;
}

/** WebKitGTK (the Linux webview) has no WebAuthn: passkeys need the system browser there. */
function linuxWebview(): boolean {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /Linux/.test(ua) && !/Android/.test(ua);
}

/** The Android app shows the node's page in the browser (a Custom Tab), not in a window: its own texts. */
const inBrowser = (key: string) => (platform().android ? `${key}_android` : key);

export interface NodePageHandoff {
  /** The app can sign in on the node's page (desktop app, node with `connect.app`). */
  available: boolean;
  /** The node's identity domain, for the buttons. */
  domain: string;
  start: (mode: NodePageMode, method?: NodePageMethod) => void;
  /** The waiting panel while a sign-in runs, else null. */
  view: React.ReactNode;
}

/** A passkey sign-in's credential and PRF output (sealed by the page for this app), for the encryption step. */
export type HandoffPasskey = { credentialId: string; prf: Uint8Array };

export function useNodePageHandoff({ next, onSession }: { next: string; onSession: (session: AuthResponse, passkey?: HandoffPasskey) => void }): NodePageHandoff {
  const t = useT();
  const desktop = platform().isDesktop && !!platform().auth;
  const doc = useQuery({ queryKey: ["node", "well-known"], queryFn: () => publicApi.node.wellKnown(), enabled: desktop, retry: false, staleTime: 60_000 });
  const available = desktop && !!doc.data?.capabilities?.includes(APP_SESSION_CAPABILITY);
  const domain = doc.data?.domain ?? originHost();
  const [run, setRun] = useState<Run | null>(null);
  const current = useRef<AbortController | null>(null);

  const start = (mode: NodePageMode, method?: NodePageMethod) => {
    const auth = platform().auth;
    if (!auth) return;
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setRun({ mode, method, url: null, error: null, controller });
    const mine = (r: Run | null) => r?.controller === controller;
    void auth
      .signInOnNodePage({
        api: publicApi,
        endpoints: { domain, base: originUrl(), ws: originWsUrl(), web: webOrigin() },
        next,
        mode,
        method,
        device: () => deviceProofFor(publicApi, lastAccount()),
        signal: controller.signal,
        onPage: (url) => setRun((r) => (mine(r) ? { ...r!, url } : r)),
      })
      .then((result) => {
        if (controller.signal.aborted) {
          result?.unlock?.prf.fill(0);
          return;
        }
        setRun((r) => (mine(r) ? null : r));
        if (result) onSession(result.session, result.unlock ?? undefined);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setRun((r) => (mine(r) ? { ...r!, error: describeError(e) } : r));
      });
  };

  const cancel = () => {
    run?.controller.abort();
    setRun(null);
  };

  const view = run ? (
    <div data-testid="handoff-waiting">
      <h1 className="text-base font-semibold">{t(run.method === "passkey" ? "handoff.waiting_passkey_title" : run.method === "sso" ? "handoff.waiting_sso_title" : "handoff.waiting_title", { node: domain })}</h1>
      <p className="mt-2 text-sm text-fg-1">{t(inBrowser(run.method === "passkey" ? "handoff.waiting_passkey" : run.method === "sso" ? "handoff.waiting_sso" : "handoff.waiting"))}</p>
      {linuxWebview() && (
        <p className="mt-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg-1" data-testid="handoff-linux">
          {t("handoff.linux")}
        </p>
      )}
      <div className="mt-3">
        <ErrorText>{run.error}</ErrorText>
      </div>
      <div className="mt-4 flex flex-col gap-2">
        {run.error ? (
          <Button className="w-full" onClick={() => start(run.mode, run.method)}>
            {t("handoff.retry")}
          </Button>
        ) : (
          <PageButtons url={run.url} onCancel={cancel} />
        )}
        {run.error && (
          <Button variant="ghost" className="w-full" onClick={cancel}>
            {t("connect.cancel")}
          </Button>
        )}
      </div>
    </div>
  ) : null;

  return { available, domain, start, view };
}

/** The page's buttons while a window of the node's page is open: open it again, in the browser instead, cancel. */
function PageButtons({ url, onCancel }: { url: string | null; onCancel: () => void }) {
  const t = useT();
  return (
    <>
      <Button className="w-full" disabled={!url} onClick={() => url && void platform().auth?.reopen?.(url).catch(() => undefined)}>
        {t("handoff.reopen")}
      </Button>
      {!platform().android && (
        <Button variant="ghost" className="w-full border border-line" disabled={!url} onClick={() => url && void platform().openExternal(url).catch(() => undefined)}>
        {t("handoff.browser")}
      </Button>
      )}
      <Button variant="ghost" className="w-full" onClick={onCancel}>
        {t("connect.cancel")}
      </Button>
    </>
  );
}

export interface NodePageUnlock {
  /** The app can unlock with a passkey on the node's page (desktop app, node with `connect.app`). */
  available: boolean;
  /** Opens the page; `onMaterial` gets the opened unlock material (the caller unlocks with it). */
  start: (onMaterial: (material: UnlockMaterial) => void) => void;
  /** The waiting panel while the page is open, else null. */
  view: React.ReactNode;
  /** Why the last attempt failed (the node lacks unlock sessions, the window was refused …). */
  error: string | null;
}

/**
 * Desktop app, signed in but locked: "Unlock with a passkey" runs the passkey on the node's page in an unlock session
 * (FEDERATION.md §8 step 3); the page seals the PRF output to this app's key and the app unlocks as a browser would.
 */
export function useNodePageUnlock(): NodePageUnlock {
  const t = useT();
  const desktop = platform().isDesktop && !!platform().auth?.unlockOnNodePage;
  const doc = useQuery({ queryKey: ["node", "well-known"], queryFn: () => publicApi.node.wellKnown(), enabled: desktop, retry: false, staleTime: 60_000 });
  const available = desktop && !!doc.data?.capabilities?.includes(APP_SESSION_CAPABILITY);
  const domain = doc.data?.domain ?? originHost();
  const [run, setRun] = useState<{ url: string | null; controller: AbortController } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = (onMaterial: (material: UnlockMaterial) => void) => {
    const unlock = platform().auth?.unlockOnNodePage;
    if (!unlock) return;
    run?.controller.abort();
    const controller = new AbortController();
    const mine = (r: { controller: AbortController } | null) => r?.controller === controller;
    setError(null);
    setRun({ url: null, controller });
    void unlock({
      api,
      endpoints: { domain, base: originUrl(), ws: originWsUrl(), web: webOrigin() },
      signal: controller.signal,
      onPage: (url) => setRun((r) => (mine(r) ? { ...r!, url } : r)),
    })
      .then((material) => {
        setRun((r) => (mine(r) ? null : r));
        if (!material) return;
        if (controller.signal.aborted) material.prf.fill(0);
        else onMaterial(material);
      })
      .catch((e: unknown) => {
        setRun((r) => (mine(r) ? null : r));
        if (!controller.signal.aborted) setError(describeError(e));
      });
  };

  const cancel = () => {
    run?.controller.abort();
    setRun(null);
  };

  const view = run ? (
    <div data-testid="unlock-waiting" className="space-y-3">
      <h2 className="text-sm font-semibold">{t("handoff.unlock_title", { node: domain })}</h2>
      <p className="text-sm text-fg-1">{t(inBrowser("handoff.unlock_waiting"))}</p>
      {linuxWebview() && (
        <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg-1" data-testid="handoff-linux">
          {t("handoff.linux")}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <PageButtons url={run.url} onCancel={cancel} />
      </div>
    </div>
  ) : null;

  return { available, start, view, error };
}

/** The node checks this step with a captcha: the step happens on the node's page. */
export function NodePageRequired({ handoff, mode }: { handoff: NodePageHandoff; mode: NodePageMode }) {
  const t = useT();
  return (
    <div className="mt-4 space-y-3" data-testid="node-page-required">
      <p className="rounded-md border border-line bg-bg-0 px-3 py-2 text-sm text-fg-1">{t(mode === "register" ? "handoff.captcha_register" : "handoff.captcha_login", { node: handoff.domain })}</p>
      <Button className="w-full" onClick={() => handoff.start(mode)}>
        {t(mode === "register" ? "handoff.register" : "handoff.signin", { node: handoff.domain })}
      </Button>
    </div>
  );
}
