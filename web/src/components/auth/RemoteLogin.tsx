// SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from "react";
import { parseAccountInput, type AuthResponse, type NodeEndpoints, type PreAuthResponse } from "@tavrn/sdk";
import { useT } from "../../i18n";
import { describeError } from "../../stores/toasts";
import { endpointsOf } from "../../stores/nodes";
import { useOriginDomain } from "../../lib/origin";
import { homeClient, startConnect } from "../../lib/remoteSignIn";
import { Button, ErrorText, Field, Input } from "../ui";
import { deviceProofFor } from "../../crypto/e2ee";
import { SecondFactorVerify } from "./SecondFactorVerify";

const DEVICE_NAME = "Browser";

/**
 * "Sign in with an account of another node" (FEDERATION.md §8): address → discovery of the home node →
 * direct flow (password + TOTP or recovery code against the home node's API) or connect flow (the home
 * node's own web client, for passkeys and everything that cannot run cross-origin).
 */
export function RemoteLogin({ next, onSession, onCancel }: { next: string; onSession: (session: AuthResponse, endpoints: NodeEndpoints) => Promise<void>; onCancel: () => void }) {
  const t = useT();
  const origin = useOriginDomain();
  const [address, setAddress] = useState("");
  const [endpoints, setEndpoints] = useState<NodeEndpoints | null>(null);
  const [password, setPassword] = useState("");
  /** Username typed after discovery when only the identity domain was entered (`tavrn.org`). */
  const [username, setUsername] = useState("");
  const [preauth, setPreauth] = useState<PreAuthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const parsed = parseAccountInput(address);
  const user = parsed?.username ?? username.trim().toLowerCase();
  const home = useMemo(() => (endpoints ? homeClient(endpoints) : null), [endpoints]);

  const discover = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!parsed) return setError(t("auth.remote_address_invalid"));
    if (parsed.domain === origin) return setError(t("auth.remote_same_node"));
    setBusy(t("auth.remote_discovering", { domain: parsed.domain }));
    try {
      setEndpoints(await endpointsOf(parsed.domain));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const loginWithPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!home || !parsed || !endpoints || !user) return;
    setError(null);
    setBusy(t("auth.wait"));
    try {
      // Continue this browser's device of that account if it has one (PROTOCOL.md §5b). The address always
      // carries the identity domain, wherever the node's API lives (design note 4.2c).
      const device = await deviceProofFor(home, `${user}@${endpoints.domain}`);
      const resp = await home.auth.login({ username: user, password, device_name: DEVICE_NAME, device });
      setPassword("");
      if (resp.status === "enrollment_required") setError(t("auth.remote_enroll_needed", { domain: endpoints.domain }));
      else setPreauth(resp);
    } catch (err) {
      setError(describeError(err) || t("auth.failed"));
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    if (!endpoints) return;
    setBusy(t("auth.wait"));
    try {
      location.assign(await startConnect(endpoints, next, parsed ? `${parsed.username}@${endpoints.domain}` : undefined));
    } catch (err) {
      setError(describeError(err));
      setBusy(null);
    }
  };

  const reset = () => {
    setEndpoints(null);
    setPreauth(null);
    setPassword("");
    setUsername("");
    setError(null);
  };

  if (!endpoints || !parsed) {
    return (
      <form onSubmit={discover} className="space-y-3" data-testid="remote-login">
        <h2 className="text-base font-semibold">{t("auth.remote_title")}</h2>
        <Field label={t("auth.remote_address")} hint={t("auth.remote_address_hint")}>
          <Input name="address" autoComplete="username" inputMode="email" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="alice@home.example" required autoFocus />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" className="w-full" disabled={!!busy}>
          {busy ?? t("auth.remote_continue")}
        </Button>
        <button type="button" className="block min-h-9 w-full text-center text-sm text-fg-2 hover:text-fg-0" onClick={onCancel}>
          {t("common.back")}
        </button>
      </form>
    );
  }

  // Passkeys are bound to the home domain; on this origin only TOTP and recovery codes work.
  const methods = (preauth?.methods ?? []).filter((m) => m !== "webauthn");
  return (
    <div className="space-y-3" data-testid="remote-login">
      <div className="rounded-md border border-line bg-bg-0 px-3 py-2">
        <p className="text-sm font-semibold" data-testid="remote-home">
          {t("auth.remote_home", { domain: endpoints.domain })}
        </p>
        <p className="break-all text-xs text-fg-2" data-testid="remote-account">
          {user ? `${user}@${endpoints.domain}` : endpoints.domain}
        </p>
      </div>
      <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg-1" data-testid="remote-warning">
        {t("auth.remote_warning", { origin: origin ?? location.host, domain: endpoints.domain })}
      </p>
      {preauth ? (
        methods.length ? (
          <SecondFactorVerify api={home!} preauthToken={preauth.preauth_token} methods={methods} onCancel={reset} onSession={(r) => void onSession(r.session, endpoints).catch((e: unknown) => setError(describeError(e)))} />
        ) : (
          <p className="text-sm text-fg-1">{t("auth.remote_passkey_only", { domain: endpoints.domain })}</p>
        )
      ) : (
        <form onSubmit={loginWithPassword} className="space-y-3">
          {parsed.username === null && (
            <Field label={t("auth.username")}>
              <Input name="remote_username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
            </Field>
          )}
          <Field label={t("auth.password")}>
            <Input name="remote_password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Button type="submit" className="w-full" disabled={!!busy || !password || !user}>
            {busy ?? t("auth.remote_password")}
          </Button>
        </form>
      )}
      <ErrorText>{error}</ErrorText>
      <div className="space-y-1 border-t border-line pt-3">
        <Button variant="ghost" className="w-full border border-line" disabled={!!busy} onClick={() => void connect()} data-testid="remote-connect">
          {t("auth.remote_connect", { domain: endpoints.domain })}
        </Button>
        <p className="text-xs text-fg-2">{t("auth.remote_connect_hint", { domain: endpoints.domain })}</p>
      </div>
      <button type="button" className="block min-h-9 w-full text-center text-sm text-fg-2 hover:text-fg-0" onClick={reset}>
        {t("auth.remote_back")}
      </button>
    </div>
  );
}
