// SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { TavrnApiError, type AuthResponse, type PreAuthResponse } from "@tavrn/sdk";
import { publicApi } from "../lib/api";
import { completeRemoteSignIn } from "../lib/remoteSignIn";
import { afterSignIn } from "./ConnectPages";
import { RemoteLogin } from "../components/auth/RemoteLogin";
import { lastAccount, useAuth } from "../stores/auth";
import { useAuthFlow, type FlowKind } from "../stores/authFlow";
import { describeError, useToasts } from "../stores/toasts";
import { useT } from "../i18n";
import { deviceProofFor, rememberPrf } from "../crypto/e2ee";
import { passkeyLogin, passkeysSupported } from "../lib/passkeys";
import { Button, ErrorText, Field, Input } from "../components/ui";
import { tabListKeyDown } from "../lib/a11y";
import { Captcha } from "../components/Captcha";
import { AuthCard } from "../components/auth/AuthCard";
import { Steps } from "../components/auth/Steps";
import { SecondFactorEnroll, type EnrollResult } from "../components/auth/SecondFactorEnroll";
import { SecondFactorVerify } from "../components/auth/SecondFactorVerify";
import { RecoveryCodesView } from "../components/auth/RecoveryCodes";
import { SsoButton, SsoOnlyLogin } from "../components/auth/SsoButton";
import { deviceName } from "../platform";

type Mode = "login" | "register";


/**
 * Sign-in and registration (PROTOCOL.md §5a.5): password step, then the second factor (enrollment for
 * new accounts, verification otherwise), recovery codes once, then `/encryption` for the recovery key
 * or unlocking. The pre-auth token survives a reload through sessionStorage.
 */
export function LoginPage() {
  const t = useT();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = useAuth((s) => s.token);
  const setSession = useAuth((s) => s.setSession);
  const preauth = useAuthFlow((s) => s.preauth);
  const setup = useAuthFlow((s) => s.setup);
  const [codes, setCodes] = useState<{ codes: string[]; account: string } | null>(null);
  const next = params.get("next") || "/";
  const preApi = useMemo(() => (preauth ? publicApi.withToken(preauth.token) : null), [preauth]);
  const kind: FlowKind = preauth?.kind ?? setup?.kind ?? "login";

  // The encryption step (recovery key or unlock), except on the confirmation of the desktop app's sign-in.
  const toEncryption = () => navigate(afterSignIn(next), { replace: true });

  const finish = (session: AuthResponse, extra: { codes?: string[] | null; passkey?: { credentialId: string; prf: Uint8Array | null } }) => {
    const flow = useAuthFlow.getState();
    flow.setSetup({ kind: flow.preauth?.kind ?? "login" });
    flow.clearPreauth();
    setSession(session);
    if (extra.passkey?.prf) rememberPrf(extra.passkey.credentialId, extra.passkey.prf);
    if (session.recovery_code_used) useToasts.getState().push({ kind: "warning", title: t("verify.recovery_used"), detail: t("verify.recovery_used_hint") });
    if (extra.codes?.length) setCodes({ codes: extra.codes, account: session.user.address });
    else toEncryption();
  };

  const cancelFlow = () => {
    useAuthFlow.getState().clearPreauth();
    useAuthFlow.getState().setSetup(null);
  };

  // Signed in and in the middle of the setup (e.g. reload while the recovery codes were shown).
  if (token && !codes && setup && !preauth) return <Navigate to={afterSignIn(next)} replace />;

  if (codes) {
    return (
      <AuthCard>
        {kind === "register" && <Steps current={3} />}
        <h1 className="mt-3 text-base font-semibold">{t("codes.title")}</h1>
        <div className="mt-3">
          <RecoveryCodesView codes={codes.codes} account={codes.account} onDone={toEncryption} />
        </div>
      </AuthCard>
    );
  }

  if (preauth && preApi) {
    const enrolling = preauth.status === "enrollment_required";
    return (
      <AuthCard>
        {preauth.kind === "register" && <Steps current={2} />}
        <h1 className="mt-3 text-base font-semibold">{enrolling ? t("second_factor.enroll_title") : t("verify.title")}</h1>
        <p className="mt-1 text-xs text-fg-2" data-testid="flow-account">
          {preauth.username}
        </p>
        <div className="mt-3">
          {enrolling ? (
            <>
              <SecondFactorEnroll
                api={preApi}
                onDone={(r: EnrollResult) => {
                  if (!r.session) return;
                  finish(r.session, { codes: r.recoveryCodes, passkey: r.passkey ? { credentialId: r.passkey.credentialId, prf: r.passkey.prf } : undefined });
                }}
              />
              <button type="button" className="mt-3 block min-h-9 w-full text-center text-sm text-fg-2 hover:text-fg-0" onClick={cancelFlow}>
                {t("verify.cancel")}
              </button>
            </>
          ) : (
            <SecondFactorVerify api={publicApi} preauthToken={preauth.token} methods={preauth.methods} onCancel={cancelFlow} onSession={(r) => finish(r.session, { passkey: r.passkey })} />
          )}
        </div>
      </AuthCard>
    );
  }

  return <PasswordStep onPreauth={(resp, k, username) => useAuthFlow.getState().startPreauth(resp, k, username)} onSession={(s, passkey) => finish(s, { passkey })} />;
}

function PasswordStep({ onPreauth, onSession }: { onPreauth: (resp: PreAuthResponse, kind: FlowKind, username: string) => void; onSession: (s: AuthResponse, passkey: { credentialId: string; prf: Uint8Array | null }) => void }) {
  const t = useT();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<Mode>(params.get("invite") || params.get("mode") === "register" ? "register" : "login");
  const [invite, setInvite] = useState(params.get("invite") ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordRepeat, setPasswordRepeat] = useState("");
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remote, setRemote] = useState(false);
  // TAVRN_OIDC_ONLY: the password form only for the operators' break-glass sign-in (APPLICATIONS.md §8.3).
  const [breakGlass, setBreakGlass] = useState(false);
  const navigate = useNavigate();
  const next = params.get("next") || "/";
  const node = useQuery({ queryKey: ["node", "origin"], queryFn: () => publicApi.node.info() });
  const captcha = node.data?.captcha ?? null;
  const captchaNeeded = !!captcha && (mode === "login" ? captcha.login : captcha.register);
  // Published terms are accepted at registration, in the version shown (design note 4.14 item 2).
  const terms = node.data?.legal?.pages?.terms ?? null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === "register" && password !== passwordRepeat) {
      setError(t("auth.password_mismatch"));
      return;
    }
    if (mode === "register" && terms && !acceptTerms) {
      setError(t("legal.terms.required_register"));
      return;
    }
    if (captchaNeeded && !captchaToken) {
      setError(t("auth.captcha_required"));
      return;
    }
    setBusy(true);
    try {
      const name = username.trim();
      // A login on a browser that still holds a device of this account continues that device (PROTOCOL.md §5b).
      const domain = node.data?.domain;
      const account = name.includes("@") ? name.toLowerCase() : domain ? `${name.toLowerCase()}@${domain}` : null;
      const device = mode === "login" ? await deviceProofFor(publicApi, account) : null;
      const resp =
        mode === "login"
          ? await publicApi.auth.login({ username: name, password, device_name: deviceName(), captcha_token: captchaToken, device })
          : await publicApi.auth.register({ username: name, password, display_name: displayName || null, email: email || null, device_name: deviceName(), captcha_token: captchaToken, invite: invite.trim() || null, accept_terms: terms ? terms.version : null });
      setPassword("");
      setPasswordRepeat("");
      onPreauth(resp, mode, name);
    } catch (err) {
      setError(describeError(err) || t("auth.failed"));
      if (captchaNeeded) setCaptchaReset((n) => n + 1);
      // New terms were published meanwhile: show the current version and ask again.
      if (err instanceof TavrnApiError && err.code === "legal.terms_not_accepted") {
        setAcceptTerms(false);
        setError(t("legal.terms.changed_register"));
        void node.refetch();
      }
    } finally {
      setBusy(false);
    }
  };

  const passkeyOnly = async () => {
    setError(null);
    setBusy(true);
    try {
      // The account is known only after the ceremony: prove the device of the last account of this browser.
      const r = await passkeyLogin(publicApi, { deviceName: deviceName(), device: await deviceProofFor(publicApi, lastAccount()) });
      onSession(r.session, { credentialId: r.credentialId, prf: r.prf });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const registrationClosed = node.data?.registration === "closed";
  const inviteMode = node.data?.registration === "invite";

  if (remote) {
    return (
      <AuthCard>
        <RemoteLogin
          next={next}
          onCancel={() => setRemote(false)}
          onSession={async (session, endpoints) => {
            await completeRemoteSignIn(session, endpoints);
            navigate(`/encryption?next=${encodeURIComponent(next)}`, { replace: true });
          }}
        />
      </AuthCard>
    );
  }

  if (node.data?.sso?.only && !breakGlass) return <SsoOnlyLogin next={next} onAdmin={() => setBreakGlass(true)} />;

  return (
    <AuthCard>
      {params.get("deleted") && (
        <p role="status" className="mb-4 rounded-md border border-line bg-bg-0 px-3 py-2 text-sm text-fg-1" data-testid="account-deleted-notice">
          {t("legal.delete.done")}
        </p>
      )}
      {mode === "login" && <SsoButton next={next} />}
      <div role="tablist" aria-label={t("a11y.auth_mode")} onKeyDown={tabListKeyDown} className={`grid grid-cols-2 rounded-md bg-bg-0 p-1 text-sm ${mode === "login" && node.data?.sso ? "mt-4" : ""}`}>
        {(["login", "register"] as Mode[]).map((m) => (
          <button
            key={m}
            role="tab"
            type="button"
            id={`auth-tab-${m}`}
            aria-selected={mode === m}
            aria-controls="auth-panel"
            tabIndex={mode === m ? 0 : -1}
            onClick={() => {
              setMode(m);
              setError(null);
            }}
            className={`min-h-10 rounded ${mode === m ? "bg-bg-3 text-fg-0" : "text-fg-2"}`}
          >
            {m === "login" ? t("auth.login") : t("auth.register")}
          </button>
        ))}
      </div>
      {mode === "register" && (
        <div className="mt-4">
          <Steps current={1} />
        </div>
      )}
      <form onSubmit={submit} className="mt-4 space-y-3" id="auth-panel" role="tabpanel" aria-labelledby={`auth-tab-${mode}`}>
        <Field label={t("auth.username")} hint={mode === "register" ? t("auth.username_hint") : undefined} errorId={error ? "auth-error" : undefined}>
          <Input name="username" autoComplete="username webauthn" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        </Field>
        <Field label={t("auth.password")} hint={mode === "register" ? t("auth.password_hint") : undefined} errorId={error ? "auth-error" : undefined}>
          <Input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {mode === "register" && (
          <>
            <Field label={t("auth.password_repeat")}>
              <Input name="password_repeat" type="password" autoComplete="new-password" value={passwordRepeat} onChange={(e) => setPasswordRepeat(e.target.value)} required />
            </Field>
            <Field label={t("auth.display_name")}>
              <Input name="display_name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </Field>
            <Field label={t("auth.email")}>
              <Input name="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            {(inviteMode || invite) && (
              <Field label={t("auth.invite_code")} hint={inviteMode ? t("auth.invite_hint") : undefined}>
                <Input name="invite" value={invite} onChange={(e) => setInvite(e.target.value)} required={inviteMode} />
              </Field>
            )}
            {terms && (
              <label className="flex items-start gap-2 text-sm text-fg-1">
                <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={acceptTerms} onChange={(e) => setAcceptTerms(e.target.checked)} data-testid="accept-terms" />
                <span>
                  {t("legal.terms.accept_register_before")}{" "}
                  <Link to="/legal/terms" target="_blank" className="text-accent underline-offset-2 hover:underline">
                    {t("legal.kind.terms")}
                  </Link>
                </span>
              </label>
            )}
            <p className="text-xs text-fg-2">{t("auth.register_2fa_hint")}</p>
            {registrationClosed && <ErrorText>{t("auth.registration_closed")}</ErrorText>}
          </>
        )}
        {captchaNeeded && captcha && <Captcha siteKey={captcha.site_key} onToken={setCaptchaToken} resetKey={captchaReset} />}
        <ErrorText id="auth-error">{error}</ErrorText>
        <Button type="submit" className="w-full" disabled={busy || (mode === "register" && registrationClosed)}>
          {busy ? t("auth.wait") : mode === "login" ? t("auth.login") : t("auth.create_account")}
        </Button>
        {mode === "login" && (
          <>
            {passkeysSupported() && (
              <Button variant="ghost" className="w-full border border-line" disabled={busy} onClick={() => void passkeyOnly()}>
                {t("auth.passkey_login")}
              </Button>
            )}
            <Link to="/forgot-password" className="block text-center text-sm text-fg-2 hover:text-fg-0">
              {t("auth.forgot")}
            </Link>
            <button type="button" data-testid="remote-login-open" className="block min-h-9 w-full border-t border-line pt-3 text-center text-sm text-accent hover:text-accent-hover" onClick={() => setRemote(true)}>
              {t("auth.remote_login")}
            </button>
          </>
        )}
      </form>
    </AuthCard>
  );
}
