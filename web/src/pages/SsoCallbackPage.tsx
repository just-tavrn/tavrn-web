// SPDX-License-Identifier: Apache-2.0
/**
 * `/sso/callback`: the node sends the browser here after the identity provider (APPLICATIONS.md §8.2).
 * Checks the state against this tab's pending flow and exchanges the one-time code and the PKCE verifier:
 * a login continues with the encryption step (recovery key on the first login; no second factor), a link
 * returns to the security settings, a reauth hands the token to the identity reset.
 */
import { deviceProofFor } from "../crypto/e2ee";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { AuthResponse, OidcReauth, OidcTokenResponse } from "@tavrn/sdk";
import { api, publicApi } from "../lib/api";
import { checkSsoCallback, setReauthToken, takePendingSso, type PendingSso } from "../lib/sso";
import { lastAccount, useAuth } from "../stores/auth";
import { useAuthFlow } from "../stores/authFlow";
import { describeError, useToasts } from "../stores/toasts";
import { errorMessage, useT } from "../i18n";
import { AuthCard } from "../components/auth/AuthCard";
import { ErrorText } from "../components/ui";

const isSession = (r: OidcTokenResponse): r is AuthResponse => "access_token" in r;
const isReauth = (r: OidcTokenResponse): r is OidcReauth => "reauth_token" in r;

export function SsoCallbackPage() {
  const t = useT();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // Taken once (React may run effects twice in development).
  const pending = useRef<PendingSso | null | undefined>(undefined);
  if (pending.current === undefined) pending.current = takePendingSso();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const flow = pending.current ?? null;
    const check = checkSsoCallback(params, flow);
    if (!check.ok || !flow) {
      if (!check.ok && check.error) {
        const idp = params.get("idp_error");
        setError(check.error === "sso.idp_error" && idp ? `${errorMessage(check.error, undefined)} (${idp})` : errorMessage(check.error, t("sso.failed")));
      } else setError(t("sso.state_mismatch"));
      return;
    }
    void (async () => {
      try {
        // Linking and reauth also need the session that started the flow.
        const client = flow.purpose === "login" ? publicApi : api;
        // Login: continue this browser's device of the last account (PROTOCOL.md §5b; a mismatch means a new device).
        const device = flow.purpose === "login" ? await deviceProofFor(publicApi, lastAccount()) : null;
        const resp = await client.oidc.token(check.code, flow.verifier, device);
        if (flow.purpose === "login" && isSession(resp)) {
          const authFlow = useAuthFlow.getState();
          authFlow.clearPreauth();
          authFlow.setSetup({ kind: "login" });
          useAuth.getState().setSession(resp);
          navigate(`/encryption?next=${encodeURIComponent(flow.next)}`, { replace: true });
        } else if (flow.purpose === "reauth" && isReauth(resp)) {
          setReauthToken(resp.reauth_token, resp.expires_in);
          navigate(flow.next, { replace: true });
        } else {
          useToasts.getState().push({ kind: "info", title: t("sso.linked_toast") });
          navigate(flow.next, { replace: true });
        }
      } catch (e) {
        setError(describeError(e));
      }
    })();
  }, [params, navigate, t]);

  return (
    <AuthCard>
      <h1 className="text-base font-semibold" data-testid="sso-callback-title">
        {t("sso.callback_title")}
      </h1>
      {!error && <p className="mt-2 text-sm text-fg-2">{t("auth.wait")}</p>}
      <div data-testid="sso-error">
        <ErrorText>{error}</ErrorText>
      </div>
      {error && (
        <Link to="/login" className="mt-3 block text-center text-sm text-accent hover:text-accent-hover" data-testid="sso-back">
          {t("connect.back_to_login")}
        </Link>
      )}
    </AuthCard>
  );
}
