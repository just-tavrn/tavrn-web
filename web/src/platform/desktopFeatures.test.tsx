// SPDX-License-Identifier: Apache-2.0
/**
 * Flows that rely on the node's own origin do not run inside the desktop app (docs/DESKTOP.md "Limitations"):
 * passkeys, single sign-on, the captcha, web push. On nodes with app sessions (`connect.app`) the app hands them off
 * to the node's page (LoginPage.desktop.test.tsx); here the node offers none, so password with TOTP or a recovery
 * code is what works.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router";
import { resetPlatform, setPlatform } from "./index";
import type { Platform } from "./types";
import { passkeysSupported } from "../lib/passkeys";
import { pushSupported, registerServiceWorker } from "../lib/push";
import { startSso } from "../lib/sso";
import { publicApi } from "../lib/api";
import { Captcha } from "../components/Captcha";
import { LoginPage } from "../pages/LoginPage";
import { useAuth } from "../stores/auth";
import { mockFetch, renderWithProviders } from "../test/render";

const desktop: Platform = {
  kind: "desktop",
  isDesktop: true,
  nodeBase: () => "https://t.local",
  webOrigin: () => "https://t.local",
  openExternal: async () => {},
  appVersion: async () => "0.2.0",
  node: { current: () => "https://t.local", set: async () => {} },
};

const browserApis = () => {
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  Object.defineProperty(navigator, "credentials", { value: {}, configurable: true });
  Object.defineProperty(navigator, "serviceWorker", { value: { register: vi.fn(), addEventListener: vi.fn() }, configurable: true });
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("Notification", function Notification() {});
};

beforeEach(() => {
  browserApis();
  useAuth.getState().logout();
  sessionStorage.clear();
});

afterEach(() => {
  resetPlatform();
  vi.unstubAllGlobals();
  delete (navigator as unknown as Record<string, unknown>).credentials;
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
});

const ssoNode = (only = false) => ({ name: "Testknoten", domain: "t.local", registration: "open", sso: { label: "Firmen-Login", only } });

function renderLogin() {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
    </Routes>,
    { route: "/login" },
  );
}

describe("desktop app: flows bound to the node's origin", () => {
  it("the browser keeps passkeys and web push", () => {
    expect(passkeysSupported()).toBe(true);
    expect(pushSupported()).toBe(true);
  });

  it("passkeys in the Windows app only through the shell's native ceremony", () => {
    setPlatform({ ...desktop, passkeys: { create: vi.fn(), get: vi.fn() } });
    expect(passkeysSupported()).toBe(true);
    // Also without the webview's WebAuthn: the ceremony runs in the operating system.
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(passkeysSupported()).toBe(true);
  });

  it("offers no passkeys and no web push in the desktop app", async () => {
    setPlatform(desktop);
    expect(passkeysSupported()).toBe(false);
    expect(pushSupported()).toBe(false);
    await expect(registerServiceWorker()).resolves.toBeNull();
    expect((navigator.serviceWorker as unknown as { register: ReturnType<typeof vi.fn> }).register).not.toHaveBeenCalled();
  });

  it("does not start single sign-on in the desktop app", async () => {
    setPlatform(desktop);
    const calls = mockFetch({});
    await expect(startSso(publicApi, "login", "/")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("shows a notice instead of the captcha in the desktop app (no third-party scripts)", () => {
    setPlatform(desktop);
    const onToken = vi.fn();
    render(<Captcha siteKey="site" onToken={onToken} />);
    expect(screen.getByTestId("captcha-desktop")).toBeInTheDocument();
    expect(document.querySelector("script[src*='challenges.cloudflare.com']")).toBeNull();
  });

  it("login page in the browser: SSO and passkey buttons", async () => {
    mockFetch({ "/api/v1/node": { body: ssoNode() } });
    renderLogin();
    expect(await screen.findByTestId("sso-button")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mit Passkey anmelden" })).toBeInTheDocument();
  });

  it("login page in the desktop app: password and second factor only, from the chosen node", async () => {
    setPlatform(desktop);
    const calls = mockFetch({ "/api/v1/node": { body: ssoNode() } });
    renderLogin();
    expect(await screen.findByText("Testknoten (t.local)")).toBeInTheDocument();
    expect(screen.queryByTestId("sso-button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mit Passkey anmelden" })).toBeNull();
    expect(screen.getByLabelText("Passwort")).toBeInTheDocument();
    expect(calls[0]?.url).toBe("https://t.local/api/v1/node");
  });

  it("an SSO-only node explains that the desktop app cannot sign in there yet", async () => {
    setPlatform(desktop);
    mockFetch({ "/api/v1/node": { body: ssoNode(true) } });
    renderLogin();
    expect(await screen.findByTestId("sso-desktop")).toBeInTheDocument();
    expect(screen.queryByTestId("sso-button")).toBeNull();
    expect(screen.getByTestId("sso-break-glass")).toBeInTheDocument();
  });
});
