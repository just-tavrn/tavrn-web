// SPDX-License-Identifier: Apache-2.0
/**
 * Desktop app: signing in on the node's own web client (docs/DESKTOP.md "Signing in", FEDERATION.md §8 step 3).
 * Passkeys, single sign-on and the captcha cannot run in the app (its origin is not the node's), so the app opens the
 * node's `/connect` page with an app session in a window of its own (or the system browser) and waits until the user
 * confirmed there. Offered while the node announces `connect.app`; otherwise the app keeps password and TOTP.
 */
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AuthResponse } from "@tavrn/sdk";
import { publicApi } from "../../lib/api";
import { deviceProofFor } from "../../crypto/e2ee";
import { lastAccount } from "../../stores/auth";
import { describeError } from "../../stores/toasts";
import { useT } from "../../i18n";
import { originHost, originUrl, originWsUrl, platform, webOrigin } from "../../platform";
import type { NodePageMode } from "../../platform";
import { APP_SESSION_CAPABILITY } from "../../platform/appSession";
import { Button, ErrorText } from "../ui";

interface Run {
  mode: NodePageMode;
  url: string | null;
  error: string | null;
  controller: AbortController;
}

/** WebKitGTK (the Linux webview) has no WebAuthn: passkeys need the system browser there. */
function linuxWebview(): boolean {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /Linux/.test(ua) && !/Android/.test(ua);
}

export interface NodePageHandoff {
  /** The app can sign in on the node's page (desktop app, node with `connect.app`). */
  available: boolean;
  /** The node's identity domain, for the buttons. */
  domain: string;
  start: (mode: NodePageMode) => void;
  /** The waiting panel while a sign-in runs, else null. */
  view: React.ReactNode;
}

export function useNodePageHandoff({ next, onSession }: { next: string; onSession: (session: AuthResponse) => void }): NodePageHandoff {
  const t = useT();
  const desktop = platform().isDesktop && !!platform().auth;
  const doc = useQuery({ queryKey: ["node", "well-known"], queryFn: () => publicApi.node.wellKnown(), enabled: desktop, retry: false, staleTime: 60_000 });
  const available = desktop && !!doc.data?.capabilities?.includes(APP_SESSION_CAPABILITY);
  const domain = doc.data?.domain ?? originHost();
  const [run, setRun] = useState<Run | null>(null);
  const current = useRef<AbortController | null>(null);

  const start = (mode: NodePageMode) => {
    const auth = platform().auth;
    if (!auth) return;
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setRun({ mode, url: null, error: null, controller });
    const mine = (r: Run | null) => r?.controller === controller;
    void auth
      .signInOnNodePage({
        api: publicApi,
        endpoints: { domain, base: originUrl(), ws: originWsUrl(), web: webOrigin() },
        next,
        mode,
        device: () => deviceProofFor(publicApi, lastAccount()),
        signal: controller.signal,
        onPage: (url) => setRun((r) => (mine(r) ? { ...r!, url } : r)),
      })
      .then((session) => {
        if (controller.signal.aborted) return;
        setRun((r) => (mine(r) ? null : r));
        if (session) onSession(session);
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
      <h1 className="text-base font-semibold">{t("handoff.waiting_title", { node: domain })}</h1>
      <p className="mt-2 text-sm text-fg-1">{t("handoff.waiting")}</p>
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
          <Button className="w-full" onClick={() => start(run.mode)}>
            {t("handoff.retry")}
          </Button>
        ) : (
          <>
            <Button className="w-full" disabled={!run.url} onClick={() => run.url && void platform().auth?.reopen?.(run.url).catch(() => undefined)}>
              {t("handoff.reopen")}
            </Button>
            <Button variant="ghost" className="w-full border border-line" disabled={!run.url} onClick={() => run.url && void platform().openExternal(run.url).catch(() => undefined)}>
              {t("handoff.browser")}
            </Button>
          </>
        )}
        <Button variant="ghost" className="w-full" onClick={cancel}>
          {t("connect.cancel")}
        </Button>
      </div>
    </div>
  ) : null;

  return { available, domain, start, view };
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
