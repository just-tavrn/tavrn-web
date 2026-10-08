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
 *   page in session mode skips the encryption step ({@link skipsEncryption}).
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
import { deviceProofFor } from "../crypto/e2ee";
import { checkCallback, completeRemoteSignIn, homeClient, hostOf, takePendingConnect, type PendingConnect } from "../lib/remoteSignIn";

/** `https://<host>` (and `http://<host>[:port]` for development clients served over plain HTTP). */
export function validConnectOrigin(origin: string, allowHttp: boolean): boolean {
  const re = allowHttp ? /^https?:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/ : /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
  return re.test(origin) && origin.length <= 300;
}

/** An app session id as the node issues it (43 characters of base64url). */
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;
const DONE_KEY = "tavrn.connect.done";

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

function sessionDone(id: string): boolean {
  try {
    return sessionStorage.getItem(`${DONE_KEY}.${id}`) === "1";
  } catch {
    return false;
  }
}

function markSessionDone(id: string): void {
  try {
    sessionStorage.setItem(`${DONE_KEY}.${id}`, "1");
  } catch {
    /* the reload case only */
  }
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
  const { search } = useLocation();
  const token = useAuth((s) => s.token);
  const user = useAuth((s) => s.user);
  const remoteHome = useAuth((s) => !!s.home);
  const id = params.get("session") ?? "";
  const state = params.get("state");
  const register = params.get("mode") === "register";
  const valid = SESSION_ID.test(id) && (state === null || /^[A-Za-z0-9_-]{16,128}$/.test(state));
  const [outcome, setOutcome] = useState<"done" | "cancelled" | null>(() => (valid && sessionDone(id) ? "done" : null));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
  if (outcome === "done") {
    return (
      <AuthCard>
        <h1 className="text-base font-semibold">{t("connect.app_title")}</h1>
        <p role="status" className="mt-2 text-sm text-fg-1" data-testid="connect-done">
          {t("connect.app_done")}
        </p>
        <p className="mt-2 text-xs text-fg-2">{t("connect.app_close_hint")}</p>
      </AuthCard>
    );
  }
  if (outcome === "cancelled") {
    return (
      <AuthCard>
        <p role="status" className="text-sm text-fg-1" data-testid="connect-cancelled">
          {t("connect.app_cancelled")}
        </p>
      </AuthCard>
    );
  }
  if (!token || !user) {
    const login = `/login?next=${encodeURIComponent(`/connect${search}`)}${register ? "&mode=register" : ""}`;
    return <Navigate to={login} replace />;
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
  const deviceName = info.data?.status === "pending" ? (info.data.device_name ?? "") : "";

  const allow = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.auth.connectCode({ session_id: id });
      markSessionDone(id);
      setOutcome("done");
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
      {info.isPending ? (
        <p className="mt-2 text-sm text-fg-2">{t("auth.wait")}</p>
      ) : (
        <>
          <p className="mt-2 text-sm text-fg-1" data-testid="connect-text">
            {t("connect.app_text", { device: deviceName, address: user.address })}
          </p>
          <p className="mt-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg-1" data-testid="connect-warning">
            {t("connect.app_warning")}
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
        </>
      )}
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
