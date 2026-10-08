// SPDX-License-Identifier: Apache-2.0
/**
 * Connect flow of FEDERATION.md §8.
 *
 * - `/connect` on the **home node's** web client: the user (signed in here with any method) confirms
 *   signing in on the web client at `origin`; a one-time code bound to that origin and the PKCE
 *   challenge goes back to `<origin>/connect/callback`.
 * - `/connect?session=…` on the home node's web client, opened by the **desktop app** (app sessions, §8 step 3):
 *   the user confirms signing in to the app; the code is stored with the app session for the app's poll, and the
 *   page says "return to the app" instead of redirecting. The page never creates device keys: a sign-in on this
 *   page in session mode skips the encryption step ({@link skipsEncryption}). After a passkey ceremony the page
 *   seals the PRF output to the app's key from the URL fragment (`#k=`) and sends it along ("Sealed unlock
 *   material"); an unlock session asks only for the passkey. `method=passkey|sso|register` starts that method.
 * - `/connect/callback` on the **visiting** web client: checks `state`, exchanges code and verifier for a
 *   home session and continues with the encryption step.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import { api, publicApi } from "../lib/api";
import { useAuth } from "../stores/auth";
import { useT } from "../i18n";
import { describeError } from "../stores/toasts";
import { AuthCard } from "../components/auth/AuthCard";
import { Button, ErrorText } from "../components/ui";
import { deviceProofFor, forgetPrf, hasPendingPrf, passkeyEntryIds, takePrf } from "../crypto/e2ee";
import { parseUnlockKey, sealForApp } from "../crypto/sealedUnlock";
import { evaluatePrf, passkeysSupported } from "../lib/passkeys";
import { checkCallback, completeRemoteSignIn, homeClient, hostOf, takePendingConnect, type PendingConnect } from "../lib/remoteSignIn";

/** `https://<host>` (and `http://<host>[:port]` for development clients served over plain HTTP). */
export function validConnectOrigin(origin: string, allowHttp: boolean): boolean {
  const re = allowHttp ? /^https?:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/ : /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
  return re.test(origin) && origin.length <= 300;
}

/** An app session id as the node issues it (43 characters of base64url). */
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;
const DONE_KEY = "tavrn.connect.done";
const KEY_KEY = "tavrn.connect.key";

/** How a confirmed app session ended: signed in, signed in with the passkey's unlock, or unlocked. */
type Done = "signed_in" | "signed_in_unlock" | "unlocked";

/**
 * After a sign-in whose `next` is the confirmation of an app session, the page goes straight back there: the page's
 * session only confirms the app's sign-in, and the app creates its own device keys (FEDERATION.md §8 step 3).
 */
export function skipsEncryption(next: string): boolean {
  try {
    const url = new URL(next, "https://x.invalid");
    return url.pathname === "/connect" && url.searchParams.has("session");
  } catch {
    return false;
  }
}

/** The path after a sign-in: the encryption step (recovery key or unlock), or straight to an app session's confirmation. */
export function afterSignIn(next: string): string {
  return skipsEncryption(next) ? next : `/encryption?next=${encodeURIComponent(next)}`;
}

function sessionDone(id: string): Done | null {
  try {
    const v = sessionStorage.getItem(`${DONE_KEY}.${id}`);
    return v === "signed_in" || v === "signed_in_unlock" || v === "unlocked" ? v : null;
  } catch {
    return null;
  }
}

function markSessionDone(id: string, done: Done): void {
  try {
    sessionStorage.setItem(`${DONE_KEY}.${id}`, done);
  } catch {
    /* the reload case only */
  }
}

/**
 * The app's key for sealed unlock material: read once from the fragment (`#k=`, never sent to a server) and kept in
 * this tab's sessionStorage for the session, so it survives the sign-in and an SSO round trip in this window.
 */
function appKeyFor(id: string, hash: string): string | null {
  const name = `${KEY_KEY}.${id}`;
  const fromHash = parseUnlockKey(hash);
  try {
    if (fromHash) sessionStorage.setItem(name, fromHash);
    return fromHash ?? parseUnlockKey(`#k=${sessionStorage.getItem(name) ?? ""}`);
  } catch {
    return fromHash;
  }
}

/** A sign-in method the app asked the page to start at once (`method=`). */
export function directMethod(params: URLSearchParams): "passkey" | "sso" | null {
  const m = params.get("method");
  return m === "passkey" || m === "sso" ? m : null;
}

export function ConnectPage() {
  const [params] = useSearchParams();
  return params.has("session") ? <AppSessionConnect /> : <OriginConnect />;
}

function InvalidLink() {
  const t = useT();
  return (
    <AuthCard>
      <ErrorText>{t("connect.invalid")}</ErrorText>
      <Link to="/" className="mt-3 block text-center text-sm text-fg-2 hover:text-fg-0">
        {t("connect.back_to_login")}
      </Link>
    </AuthCard>
  );
}

/** The confirmation of the desktop app's sign-in (app session): no redirect, "return to the app" instead. */
function AppSessionConnect() {
  const t = useT();
  const [params] = useSearchParams();
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const token = useAuth((s) => s.token);
  const user = useAuth((s) => s.user);
  const remoteHome = useAuth((s) => !!s.home);
  const id = params.get("session") ?? "";
  const state = params.get("state");
  const register = params.get("mode") === "register" || params.get("method") === "register";
  const method = directMethod(params);
  const valid = SESSION_ID.test(id) && (state === null || /^[A-Za-z0-9_-]{16,128}$/.test(state));
  const [appKey] = useState(() => (valid ? appKeyFor(id, hash) : null));
  const [outcome, setOutcome] = useState<Done | "cancelled" | null>(() => (valid ? sessionDone(id) : null));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The key stays out of the address bar and the history once it is kept.
  const signedInHere = !!token && !!user;
  useEffect(() => {
    if (hash && signedInHere) navigate({ pathname, search }, { replace: true });
  }, [hash, signedInHere, pathname, search, navigate]);
  const signedIn = !!token && !!user && !remoteHome;
  // Read once, before the confirmation: afterwards the session hands its code to the first poll, which must be the app's.
  const info = useQuery({
    queryKey: ["connect-session", id],
    queryFn: () => publicApi.auth.pollConnectSession(id),
    enabled: valid && signedIn && outcome === null,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (!valid) return <InvalidLink />;
  if (outcome && outcome !== "cancelled") {
    return (
      <AuthCard>
        <h1 className="text-base font-semibold">{t(outcome === "unlocked" ? "connect.unlock_title" : "connect.app_title")}</h1>
        <p role="status" className="mt-2 text-sm text-fg-1" data-testid="connect-done">
          {t(outcome === "unlocked" ? "connect.unlock_done" : outcome === "signed_in_unlock" ? "connect.app_done_unlock" : "connect.app_done")}
        </p>
        <p className="mt-2 text-xs text-fg-2">{t("connect.app_close_hint")}</p>
      </AuthCard>
    );
  }
  if (outcome === "cancelled") {
    return (
      <AuthCard>
        <p role="status" className="text-sm text-fg-1" data-testid="connect-cancelled">
          {t(info.data?.purpose === "unlock" ? "connect.unlock_cancelled" : "connect.app_cancelled")}
        </p>
      </AuthCard>
    );
  }
  if (!token || !user) {
    const extra = register ? "&mode=register" : method ? `&method=${method}` : "";
    return <Navigate to={`/login?next=${encodeURIComponent(`/connect${search}`)}${extra}`} replace />;
  }
  if (remoteHome) {
    return (
      <AuthCard>
        <ErrorText>{t("connect.other_node")}</ErrorText>
      </AuthCard>
    );
  }
  if (info.isError) {
    return (
      <AuthCard>
        <p role="alert" className="text-sm text-danger" data-testid="connect-expired">
          {t("connect.app_expired")}
        </p>
      </AuthCard>
    );
  }
  // Sign-in or unlock: known once the session was read.
  if (info.isPending) {
    return (
      <AuthCard>
        <p className="text-sm text-fg-2">{t("auth.wait")}</p>
      </AuthCard>
    );
  }
  const deviceName = info.data?.status === "pending" ? (info.data.device_name ?? "") : "";
  if (info.data?.purpose === "unlock") {
    return (
      <UnlockConfirm
        id={id}
        appKey={appKey}
        deviceName={deviceName}
        address={user.address}
        onDone={() => {
          markSessionDone(id, "unlocked");
          setOutcome("unlocked");
        }}
        onCancel={() => setOutcome("cancelled")}
      />
    );
  }

  const allow = async () => {
    setError(null);
    setBusy(true);
    try {
      // The PRF output of a passkey sign-in on this page, or (the app asked for the passkey, the page was already
      // signed in) of a ceremony now: sealed to the app's key, it unlocks the app's key store.
      let passkey = takePrf();
      if (!passkey && appKey && method === "passkey" && passkeysSupported()) {
        const ids = await passkeyEntryIds(api).catch(() => [] as string[]);
        if (ids.length) passkey = await evaluatePrf(ids).catch(() => null);
      }
      const sealed = passkey && appKey ? await sealForApp(appKey, { sessionId: id, credentialId: passkey.credentialId, prf: passkey.prf }) : null;
      passkey?.prf.fill(0);
      await api.auth.connectCode(sealed ? { session_id: id, sealed_unlock: sealed } : { session_id: id });
      const done = sealed ? "signed_in_unlock" : "signed_in";
      markSessionDone(id, done);
      setOutcome(done);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard>
      <h1 className="text-base font-semibold" data-testid="connect-title">
        {t("connect.app_title")}
      </h1>
      <p className="mt-2 text-sm text-fg-1" data-testid="connect-text">
        {t("connect.app_text", { device: deviceName, address: user.address })}
      </p>
      <p className="mt-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg-1" data-testid="connect-warning">
        {t("connect.app_warning")}
        {/* A passkey confirmation also hands the app the unlock of the encrypted messages: say so. */}
        {appKey && (method === "passkey" || hasPendingPrf()) && <> {t("connect.app_unlock_note")}</>}
      </p>
      <ErrorText>{error}</ErrorText>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse">
        <Button className="w-full sm:w-auto" disabled={busy} onClick={() => void allow()} data-testid="connect-allow">
          {t("connect.app_allow")}
        </Button>
        <Button variant="ghost" className="w-full sm:w-auto" disabled={busy} onClick={() => setOutcome("cancelled")}>
          {t("connect.cancel")}
        </Button>
      </div>
    </AuthCard>
  );
}

/**
 * An unlock session (FEDERATION.md §8 step 3): the signed-in app asks to unlock its key store with a passkey. The page
 * runs only the passkey assertion with the secret storage PRF input (or uses the PRF output of the passkey sign-in
 * that just happened here), seals it to the app's key and sends it without a code. The node accepts it only from the
 * session's own user.
 */
function UnlockConfirm({ id, appKey, deviceName, address, onDone, onCancel }: { id: string; appKey: string | null; deviceName: string; address: string; onDone: () => void; onCancel: () => void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const unlock = async (pending: { credentialId: string; prf: Uint8Array } | null) => {
    if (!appKey) return;
    setError(null);
    setBusy(true);
    let passkey = pending;
    try {
      if (!passkey) {
        const ids = await passkeyEntryIds(api);
        passkey = ids.length ? await evaluatePrf(ids) : null;
        if (!passkey) {
          setError(t("connect.unlock_no_passkey"));
          return;
        }
      }
      const sealed = await sealForApp(appKey, { sessionId: id, credentialId: passkey.credentialId, prf: passkey.prf });
      if (!sealed) throw Object.assign(new Error("sealing failed"), { problem: { code: "connect.sealed_unlock_invalid" } });
      await api.auth.connectUnlock({ session_id: id, sealed_unlock: sealed });
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      passkey?.prf.fill(0);
      setBusy(false);
    }
  };

  // A passkey sign-in on this page a moment ago already has the PRF output: no second ceremony.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const pending = takePrf();
    if (pending && appKey) void unlock(pending);
    else forgetPrf();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!appKey) {
    return (
      <AuthCard>
        <ErrorText>{t("connect.unlock_no_key")}</ErrorText>
      </AuthCard>
    );
  }
  return (
    <AuthCard>
      <h1 className="text-base font-semibold" data-testid="connect-title">
        {t("connect.unlock_title")}
      </h1>
      <p className="mt-2 text-sm text-fg-1" data-testid="connect-text">
        {t("connect.unlock_text", { device: deviceName, address })}
      </p>
      <ErrorText>{error}</ErrorText>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse">
        <Button className="w-full sm:w-auto" disabled={busy} onClick={() => void unlock(null)} data-testid="connect-unlock">
          {busy ? t("e2ee.unlocking") : t("connect.unlock_allow")}
        </Button>
        <Button variant="ghost" className="w-full sm:w-auto" disabled={busy} onClick={onCancel}>
          {t("connect.cancel")}
        </Button>
      </div>
    </AuthCard>
  );
}

/** The confirmation of another web client's sign-in (origin flow): back to `<origin>/connect/callback`. */
function OriginConnect() {
  const t = useT();
  const [params] = useSearchParams();
  const token = useAuth((s) => s.token);
  const user = useAuth((s) => s.user);
  const remoteHome = useAuth((s) => !!s.home);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const origin = params.get("origin") ?? "";
  const state = params.get("state") ?? "";
  const challenge = params.get("code_challenge") ?? "";
  const valid = validConnectOrigin(origin, location.protocol === "http:") && origin !== location.origin && /^[A-Za-z0-9_-]{16,128}$/.test(state) && /^[A-Za-z0-9_-]{43}$/.test(challenge);

  if (!valid) return <InvalidLink />;
  if (!token || !user) return <Navigate to={`/login?next=${encodeURIComponent(`/connect${location.search}`)}`} replace />;
  if (remoteHome) {
    return (
      <AuthCard>
        <ErrorText>{t("connect.other_node")}</ErrorText>
      </AuthCard>
    );
  }

  const back = (query: Record<string, string>) => {
    const url = new URL(`${origin}/connect/callback`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    setLeaving(true);
    location.assign(url.toString());
  };
  const allow = async () => {
    setError(null);
    try {
      const { code } = await api.auth.connectCode({ origin, code_challenge: challenge, device_name: `Browser (${hostOf(origin)})` });
      back({ code, state, node: user.domain });
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <AuthCard>
      <h1 className="text-base font-semibold" data-testid="connect-title">
        {t("connect.title")}
      </h1>
      <p className="mt-2 text-sm text-fg-1" data-testid="connect-text">
        {t("connect.text", { origin: hostOf(origin), address: user.address })}
      </p>
      <p className="mt-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg-1">{t("connect.warning")}</p>
      <ErrorText>{error}</ErrorText>
      {leaving ? (
        <p className="mt-4 text-sm text-fg-2">{t("connect.redirecting", { origin: hostOf(origin) })}</p>
      ) : (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse">
          <Button className="w-full sm:w-auto" onClick={() => void allow()} data-testid="connect-allow">
            {t("connect.allow")}
          </Button>
          <Button variant="ghost" className="w-full sm:w-auto" onClick={() => back({ error: "access_denied", state })}>
            {t("connect.cancel")}
          </Button>
        </div>
      )}
    </AuthCard>
  );
}

export function ConnectCallbackPage() {
  const t = useT();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // The flow is taken once (React may run effects twice in development).
  const pending = useRef<PendingConnect | null | undefined>(undefined);
  if (pending.current === undefined) pending.current = takePendingConnect();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const flow = pending.current ?? null;
    const check = checkCallback(params, flow);
    if (!check.ok || !flow) {
      setError(t(check.ok ? "connect.state_mismatch" : check.reason === "cancelled" ? "connect.cancelled" : check.reason === "state" ? "connect.state_mismatch" : "connect.invalid"));
      return;
    }
    void (async () => {
      try {
        const home = homeClient(flow.endpoints);
        // Continue this browser's device of the account, like a normal login (ENCRYPTION.md §3.4).
        const device = flow.address ? await deviceProofFor(home, flow.address) : null;
        const session = await home.auth.connectToken({ code: check.code, code_verifier: flow.verifier, device });
        await completeRemoteSignIn(session, flow.endpoints);
        navigate(`/encryption?next=${encodeURIComponent(flow.next)}`, { replace: true });
      } catch (e) {
        setError(describeError(e));
      }
    })();
  }, [params, navigate, t]);

  return (
    <AuthCard>
      <h1 className="text-base font-semibold">{t("connect.callback_title")}</h1>
      <ErrorText>{error}</ErrorText>
      {error && (
        <Link to="/login" className="mt-3 block text-center text-sm text-accent hover:text-accent-hover" data-testid="connect-back">
          {t("connect.back_to_login")}
        </Link>
      )}
    </AuthCard>
  );
}
