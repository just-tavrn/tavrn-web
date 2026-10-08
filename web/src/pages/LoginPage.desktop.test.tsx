// SPDX-License-Identifier: Apache-2.0
/**
 * The desktop app's login page (docs/DESKTOP.md "Signing in"): what cannot run in the app (passkeys, single sign-on,
 * the captcha) is handed off to the node's own page (app sessions of the connect flow, FEDERATION.md §8 step 3), and
 * an address `alice@home.example` finds its node (FEDERATION.md §1.4, resolved by the shell).
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router";
import type { AuthResponse } from "@tavrn/sdk";
import { LoginPage } from "./LoginPage";
import { resetPlatform, setPlatform } from "../platform";
import type { NodePageSignIn, Platform, ResolvedNode } from "../platform";
import { useAuth } from "../stores/auth";
import { useAuthFlow } from "../stores/authFlow";
import { mockFetch, renderWithProviders } from "../test/render";

vi.mock("../crypto/e2ee", async (original) => ({ ...(await original<typeof import("../crypto/e2ee")>()), deviceProofFor: vi.fn(async () => null) }));

const user = { id: "u1", username: "alice", domain: "t.local", address: "alice@t.local", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const session = { status: "ok", user, access_token: "acc", refresh_token: "ref", expires_in: 3600, device_id: "D1", recovery_code_used: false } as unknown as AuthResponse;

interface Fake {
  platform: Platform;
  signIn: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
  /** Settles the running sign-in. */
  finish: (s: AuthResponse | null | Error) => void;
  last: () => NodePageSignIn;
}

function desktop(): Fake {
  let node = "https://t.local";
  let settle: ((s: AuthResponse | null | Error) => void) | null = null;
  const signIn = vi.fn(
    (req: NodePageSignIn) =>
      new Promise<AuthResponse | null>((resolve, reject) => {
        req.onPage?.("https://t.local/connect?session=S&state=x");
        req.signal?.addEventListener("abort", () => resolve(null));
        settle = (s) => (s instanceof Error ? reject(s) : resolve(s));
      }),
  );
  const set = vi.fn(async (url: string) => {
    node = url;
  });
  const resolve = vi.fn(async (domain: string): Promise<ResolvedNode> => {
    if (domain === "nowhere.example") throw { code: "resolve.not_found", step: "direct", domain };
    return { domain, api: `https://app.${domain}/api/v1`, ws: `wss://app.${domain}/api/v1/ws`, web: `https://web.${domain}`, source: "well_known" };
  });
  const openExternal = vi.fn(async () => {});
  const platform: Platform = {
    kind: "desktop",
    isDesktop: true,
    nodeBase: () => node,
    webOrigin: () => node,
    openExternal,
    appVersion: async () => "0.2.0",
    node: { current: () => node, set, resolve, domain: () => null },
    auth: { signInOnNodePage: signIn, reopen: vi.fn(async () => {}) },
  };
  setPlatform(platform);
  return { platform, signIn, set, resolve, openExternal, finish: (s) => settle?.(s), last: () => signIn.mock.calls.at(-1)![0] as NodePageSignIn };
}

const nodeInfo = (extra: Record<string, unknown> = {}) => ({ name: "Testknoten", domain: "t.local", registration: "open", ...extra });
const wellKnown = (caps: string[]) => ({ tavrn: 1, domain: "t.local", api: "https://t.local/api/v1", ws: "wss://t.local/api/v1/ws", web: "https://t.local", capabilities: caps });

function renderLogin(route = "/login") {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/encryption" element={<p>Verschlüsselungsseite</p>} />
    </Routes>,
    { route },
  );
}

beforeEach(() => {
  useAuth.getState().logout();
  useAuthFlow.getState().clearPreauth();
  useAuthFlow.getState().setSetup(null);
  sessionStorage.clear();
});

afterEach(() => {
  resetPlatform();
  vi.unstubAllGlobals();
});

describe("desktop login: sign-in on the node's page", () => {
  it("offers the node's page, waits for it and continues like any sign-in", async () => {
    const fake = desktop();
    mockFetch({ "/api/v1/node": { body: nodeInfo() }, "/.well-known/tavrn": { body: wellKnown(["connect.app"]) } });
    renderLogin();
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Auf der Seite von t.local anmelden" }));
    expect(await screen.findByTestId("handoff-waiting")).toHaveTextContent("t.local");
    const req = fake.last();
    expect(req.mode).toBe("login");
    expect(req.endpoints).toEqual({ domain: "t.local", base: "https://t.local", ws: "wss://t.local/api/v1/ws", web: "https://t.local" });
    await u.click(screen.getByRole("button", { name: "Stattdessen im Browser öffnen" }));
    expect(fake.openExternal).toHaveBeenCalledWith("https://t.local/connect?session=S&state=x");
    fake.finish(session);
    expect(await screen.findByText("Verschlüsselungsseite")).toBeInTheDocument();
    expect(useAuth.getState().token).toBe("acc");
  });

  it("passkeys and single sign-on go to the node's page", async () => {
    const fake = desktop();
    const calls = mockFetch({ "/api/v1/node": { body: nodeInfo({ sso: { label: "Firmen-Login", only: false } }) }, "/.well-known/tavrn": { body: wellKnown(["connect.app", "sso.oidc"]) } });
    renderLogin();
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Mit Passkey anmelden" }));
    expect(await screen.findByTestId("handoff-waiting")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Abbrechen" }));
    await u.click(await screen.findByTestId("sso-button"));
    await waitFor(() => expect(fake.signIn).toHaveBeenCalledTimes(2));
    expect(calls.some((c) => c.url.includes("/auth/oidc/start"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/auth/webauthn"))).toBe(false);
  });

  it("a registration with a captcha happens on the node's page", async () => {
    const fake = desktop();
    mockFetch({ "/api/v1/node": { body: nodeInfo({ captcha: { provider: "turnstile", site_key: "k", login: false, register: true } }) }, "/.well-known/tavrn": { body: wellKnown(["connect.app"]) } });
    renderLogin();
    const u = userEvent.setup();
    await u.click(await screen.findByRole("tab", { name: "Registrieren" }));
    expect(screen.getByTestId("node-page-required")).toHaveTextContent("Captcha");
    expect(screen.queryByLabelText("Passwort wiederholen")).toBeNull();
    expect(document.querySelector("script[src*='challenges.cloudflare.com']")).toBeNull();
    await u.click(screen.getByRole("button", { name: "Auf der Seite von t.local registrieren" }));
    await waitFor(() => expect(fake.last().mode).toBe("register"));
  });

  it("says when the window cannot use passkeys (Linux) and recovers from a failed sign-in", async () => {
    vi.stubGlobal("navigator", { ...navigator, userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15" });
    const fake = desktop();
    mockFetch({ "/api/v1/node": { body: nodeInfo() }, "/.well-known/tavrn": { body: wellKnown(["connect.app"]) } });
    renderLogin();
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Auf der Seite von t.local anmelden" }));
    expect(await screen.findByTestId("handoff-linux")).toHaveTextContent("Browser");
    fake.finish(new Error("boom"));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    await u.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(fake.signIn).toHaveBeenCalledTimes(2));
  });

  it("without app sessions on the node: password and second factor only", async () => {
    desktop();
    mockFetch({ "/api/v1/node": { body: nodeInfo() }, "/.well-known/tavrn": { body: wellKnown([]) } });
    renderLogin();
    expect(await screen.findByLabelText("Passwort")).toBeInTheDocument();
    await screen.findByText("Testknoten (t.local)");
    expect(screen.queryByRole("button", { name: "Auf der Seite von t.local anmelden" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mit Passkey anmelden" })).toBeNull();
  });
});

describe("desktop login: address first", () => {
  it("an address of another node finds that node, switches to it and signs in there", async () => {
    const fake = desktop();
    const calls = mockFetch({
      "/api/v1/node": { body: nodeInfo() },
      "/.well-known/tavrn": { body: wellKnown(["connect.app"]) },
      "/api/v1/auth/login": { body: { status: "second_factor_required", preauth_token: "pre", methods: ["totp"], expires_in: 600 } },
    });
    renderLogin();
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText("Benutzername oder Adresse"), "Alice@Home.Example");
    await u.type(screen.getByLabelText("Passwort"), "pw");
    await u.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByLabelText("6-stelliger Code")).toBeInTheDocument();
    expect(fake.resolve).toHaveBeenCalledWith("home.example");
    expect(fake.set).toHaveBeenCalledWith("https://app.home.example", { domain: "home.example", web: "https://web.home.example" });
    const login = calls.find((c) => c.url.endsWith("/auth/login"))!;
    expect(login.url).toBe("https://app.home.example/api/v1/auth/login");
    expect(JSON.parse(String(login.init.body))).toMatchObject({ username: "alice", password: "pw" });
  });

  it("the node's own address is just the username", async () => {
    const fake = desktop();
    const calls = mockFetch({ "/api/v1/node": { body: nodeInfo() }, "/.well-known/tavrn": { body: wellKnown([]) }, "/api/v1/auth/login": { body: { status: "second_factor_required", preauth_token: "pre", methods: ["totp"], expires_in: 600 } } });
    renderLogin("/login?username=alice");
    const u = userEvent.setup();
    expect(await screen.findByLabelText("Benutzername oder Adresse")).toHaveValue("alice");
    await u.clear(screen.getByLabelText("Benutzername oder Adresse"));
    await u.type(screen.getByLabelText("Benutzername oder Adresse"), "alice@t.local");
    await u.type(screen.getByLabelText("Passwort"), "pw");
    await u.click(screen.getByRole("button", { name: "Anmelden" }));
    await screen.findByLabelText("6-stelliger Code");
    expect(fake.resolve).not.toHaveBeenCalled();
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/auth/login"))!.init.body))).toMatchObject({ username: "alice" });
  });

  it("says which step found no node", async () => {
    const fake = desktop();
    mockFetch({ "/api/v1/node": { body: nodeInfo() }, "/.well-known/tavrn": { body: wellKnown([]) } });
    renderLogin();
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText("Benutzername oder Adresse"), "alice@nowhere.example");
    await u.type(screen.getByLabelText("Passwort"), "pw");
    await u.click(screen.getByRole("button", { name: "Anmelden" }));
    const alert = await screen.findByText(/Kein Knoten für nowhere.example gefunden/);
    expect(alert).toHaveTextContent("https://nowhere.example/api/v1");
    expect(fake.set).not.toHaveBeenCalled();
  });
});
