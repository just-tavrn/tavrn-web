// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Route, Routes } from "react-router";
import { SsoCallbackPage } from "./SsoCallbackPage";
import { LoginPage } from "./LoginPage";
import { useAuth } from "../stores/auth";
import { useAuthFlow } from "../stores/authFlow";
import { hasReauthToken, takeReauthToken, type PendingSso } from "../lib/sso";
import { mockFetch, renderWithProviders } from "../test/render";

const user = { id: "u1", username: "alice", domain: "t.local", address: "alice@t.local", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: false, has_password: false };
const session = { status: "ok", user, access_token: "acc", refresh_token: "ref", expires_in: 3600, device_id: "01J9ZK3G5M8Q2W4E6R8T0Y2VA1", recovery_code_used: false };
const STATE = "client-state-abcdefghijklmnop";

function pending(purpose: PendingSso["purpose"], next = "/rooms/x") {
  const p: PendingSso = { state: STATE, verifier: "v".repeat(43), purpose, next, startedAt: Date.now() };
  sessionStorage.setItem("tavrn.sso", JSON.stringify(p));
}

function renderAt(route: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/sso/callback" element={<SsoCallbackPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/encryption" element={<p>Verschlüsselungsseite</p>} />
      <Route path="/settings/security" element={<p>Sicherheit</p>} />
    </Routes>,
    { route },
  );
}

beforeEach(() => {
  useAuth.getState().logout();
  useAuthFlow.getState().setSetup(null);
  sessionStorage.clear();
});

describe("SsoCallbackPage", () => {
  it("exchanges code and verifier for a session and continues with the encryption step (no second factor)", async () => {
    pending("login");
    const calls = mockFetch({ "/api/v1/node": { body: { name: "N", domain: "t.local" } }, "/api/v1/auth/oidc/token": { body: session } });
    renderAt(`/sso/callback?code=one-time&state=${STATE}`);
    expect(await screen.findByText("Verschlüsselungsseite")).toBeInTheDocument();
    expect(useAuth.getState().token).toBe("acc");
    expect(useAuthFlow.getState().setup).toEqual({ kind: "login" });
    const exchange = calls.find((c) => c.url.includes("/auth/oidc/token"))!;
    expect(JSON.parse(exchange.init.body as string)).toEqual({ code: "one-time", code_verifier: "v".repeat(43), device: null });
    expect(sessionStorage.getItem("tavrn.sso")).toBeNull();
  });

  it("refuses a callback this tab did not start", async () => {
    pending("login");
    const calls = mockFetch({ "/api/v1/node": { body: {} } });
    renderAt("/sso/callback?code=one-time&state=forged-state-0000000000");
    expect(await screen.findByText(/nicht in diesem Tab gestartet/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/oidc/token"))).toBe(false);
    expect(useAuth.getState().token).toBeNull();
  });

  it("translates the node's error codes and shows the provider's error", async () => {
    pending("login");
    mockFetch({ "/api/v1/node": { body: {} } });
    renderAt(`/sso/callback?error=sso.idp_error&idp_error=access_denied&state=${STATE}`);
    expect(await screen.findByText("Der Identitätsanbieter hat die Anmeldung abgelehnt. (access_denied)")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByTestId("sso-back"));
  });

  it("shows exchange errors such as sso.not_provisioned", async () => {
    pending("login");
    mockFetch({ "/api/v1/node": { body: {} }, "/api/v1/auth/oidc/token": { status: 403, body: { code: "sso.not_provisioned", status: 403, title: "x", detail: "x", type: "x" } } });
    renderAt(`/sso/callback?code=c&state=${STATE}`);
    expect(await screen.findByText(/legt Konten nicht automatisch an/)).toBeInTheDocument();
  });

  it("returns to the settings after linking (with the session) and hands a reauth token over", async () => {
    useAuth.getState().setSession(session as never);
    pending("link", "/settings/security");
    const calls = mockFetch({ "/api/v1/node": { body: {} }, "/api/v1/auth/oidc/token": { body: { linked: true } } });
    const first = renderAt(`/sso/callback?code=c&state=${STATE}`);
    expect(await screen.findByText("Sicherheit")).toBeInTheDocument();
    expect((calls.find((c) => c.url.includes("/oidc/token"))!.init.headers as Record<string, string>).Authorization).toBe("Bearer acc");
    first.unmount();
    pending("reauth", "/settings/security");
    mockFetch({ "/api/v1/node": { body: {} }, "/api/v1/auth/oidc/token": { body: { reauth_token: "rt", expires_in: 300 } } });
    renderAt(`/sso/callback?code=c&state=${STATE}`);
    expect(await screen.findByText("Sicherheit")).toBeInTheDocument();
    expect(hasReauthToken()).toBe(true);
    expect(takeReauthToken()).toBe("rt");
  });
});

describe("LoginPage with single sign-on", () => {
  it("shows the SSO button next to the password form", async () => {
    mockFetch({ "/api/v1/node": { body: { name: "N", domain: "t.local", registration: "open", sso: { label: null, only: false } } } });
    renderAt("/login");
    expect(await screen.findByRole("button", { name: "Mit SSO anmelden" })).toBeInTheDocument();
    expect(screen.getByLabelText("Passwort")).toBeInTheDocument();
  });

  it("uses the operator's label", async () => {
    mockFetch({ "/api/v1/node": { body: { sso: { label: "Firmen-Login", only: false } } } });
    renderAt("/login");
    expect(await screen.findByRole("button", { name: "Firmen-Login" })).toBeInTheDocument();
  });

  it("TAVRN_OIDC_ONLY hides the password form behind the administrator sign-in", async () => {
    mockFetch({ "/api/v1/node": { body: { sso: { label: null, only: true } } } });
    renderAt("/login");
    expect(await screen.findByTestId("sso-only")).toBeInTheDocument();
    expect(screen.queryByLabelText("Passwort")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Anmeldung für Administratoren" }));
    expect(screen.getByLabelText("Passwort")).toBeInTheDocument();
  });

  it("offers the provider's logout after an SSO sign-out", async () => {
    sessionStorage.setItem("tavrn.sso.logout", "https://idp.example/logout?client_id=x");
    mockFetch({ "/api/v1/node": { body: { sso: { label: null, only: false } } } });
    renderAt("/login");
    const link = await screen.findByRole("link", { name: "Auch beim Identitätsanbieter abmelden" });
    expect(link).toHaveAttribute("href", "https://idp.example/logout?client_id=x");
  });
});
