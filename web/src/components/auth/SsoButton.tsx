// SPDX-License-Identifier: Apache-2.0
/**
 * Single sign-on on the login page (APPLICATIONS.md §8): the provider button, the SSO-only variant of
 * the page (`TAVRN_OIDC_ONLY`, with the operators' break-glass sign-in) and the "also sign out at the
 * provider" offer after a logout.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SsoInfo } from "@tavrn/sdk";
import { publicApi } from "../../lib/api";
import { forgetSsoLogout, peekSsoLogout, startSso } from "../../lib/sso";
import { useT } from "../../i18n";
import { describeError } from "../../stores/toasts";
import { Button, ErrorText } from "../ui";
import { AuthCard } from "./AuthCard";

/** The node's SSO settings (`GET /node`), null without a provider. */
export function useSso(): SsoInfo | null {
  const node = useQuery({ queryKey: ["node", "origin"], queryFn: () => publicApi.node.info() });
  return node.data?.sso ?? null;
}

/** "Sign in with SSO" plus a divider; renders nothing on nodes without a provider. */
export function SsoButton({ next, divider = true }: { next: string; divider?: boolean }) {
  const t = useT();
  const sso = useSso();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logoutUrl, setLogoutUrl] = useState(() => peekSsoLogout());
  if (!sso) return null;
  const label = sso.label || t("sso.button");
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await startSso(publicApi, "login", next);
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3" data-testid="sso">
      {logoutUrl && (
        <p className="rounded-md border border-line bg-bg-0 px-3 py-2 text-xs text-fg-1" data-testid="sso-logout">
          {t("sso.signed_out")}{" "}
          <a
            href={logoutUrl}
            className="text-accent hover:text-accent-hover hover:underline"
            onClick={() => {
              forgetSsoLogout();
              setLogoutUrl(null);
            }}
          >
            {t("sso.provider_logout")}
          </a>
        </p>
      )}
      <Button className="w-full" disabled={busy} onClick={() => void go()} data-testid="sso-button">
        {busy ? t("auth.wait") : label}
      </Button>
      <ErrorText>{error}</ErrorText>
      {divider && (
        <div className="flex items-center gap-3 text-xs text-fg-2" aria-hidden="true">
          <span className="h-px flex-1 bg-line" />
          {t("sso.or")}
          <span className="h-px flex-1 bg-line" />
        </div>
      )}
    </div>
  );
}

/**
 * `TAVRN_OIDC_ONLY`: the login page shows only the provider. Operators listed in `TAVRN_ADMIN_USERS`
 * open the password form with "Administrator sign-in" (break-glass when the provider is down).
 */
export function SsoOnlyLogin({ next, onAdmin }: { next: string; onAdmin: () => void }) {
  const t = useT();
  return (
    <AuthCard>
      <p className="mb-4 text-sm text-fg-1" data-testid="sso-only">
        {t("sso.only_hint")}
      </p>
      <SsoButton next={next} divider={false} />
      <button type="button" className="mt-4 block min-h-9 w-full border-t border-line pt-3 text-center text-sm text-fg-2 hover:text-fg-0" onClick={onAdmin} data-testid="sso-break-glass">
        {t("sso.admin_login")}
      </button>
    </AuthCard>
  );
}
