// SPDX-License-Identifier: Apache-2.0
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router";
import { pkceChallenge } from "@tavrn/sdk";
import { LoginPage } from "./LoginPage";
import { ConnectCallbackPage, ConnectPage, validConnectOrigin } from "./ConnectPages";
import { useAuth } from "../stores/auth";
import { resetNodeCaches, useNodes } from "../stores/nodes";
import { checkCallback, safeNext, startConnect, takePendingConnect, type PendingConnect } from "../lib/remoteSignIn";
import { renderWithProviders } from "../test/render";
import { deviceProofFor, rememberPrf, takePrf } from "../crypto/e2ee";
import { evaluatePrf, passkeyLogin } from "../lib/passkeys";
import { sealForApp } from "../crypto/sealedUnlock";
import { inSignInWindow } from "../platform/tauriDetect";
import { signOutAfterHandoff } from "../lib/handoffSignOut";

// The browser's stored device (IndexedDB) is replaced by a stub: no device unless a test provides a proof.
vi.mock("../crypto/e2ee", async (original) => ({ ...(await original<typeof import("../crypto/e2ee")>()), deviceProofFor: vi.fn(async () => null) }));
// WebAuthn ceremonies (jsdom has none) and the sealed box (WebAssembly; its round trip: crypto/sealedUnlock.test.ts).
vi.mock("../lib/passkeys", async (original) => ({
  ...(await original<typeof import("../lib/passkeys")>()),
  passkeysSupported: () => true,
  passkeyLogin: vi.fn(),
  evaluatePrf: vi.fn(),
}));
// The page in the desktop app's sign-in window signs itself out after the handoff (#24; the waiting: lib/handoffSignOut.test.ts).
vi.mock("../platform/tauriDetect", async (original) => ({ ...(await original<typeof import("../platform/tauriDetect")>()), inSignInWindow: vi.fn(() => false) }));
vi.mock("../lib/handoffSignOut", async (original) => ({ ...(await original<typeof import("../lib/handoffSignOut")>()), signOutAfterHandoff: vi.fn(async () => {}) }));
vi.mock("../crypto/sealedUnlock", async (original) => ({ ...(await original<typeof import("../crypto/sealedUnlock")>()), sealForApp: vi.fn(async () => "sealed-box") }));

const HOME = "home.example";
const VISIT = "visit.example";
const homeUser = { id: "H1", username: "alice", domain: HOME, address: `alice@${HOME}`, display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const session = { status: "ok", user: homeUser, access_token: "home-acc", refresh_token: "home-ref", expires_in: 3600, device_id: "01J9ZK3G5M8Q2W4E6R8T0Y2VA1", recovery_code_used: false };
const endpoints = { domain: HOME, base: `https://${HOME}`, ws: `wss://${HOME}/api/v1/ws`, web: `https://${HOME}` };

function doc(domain: string) {
  return { tavrn: 1, domain, name: domain, description: "", api: `https://${domain}/api/v1`, ws: `wss://${domain}/api/v1/ws`, web: `https://${domain}`, capabilities: ["federation", "federation.v1"], keys: [], registration: "open", email: "none", policies: {}, directory_listing: true, software: { name: "tavrn-node", version: "0" } };
}

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  auth?: string;
}

/** Fake network: the home node home.example and the node this client was loaded from (visit.example). */
function network(overrides: Record<string, (body: Record<string, unknown> | null) => { status?: number; body: unknown }> = {}) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), location.origin);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url: url.toString(), method: init.method ?? "GET", body, auth: (init.headers as Record<string, string> | undefined)?.Authorization });
    const key = `${url.host === location.host ? "origin" : url.host}${url.pathname}`;
    const json = (status: number, b: unknown) => (status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } }));
    if (overrides[key]) {
      const r = overrides[key]!(body);
      return json(r.status ?? 200, r.body);
    }
    switch (key) {
      case `${HOME}/.well-known/tavrn`:
        throw new TypeError("Failed to fetch"); // e.g. blocked: the proxy of this client's node answers
      case "origin/.well-known/tavrn":
        return json(200, doc(VISIT));
      case `origin/api/v1/federation/resolve/${HOME}`: {
        const d = doc(HOME);
        return json(200, { domain: HOME, api: d.api, ws: d.ws, web: d.web, source: "well_known" });
      }
      case "origin/api/v1/node":
        return json(200, { name: "Visit", domain: VISIT, registration: "open" });
      case `${HOME}/api/v1/auth/login`:
        return json(200, { status: "second_factor_required", preauth_token: "pre", methods: ["totp", "webauthn", "recovery_code"], expires_in: 600 });
      case `${HOME}/api/v1/auth/second-factor/verify`:
        return json(200, session);
      case `${HOME}/api/v1/auth/connect/token`:
        return json(200, session);
      case `${HOME}/api/v1/federation/token`:
        return json(200, { token: "fed-jwt", target: body?.target, expires_in: 600 });
      case "origin/api/v1/auth/federated":
        return json(200, { ...session, user: { ...homeUser, id: "V-LOCAL" }, access_token: "visit-acc", refresh_token: "visit-ref", session_expires_at: "2099-01-01T00:00:00Z" });
      default:
        return json(404, { type: "x", title: "", status: 404, detail: key, code: "route.not_found" });
    }
  }) as typeof fetch;
  return calls;
}

function renderAt(route: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/connect" element={<ConnectPage />} />
      <Route path="/connect/callback" element={<ConnectCallbackPage />} />
      <Route path="/encryption" element={<p>Verschlüsselungsseite</p>} />
      <Route path="/" element={<p>Startseite</p>} />
    </Routes>,
    { route },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(inSignInWindow).mockReturnValue(false);
  useAuth.getState().logout();
  useNodes.getState().clear();
  resetNodeCaches();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  takePrf();
});

describe("sign-in with an account of another node: direct flow", () => {
  it("discovers the home node, signs in with password and TOTP there and opens a federated session here", async () => {
    const calls = network();
    renderAt("/login?next=%2Ffriends");
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Mit einem Konto eines anderen Knotens anmelden" }));
    await u.type(screen.getByLabelText("Deine Adresse"), "alice@visit.example");
    await u.click(screen.getByRole("button", { name: "Weiter" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("gehört zu diesem Knoten");
    await u.clear(screen.getByLabelText("Deine Adresse"));
    await u.type(screen.getByLabelText("Deine Adresse"), `Alice@${HOME}`);
    await u.click(screen.getByRole("button", { name: "Weiter" }));
    expect(await screen.findByTestId("remote-home")).toHaveTextContent(`Anmeldung bei ${HOME}`);
    expect(screen.getByTestId("remote-warning")).toHaveTextContent(VISIT);
    await u.type(screen.getByLabelText("Passwort"), "passwort-alice");
    await u.click(screen.getByRole("button", { name: "Mit Passwort anmelden" }));
    expect(await screen.findByLabelText("6-stelliger Code")).toBeInTheDocument();
    // Passkeys of the home node cannot run on this origin.
    expect(screen.queryByRole("button", { name: "Passkey verwenden" })).toBeNull();
    await u.type(screen.getByLabelText("6-stelliger Code"), "123456");
    await u.click(screen.getByRole("button", { name: "Bestätigen" }));
    expect(await screen.findByText("Verschlüsselungsseite")).toBeInTheDocument();

    expect(calls.find((c) => c.url.endsWith("/auth/login"))).toMatchObject({ url: `https://${HOME}/api/v1/auth/login`, body: { username: "alice", password: "passwort-alice" } });
    expect(useAuth.getState().token).toBe("home-acc");
    expect(useAuth.getState().home).toEqual({ domain: HOME, base: `https://${HOME}`, ws: `wss://${HOME}/api/v1/ws`, web: `https://${HOME}` });
    await waitFor(() => expect(useNodes.getState().sessions[VISIT]?.token).toBe("visit-acc"));
    expect(calls.find((c) => c.url.endsWith("/federation/token"))).toMatchObject({ body: { target: VISIT }, auth: "Bearer home-acc" });
  });
});

describe("connect flow", () => {
  it("starts with state and a PKCE challenge kept in this tab", async () => {
    const url = new URL(await startConnect(endpoints, "/friends", `alice@${HOME}`));
    expect(url.origin + url.pathname).toBe(`https://${HOME}/connect`);
    expect(url.searchParams.get("origin")).toBe(location.origin);
    const pending = JSON.parse(sessionStorage.getItem("tavrn.connect")!) as PendingConnect;
    expect(url.searchParams.get("state")).toBe(pending.state);
    expect(url.searchParams.get("code_challenge")).toBe(await pkceChallenge(pending.verifier));
    expect(pending.next).toBe("/friends");
    expect(pending.address).toBe(`alice@${HOME}`);
    expect(takePendingConnect()?.state).toBe(pending.state);
    expect(takePendingConnect()).toBeNull();
  });

  it("checks the callback against the flow of this tab", () => {
    const pending: PendingConnect = { state: "s".repeat(43), verifier: "v", endpoints, next: "/", startedAt: 1000 };
    const p = (q: string) => new URLSearchParams(q);
    expect(checkCallback(p(`code=c&state=${pending.state}&node=${HOME}`), pending, 2000)).toEqual({ ok: true, code: "c" });
    expect(checkCallback(p(`code=c&state=other&node=${HOME}`), pending, 2000)).toEqual({ ok: false, reason: "state" });
    expect(checkCallback(p(`code=c&state=${pending.state}&node=${HOME}`), null, 2000)).toEqual({ ok: false, reason: "state" });
    expect(checkCallback(p(`code=c&state=${pending.state}&node=${HOME}`), pending, 1000 + 16 * 60_000)).toEqual({ ok: false, reason: "state" });
    expect(checkCallback(p(`error=access_denied&state=${pending.state}`), pending, 2000)).toEqual({ ok: false, reason: "cancelled" });
    expect(checkCallback(p(`code=c&state=${pending.state}&node=evil.example`), pending, 2000)).toEqual({ ok: false, reason: "invalid" });
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("/rooms/x")).toBe("/rooms/x");
  });

  it("callback: exchanges code and verifier on the home node", async () => {
    const calls = network();
    const pending: PendingConnect = { state: "S".repeat(43), verifier: "V".repeat(43), endpoints, next: "/friends", startedAt: Date.now() };
    sessionStorage.setItem("tavrn.connect", JSON.stringify(pending));
    renderAt(`/connect/callback?code=the-code&state=${pending.state}&node=${HOME}`);
    expect(await screen.findByText("Verschlüsselungsseite")).toBeInTheDocument();
    expect(calls.filter((c) => c.url.endsWith("/auth/connect/token"))).toHaveLength(1);
    expect(calls.find((c) => c.url.endsWith("/auth/connect/token"))).toMatchObject({ url: `https://${HOME}/api/v1/auth/connect/token`, body: { code: "the-code", code_verifier: pending.verifier } });
    expect(useAuth.getState().home?.domain).toBe(HOME);
    expect(sessionStorage.getItem("tavrn.connect")).toBeNull();
  });

  it("callback: continues this browser's device of the named account (device proof, ENCRYPTION.md §3.4)", async () => {
    const calls = network();
    const proof = { id: "01J9ZK3G5M8Q2W4E6R8T0Y2VA1", nonce: "n", proof: "p" };
    vi.mocked(deviceProofFor).mockResolvedValueOnce(proof);
    const pending: PendingConnect = { state: "S".repeat(43), verifier: "V".repeat(43), endpoints, next: "/friends", startedAt: Date.now(), address: `alice@${HOME}` };
    sessionStorage.setItem("tavrn.connect", JSON.stringify(pending));
    renderAt(`/connect/callback?code=the-code&state=${pending.state}&node=${HOME}`);
    expect(await screen.findByText("Verschlüsselungsseite")).toBeInTheDocument();
    expect(vi.mocked(deviceProofFor)).toHaveBeenCalledWith(expect.anything(), `alice@${HOME}`);
    expect(calls.find((c) => c.url.endsWith("/auth/connect/token"))?.body).toMatchObject({ code: "the-code", device: proof });
  });

  it("callback: refuses a foreign state without exchanging anything", async () => {
    const calls = network();
    sessionStorage.setItem("tavrn.connect", JSON.stringify({ state: "S".repeat(43), verifier: "V", endpoints, next: "/", startedAt: Date.now() }));
    renderAt(`/connect/callback?code=c&state=${"X".repeat(43)}&node=${HOME}`);
    expect(await screen.findByRole("alert")).toHaveTextContent("nicht in diesem Browser-Tab begonnen");
    expect(calls.some((c) => c.url.includes("connect/token"))).toBe(false);
    expect(useAuth.getState().token).toBeNull();
  });

  it("home side: asks for confirmation, then issues a code bound to the origin and challenge", async () => {
    const calls = network({ "origin/api/v1/auth/connect/code": () => ({ body: { code: "one-time", expires_in: 120 } }) });
    useAuth.setState({ token: "local", refresh: "r", user: { ...homeUser, domain: VISIT, address: `alice@${VISIT}` }, deviceId: "D", home: null });
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    renderAt(`/connect?origin=${encodeURIComponent("https://other.example")}&state=${"s".repeat(43)}&code_challenge=${challenge}`);
    expect(await screen.findByTestId("connect-text")).toHaveTextContent(`other.example möchte dich als alice@${VISIT} anmelden`);
    expect(calls.some((c) => c.url.includes("connect/code"))).toBe(false);
    vi.spyOn(console, "error").mockImplementation(() => undefined); // jsdom cannot navigate
    await userEvent.setup().click(screen.getByRole("button", { name: "Dort anmelden" }));
    expect(await screen.findByText("Zurück zu other.example…")).toBeInTheDocument();
    expect(calls.find((c) => c.url.endsWith("/auth/connect/code"))).toMatchObject({ body: { origin: "https://other.example", code_challenge: challenge }, auth: "Bearer local" });
  });

  it("home side: invalid links are refused and signed-out users sign in first", async () => {
    network();
    useAuth.setState({ token: "local", refresh: "r", user: homeUser, deviceId: "D", home: null });
    const { unmount } = renderAt(`/connect?origin=${encodeURIComponent("javascript:alert(1)")}&state=${"s".repeat(43)}&code_challenge=${"c".repeat(43)}`);
    expect(await screen.findByText("Dieser Anmeldelink ist ungültig oder unvollständig.")).toBeInTheDocument();
    unmount();
    useAuth.getState().logout();
    renderAt(`/connect?origin=${encodeURIComponent("https://other.example")}&state=${"s".repeat(43)}&code_challenge=${"c".repeat(43)}`);
    expect(await screen.findByRole("button", { name: "Anmelden" })).toBeInTheDocument();
    expect(validConnectOrigin("https://other.example", false)).toBe(true);
    expect(validConnectOrigin("http://other.example", false)).toBe(false);
    expect(validConnectOrigin("http://b.test:5274", true)).toBe(true);
    expect(validConnectOrigin("https://other.example/path", true)).toBe(false);
    expect(validConnectOrigin("https://user@other.example", true)).toBe(false);
  });
});

describe("connect flow: app sessions of the desktop app (FEDERATION.md §8 step 3)", () => {
  const SESSION = "S".repeat(43);
  const sessionUrl = (extra = "") => `/connect?session=${SESSION}&state=${"s".repeat(22)}${extra}`;
  const localUser = { ...homeUser, domain: VISIT, address: `alice@${VISIT}` };
  const pendingSession = () => ({ body: { status: "pending", device_name: "tavrn auf dem Laptop", purpose: "login", expires_in: 580 } });
  const KEY = "K".repeat(43);

  it("asks with the session's device name, issues the code for the session and stays on the page", async () => {
    const calls = network({
      [`origin/api/v1/auth/connect/session/${SESSION}`]: pendingSession,
      "origin/api/v1/auth/connect/code": () => ({ body: { code: "one-time", expires_in: 120 } }),
    });
    useAuth.setState({ token: "local", refresh: "r", user: localUser, deviceId: "D", home: null });
    renderAt(sessionUrl());
    expect(await screen.findByTestId("connect-text")).toHaveTextContent(`„tavrn auf dem Laptop“ möchte sich als alice@${VISIT} anmelden`);
    expect(screen.getByTestId("connect-warning")).toHaveTextContent("selbst in deiner eigenen tavrn-App");
    await userEvent.setup().click(screen.getByRole("button", { name: "In der App anmelden" }));
    expect(await screen.findByTestId("connect-done")).toHaveTextContent("Kehre zur tavrn-App zurück");
    expect(calls.find((c) => c.url.endsWith("/auth/connect/code"))).toMatchObject({ body: { session_id: SESSION }, auth: "Bearer local" });
    expect(calls.find((c) => c.url.endsWith("/auth/connect/code"))!.body).not.toHaveProperty("origin");
    // The session is read once, before the confirmation; afterwards the app alone polls it (the code is handed out once).
    expect(calls.filter((c) => c.url.includes("/auth/connect/session/"))).toHaveLength(1);
  });

  it("in the app's sign-in window the page signs itself out once the app exchanged the code; a browser tab keeps its session", async () => {
    const devices = [{ id: "D", name: "Browser", client: "c", created_at: "", last_seen_at: "t0", current: true, stale: false }];
    const overrides = {
      [`origin/api/v1/auth/connect/session/${SESSION}`]: pendingSession,
      "origin/api/v1/auth/connect/code": () => ({ body: { code: "one-time", expires_in: 120 } }),
      "origin/api/v1/users/me/devices": () => ({ body: devices }),
    };
    vi.mocked(inSignInWindow).mockReturnValue(true);
    network(overrides);
    useAuth.setState({ token: "local", refresh: "r", user: localUser, deviceId: "D", home: null });
    const { unmount } = renderAt(sessionUrl());
    await userEvent.setup().click(await screen.findByRole("button", { name: "In der App anmelden" }));
    expect(await screen.findByTestId("connect-done")).toHaveTextContent("Kehre zur tavrn-App zurück");
    await waitFor(() => expect(signOutAfterHandoff).toHaveBeenCalledTimes(1));
    const args = vi.mocked(signOutAfterHandoff).mock.calls[0]![0];
    expect(args).toMatchObject({ before: devices, waitForExchange: true });
    unmount();

    vi.mocked(inSignInWindow).mockReturnValue(false);
    vi.mocked(signOutAfterHandoff).mockClear();
    sessionStorage.clear();
    const calls = network(overrides);
    renderAt(sessionUrl());
    await userEvent.setup().click(await screen.findByRole("button", { name: "In der App anmelden" }));
    await screen.findByTestId("connect-done");
    expect(signOutAfterHandoff).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.endsWith("/users/me/devices"))).toBe(false);
    expect(useAuth.getState().token).toBe("local");
  });

  it("does not read the session again after the confirmation (a reload of the page)", async () => {
    const calls = network({ [`origin/api/v1/auth/connect/session/${SESSION}`]: pendingSession, "origin/api/v1/auth/connect/code": () => ({ body: { code: "c", expires_in: 120 } }) });
    useAuth.setState({ token: "local", refresh: "r", user: localUser, deviceId: "D", home: null });
    const { unmount } = renderAt(sessionUrl());
    await userEvent.setup().click(await screen.findByRole("button", { name: "In der App anmelden" }));
    await screen.findByTestId("connect-done");
    unmount();
    renderAt(sessionUrl());
    expect(await screen.findByTestId("connect-done")).toBeInTheDocument();
    expect(calls.filter((c) => c.url.includes("/auth/connect/session/"))).toHaveLength(1);
  });

  it("an expired session cannot be confirmed", async () => {
    network({ [`origin/api/v1/auth/connect/session/${SESSION}`]: () => ({ status: 410, body: { code: "connect.session_expired", status: 410, title: "Gone", type: "x" } }) });
    useAuth.setState({ token: "local", refresh: "r", user: localUser, deviceId: "D", home: null });
    renderAt(sessionUrl());
    expect(await screen.findByTestId("connect-expired")).toHaveTextContent("abgelaufen");
    expect(screen.queryByRole("button", { name: "In der App anmelden" })).toBeNull();
  });

  it("cancel leaves the session alone and says the window can be closed", async () => {
    const calls = network({ [`origin/api/v1/auth/connect/session/${SESSION}`]: pendingSession });
    useAuth.setState({ token: "local", refresh: "r", user: localUser, deviceId: "D", home: null });
    renderAt(sessionUrl());
    await userEvent.setup().click(await screen.findByRole("button", { name: "Abbrechen" }));
    expect(await screen.findByTestId("connect-cancelled")).toHaveTextContent("Fenster schließen");
    expect(calls.some((c) => c.url.endsWith("/auth/connect/code"))).toBe(false);
  });

  it("signed out: signs in on this page and comes back without the encryption step (keys are made in the app)", async () => {
    network({
      [`origin/api/v1/auth/connect/session/${SESSION}`]: pendingSession,
      "origin/api/v1/auth/login": () => ({ body: { status: "second_factor_required", preauth_token: "pre", methods: ["totp"], expires_in: 600 } }),
      "origin/api/v1/auth/second-factor/verify": () => ({ body: { ...session, user: localUser, access_token: "local-acc" } }),
    });
    renderAt(sessionUrl());
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText("Benutzername"), "alice");
    await u.type(screen.getByLabelText("Passwort"), "passwort-alice");
    await u.click(screen.getByRole("button", { name: "Anmelden" }));
    await u.type(await screen.findByLabelText("6-stelliger Code"), "123456");
    await u.click(screen.getByRole("button", { name: "Bestätigen" }));
    expect(await screen.findByTestId("connect-text")).toHaveTextContent("tavrn auf dem Laptop");
    expect(screen.queryByText("Verschlüsselungsseite")).toBeNull();
  });

  it("registration mode opens the page's registration", async () => {
    network({ [`origin/api/v1/auth/connect/session/${SESSION}`]: pendingSession });
    renderAt(sessionUrl("&mode=register"));
    expect(await screen.findByRole("tab", { name: "Registrieren" })).toHaveAttribute("aria-selected", "true");
  });

  it("the app's key travels in the fragment: no key, nothing sealed", async () => {
    const calls = network({ [`origin/api/v1/auth/connect/session/${SESSION}`]: pendingSession, "origin/api/v1/auth/connect/code": () => ({ body: { code: "c", expires_in: 120 } }) });
    useAuth.setState({ token: "local", refresh: "r", user: localUser, deviceId: "D", home: null });
    rememberPrf("Y3JlZA", new Uint8Array(32).fill(5));
    renderAt(sessionUrl());
    expect(await screen.findByTestId("connect-warning")).not.toHaveTextContent("entsperrt in dieser App");
    await userEvent.setup().click(await screen.findByRole("button", { name: "In der App anmelden" }));
    await screen.findByTestId("connect-done");
    expect(calls.find((c) => c.url.endsWith("/auth/connect/code"))!.body).not.toHaveProperty("sealed_unlock");
    expect(sealForApp).not.toHaveBeenCalled();
    expect(takePrf()).toBeNull();
  });

  it("method=passkey: signs in with the passkey at once and seals its PRF output to the app's key", async () => {
    let ceremony: (v: Awaited<ReturnType<typeof passkeyLogin>>) => void = () => {};
    vi.mocked(passkeyLogin).mockImplementation(() => new Promise((resolve) => (ceremony = resolve)));
    const calls = network({ [`origin/api/v1/auth/connect/session/${SESSION}`]: pendingSession, "origin/api/v1/auth/connect/code": () => ({ body: { code: "c", expires_in: 120 } }) });
    renderAt(`${sessionUrl("&method=passkey")}#k=${KEY}`);
    // Only the passkey: a short state instead of the whole form.
    expect(await screen.findByText("Anmeldung mit Passkey…")).toBeInTheDocument();
    expect(screen.queryByLabelText("Passwort")).toBeNull();
    ceremony({ session: { ...session, user: localUser, access_token: "local-acc" } as never, credentialId: "Y3JlZA", prf: new Uint8Array(32).fill(5) });
    // The warning says that the passkey also unlocks the app's encrypted messages.
    expect(await screen.findByTestId("connect-warning")).toHaveTextContent("Dein Passkey entsperrt in dieser App auch deine verschlüsselten Nachrichten.");
    await userEvent.setup().click(await screen.findByRole("button", { name: "In der App anmelden" }));
    expect(await screen.findByTestId("connect-done")).toHaveTextContent("Passkey entsperrt die App");
    expect(passkeyLogin).toHaveBeenCalledTimes(1);
    expect(sealForApp).toHaveBeenCalledWith(KEY, { sessionId: SESSION, credentialId: "Y3JlZA", prf: expect.any(Uint8Array) });
    expect(calls.find((c) => c.url.endsWith("/auth/connect/code"))).toMatchObject({ body: { session_id: SESSION, sealed_unlock: "sealed-box" }, auth: "Bearer local-acc" });
  });

  it("method=passkey on a page that is already signed in: confirming runs the passkey for the unlock", async () => {
    vi.mocked(evaluatePrf).mockResolvedValue({ credentialId: "Y3JlZA", prf: new Uint8Array(32).fill(6) });
    const calls = network({
      [`origin/api/v1/auth/connect/session/${SESSION}`]: pendingSession,
      "origin/api/v1/auth/connect/code": () => ({ body: { code: "c", expires_in: 120 } }),
      "origin/api/v1/users/me/secret-storage": () => ({ body: { items: [{ method: "recovery" }, { method: "passkey:Y3JlZA" }] } }),
    });
    useAuth.setState({ token: "local", refresh: "r", user: localUser, deviceId: "D", home: null });
    renderAt(`${sessionUrl("&method=passkey")}#k=${KEY}`);
    await userEvent.setup().click(await screen.findByRole("button", { name: "In der App anmelden" }));
    await screen.findByTestId("connect-done");
    expect(evaluatePrf).toHaveBeenCalledWith(["Y3JlZA"]);
    expect(calls.find((c) => c.url.endsWith("/auth/connect/code"))!.body).toMatchObject({ sealed_unlock: "sealed-box" });
  });

  it("method=passkey: another method shows the whole form", async () => {
    vi.mocked(passkeyLogin).mockRejectedValue(Object.assign(new Error("cancelled"), { name: "NotAllowedError" }));
    network({ [`origin/api/v1/auth/connect/session/${SESSION}`]: pendingSession });
    renderAt(`${sessionUrl("&method=passkey")}#k=${KEY}`);
    const u = userEvent.setup();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(passkeyLogin).toHaveBeenCalledTimes(2));
    await u.click(screen.getByRole("button", { name: "Andere Methode verwenden" }));
    expect(await screen.findByLabelText("Passwort")).toBeInTheDocument();
  });

  it("unlock session: the page asks only for the passkey and sends the sealed PRF output without a code", async () => {
    vi.mocked(evaluatePrf).mockResolvedValue({ credentialId: "Y3JlZA", prf: new Uint8Array(32).fill(7) });
    const calls = network({
      [`origin/api/v1/auth/connect/session/${SESSION}`]: () => ({ body: { status: "pending", device_name: "tavrn auf dem Laptop", purpose: "unlock", expires_in: 580 } }),
      "origin/api/v1/auth/connect/code": () => ({ status: 204, body: null }),
      "origin/api/v1/users/me/secret-storage": () => ({ body: { items: [{ method: "passkey:Y3JlZA" }] } }),
    });
    useAuth.setState({ token: "local", refresh: "r", user: localUser, deviceId: "D", home: null });
    renderAt(`${sessionUrl("&method=passkey")}#k=${KEY}`);
    expect(await screen.findByTestId("connect-title")).toHaveTextContent("tavrn-App entsperren?");
    expect(screen.getByTestId("connect-text")).toHaveTextContent(`„tavrn auf dem Laptop“ möchte die verschlüsselten Nachrichten von alice@${VISIT}`);
    expect(screen.queryByRole("button", { name: "In der App anmelden" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Mit Passkey entsperren" }));
    expect(await screen.findByTestId("connect-done")).toHaveTextContent("Die App ist entsperrt");
    expect(calls.find((c) => c.url.endsWith("/auth/connect/code"))).toMatchObject({ body: { session_id: SESSION, sealed_unlock: "sealed-box" } });
    expect(calls.find((c) => c.url.endsWith("/auth/connect/code"))!.body).not.toHaveProperty("code_challenge");
  });

  it("unlock session in the app's sign-in window: the page signs out right after the unlock (no code to exchange)", async () => {
    vi.mocked(inSignInWindow).mockReturnValue(true);
    vi.mocked(evaluatePrf).mockResolvedValue({ credentialId: "Y3JlZA", prf: new Uint8Array(32).fill(7) });
    network({
      [`origin/api/v1/auth/connect/session/${SESSION}`]: () => ({ body: { status: "pending", device_name: "Laptop", purpose: "unlock", expires_in: 580 } }),
      "origin/api/v1/auth/connect/code": () => ({ status: 204, body: null }),
      "origin/api/v1/users/me/secret-storage": () => ({ body: { items: [{ method: "passkey:Y3JlZA" }] } }),
    });
    useAuth.setState({ token: "local", refresh: "r", user: localUser, deviceId: "D", home: null });
    renderAt(`${sessionUrl("&method=passkey")}#k=${KEY}`);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Mit Passkey entsperren" }));
    expect(await screen.findByTestId("connect-done")).toHaveTextContent("Die App ist entsperrt");
    await waitFor(() => expect(signOutAfterHandoff).toHaveBeenCalledTimes(1));
    expect(vi.mocked(signOutAfterHandoff).mock.calls[0]![0]).toMatchObject({ waitForExchange: false });
  });

  it("unlock session: a passkey sign-in on this page unlocks without a second ceremony", async () => {
    vi.mocked(passkeyLogin).mockResolvedValue({ session: { ...session, user: localUser, access_token: "local-acc" } as never, credentialId: "Y3JlZA", prf: new Uint8Array(32).fill(8) });
    const calls = network({
      [`origin/api/v1/auth/connect/session/${SESSION}`]: () => ({ body: { status: "pending", device_name: "Laptop", purpose: "unlock", expires_in: 580 } }),
      "origin/api/v1/auth/connect/code": () => ({ status: 204, body: null }),
    });
    renderAt(`${sessionUrl("&method=passkey")}#k=${KEY}`);
    expect(await screen.findByTestId("connect-done")).toHaveTextContent("Die App ist entsperrt");
    expect(evaluatePrf).not.toHaveBeenCalled();
    expect(calls.find((c) => c.url.endsWith("/auth/connect/code"))!.body).toMatchObject({ sealed_unlock: "sealed-box" });
  });

  it("unlock session: another account, no passkey or no key say so", async () => {
    const unlockPending = () => ({ body: { status: "pending", device_name: "Laptop", purpose: "unlock", expires_in: 580 } });
    vi.mocked(evaluatePrf).mockResolvedValue({ credentialId: "Y3JlZA", prf: new Uint8Array(32).fill(7) });
    network({
      [`origin/api/v1/auth/connect/session/${SESSION}`]: unlockPending,
      "origin/api/v1/auth/connect/code": () => ({ status: 403, body: { code: "connect.user_mismatch", status: 403, title: "Forbidden", type: "x" } }),
      "origin/api/v1/users/me/secret-storage": () => ({ body: { items: [{ method: "passkey:Y3JlZA" }] } }),
    });
    useAuth.setState({ token: "local", refresh: "r", user: localUser, deviceId: "D", home: null });
    const first = renderAt(`${sessionUrl()}#k=${KEY}`);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Mit Passkey entsperren" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("gehört zu einem anderen Konto");
    first.unmount();

    network({ [`origin/api/v1/auth/connect/session/${SESSION}`]: unlockPending, "origin/api/v1/users/me/secret-storage": () => ({ body: { items: [{ method: "recovery" }] } }) });
    const second = renderAt(`${sessionUrl()}#k=${KEY}`);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Mit Passkey entsperren" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Keiner deiner Passkeys");
    second.unmount();

    sessionStorage.clear();
    network({ [`origin/api/v1/auth/connect/session/${SESSION}`]: unlockPending });
    renderAt(sessionUrl());
    expect(await screen.findByText(/Entsperr-Link ist unvollständig/)).toBeInTheDocument();
  });

  it("malformed session links are refused", async () => {
    network();
    useAuth.setState({ token: "local", refresh: "r", user: localUser, deviceId: "D", home: null });
    renderAt(`/connect?session=short&state=${"s".repeat(22)}`);
    expect(await screen.findByText("Dieser Anmeldelink ist ungültig oder unvollständig.")).toBeInTheDocument();
  });
});

describe("after a sign-in on the node's page", () => {
  it("skips the encryption step only for the confirmation of an app session", async () => {
    const { afterSignIn, skipsEncryption } = await import("./ConnectPages");
    expect(skipsEncryption(`/connect?session=${"S".repeat(43)}&state=x`)).toBe(true);
    expect(skipsEncryption("/connect?origin=https%3A%2F%2Fa.example&state=x")).toBe(false);
    expect(skipsEncryption("/friends?session=1")).toBe(false);
    expect(afterSignIn("/friends")).toBe("/encryption?next=%2Ffriends");
    expect(afterSignIn(`/connect?session=${"S".repeat(43)}`)).toBe(`/connect?session=${"S".repeat(43)}`);
  });
});
