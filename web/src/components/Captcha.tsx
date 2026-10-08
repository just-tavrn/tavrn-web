// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from "react";
import { platform } from "../platform";
import { useT } from "../i18n";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void; "expired-callback"?: () => void; "error-callback"?: () => void; theme?: string; language?: string }) => string;
      reset: (id?: string) => void;
      remove: (id: string) => void;
    };
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise: Promise<void> | null = null;

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SCRIPT_SRC;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scriptPromise = null;
        reject(new Error("The captcha script could not be loaded"));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

/**
 * Cloudflare Turnstile widget. Delivers the token via `onToken`; changing `resetKey` resets the widget
 * (e.g. after a failed login, because tokens are valid only once).
 */
export function Captcha(props: { siteKey: string; onToken: (token: string | null) => void; resetKey?: number }) {
  // The desktop app loads no third-party scripts (CSP script-src 'self') and the widget is bound to the node's host.
  if (platform().isDesktop) return <DesktopCaptchaNotice />;
  return <Turnstile {...props} />;
}

function DesktopCaptchaNotice() {
  const t = useT();
  return (
    <p role="status" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg-1" data-testid="captcha-desktop">
      {t("desktop.captcha_unavailable")}
    </p>
  );
}

function Turnstile({ siteKey, onToken, resetKey = 0 }: { siteKey: string; onToken: (token: string | null) => void; resetKey?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const tokenCb = useRef(onToken);
  tokenCb.current = onToken;

  useEffect(() => {
    let cancelled = false;
    void loadTurnstile()
      .then(() => {
        if (cancelled || !ref.current || !window.turnstile) return;
        widgetId.current = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          theme: "dark",
          language: "de",
          callback: (token) => tokenCb.current(token),
          "expired-callback": () => tokenCb.current(null),
          "error-callback": () => tokenCb.current(null),
        });
      })
      .catch(() => tokenCb.current(null));
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetKey > 0 && widgetId.current && window.turnstile) {
      window.turnstile.reset(widgetId.current);
      tokenCb.current(null);
    }
  }, [resetKey]);

  return <div ref={ref} data-testid="captcha" className="min-h-[65px]" />;
}
