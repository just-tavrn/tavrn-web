// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { api } from "../lib/api";
import { passkeyReauth, usePasskeyBlocker } from "../lib/passkeys";
import { startSso } from "../lib/sso";
import { describeError } from "../stores/toasts";
import { finishReauth, setReauth, useReauth } from "../stores/reauth";
import { useT } from "../i18n";
import { Button, Dialog, ErrorText, Field, Input } from "./ui";

/**
 * Confirmation for security-sensitive changes (PROTOCOL.md §5c): the password, a passkey or single sign-on. Opens
 * whenever the node answers `auth.reauth_required`; the refused request is repeated after a confirmation.
 */
export function ReauthDialog() {
  const t = useT();
  const pending = useReauth((s) => s.pending);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The browser, the Windows app (natively), the Linux app with a security key plugged in (looked for while the dialog
  // is open) and the Android app when the node accepts its origin.
  const inAppPasskey = usePasskeyBlocker(!!pending) === null;
  if (!pending) return null;
  const methods = pending.methods;
  const close = (ok: boolean) => {
    setPassword("");
    setError(null);
    finishReauth(ok);
  };
  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(describeError(e) || t("reauth.failed"));
    } finally {
      setBusy(false);
    }
  };
  const withPassword = () =>
    run(async () => {
      const r = await api.auth.reauth({ password });
      setReauth(r.reauth_token, r.expires_in);
      close(true);
    });
  const withPasskey = () =>
    run(async () => {
      const r = await passkeyReauth(api);
      // Only the confirmation is needed here, not the PRF output of the same assertion.
      r.prf?.fill(0);
      setReauth(r.reauth.reauth_token, r.reauth.expires_in);
      close(true);
    });
  const withSso = () =>
    run(async () => {
      // The provider's login replaces this page; the change has to be started again afterwards.
      close(false);
      await startSso(api, "reauth", `${location.pathname}${location.search}`);
    });
  return (
    <Dialog title={t("reauth.title")} open onClose={() => close(false)}>
      <div className="space-y-3" data-testid="reauth-dialog">
        <p className="text-sm text-fg-1">{t("reauth.hint")}</p>
        {methods.includes("password") && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void withPassword();
            }}
          >
            <Field label={t("auth.password")}>
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="reauth-password" required />
            </Field>
            <Button type="submit" disabled={busy || !password} data-testid="reauth-submit">
              {t("reauth.confirm")}
            </Button>
          </form>
        )}
        {methods.includes("webauthn") && inAppPasskey && (
          <Button variant="ghost" disabled={busy} onClick={() => void withPasskey()} data-testid="reauth-passkey">
            {t("reauth.passkey")}
          </Button>
        )}
        {methods.includes("sso") && (
          <Button variant="ghost" disabled={busy} onClick={() => void withSso()} data-testid="reauth-sso">
            {t("reauth.sso")}
          </Button>
        )}
        {methods.length === 0 && <p className="text-sm text-danger">{t("reauth.no_method")}</p>}
        <ErrorText>{error}</ErrorText>
        <button type="button" className="block min-h-9 text-sm text-fg-2 hover:text-fg-0" onClick={() => close(false)}>
          {t("common.cancel")}
        </button>
      </div>
    </Dialog>
  );
}
