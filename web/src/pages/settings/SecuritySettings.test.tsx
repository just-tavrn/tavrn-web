// SPDX-License-Identifier: Apache-2.0
import "fake-indexeddb/auto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router";
import { UserSettingsPage } from "../UserSettingsPage";
import { useAuth } from "../../stores/auth";
import { useE2ee } from "../../stores/e2ee";
import { cryptoStore } from "../../crypto/store";
import { mockFetch, renderWithProviders } from "../../test/render";
import { initCryptoForTests } from "../../test/wasm";
import { MasterSecret, verifyContinuity } from "@tavrn/crypto";
import { b64urlDecode, b64urlEncode } from "@tavrn/sdk";
import { ownIdentityPublicKey } from "@tavrn/e2ee";
import { resetPlatform, setPlatform } from "../../platform";
import { resetNodeWebauthn } from "../../lib/passkeys";

const DEV = "01J9ZK3G5M8Q2W4E6R8T0Y2VA1";
const user = { id: "u1", username: "sec", domain: "t.local", address: "sec@t.local", display_name: "S", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const factors = {
  totp: true,
  recovery_codes_left: 7,
  webauthn: [
    { id: "Y3JlZC0x", name: "YubiKey", created_at: "2026-10-01T10:00:00Z", last_used_at: null, prf_supported: true },
    { id: "Y3JlZC0y", name: "Laptop", created_at: "2026-10-02T10:00:00Z", last_used_at: "2026-10-03T10:00:00Z", prf_supported: false },
    { id: "Y3JlZC0z", name: "Handy", created_at: "2026-10-04T10:00:00Z", last_used_at: null, prf_supported: true },
  ],
};
/** The secret storage with the YubiKey's entry; a PUT of another passkey's entry adds it (as the node does). */
function secretStorage() {
  let items = [{ method: "passkey:Y3JlZC0x", wrapped: "x", params: {}, updated_at: "2026-10-01T10:00:00Z" }];
  return (init: RequestInit, url: string) => {
    if (init.method === "PUT" && url.includes("/passkey/")) {
      items = [...items, { method: `passkey:${decodeURIComponent(url.split("/passkey/")[1]!)}`, wrapped: "y", params: {}, updated_at: "2026-10-05T10:00:00Z" }];
      return { body: {} };
    }
    return { body: { items } };
  };
}
/** A WebAuthn assertion of `id` with a PRF output (the browser's `getClientExtensionResults`). */
const prfAssertion = (id: string) => ({ id, rawId: new Uint8Array(4).buffer, type: "public-key", response: { clientDataJSON: new Uint8Array(2).buffer, authenticatorData: new Uint8Array(2).buffer, signature: new Uint8Array(2).buffer, userHandle: null }, getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(32).fill(1).buffer } } }) });
const lastFactor = { status: 409, body: { code: "auth.last_factor", status: 409, title: "x", detail: "last", type: "x" } };

function renderSecurity() {
  return renderWithProviders(
    <Routes>
      <Route path="/settings/:tab?" element={<UserSettingsPage />} />
    </Routes>,
    { route: "/settings/security" },
  );
}

beforeAll(() => initCryptoForTests());
beforeEach(async () => {
  useAuth.setState({ token: "acc", refresh: "ref", user, deviceId: DEV });
  await cryptoStore.wipe(user.address);
  useE2ee.setState({ status: null });
});

describe("Security settings", () => {
  it("lists the factors with names, dates and what each passkey does for the messages, and the codes left", async () => {
    mockFetch({ "/auth/factors": { body: factors }, "/users/me/secret-storage": secretStorage() });
    renderSecurity();
    const list = await screen.findByTestId("passkey-list");
    await waitFor(() => expect(list.querySelectorAll("li")).toHaveLength(3));
    const yubi = within(list).getByText("YubiKey").closest("li")!;
    // Its secret storage entry exists: this one unlocks.
    await waitFor(() => expect(yubi).toHaveTextContent("entsperrt Nachrichten"));
    expect(yubi).toHaveTextContent("noch nie verwendet");
    expect(yubi).not.toHaveTextContent("kann Nachrichten");
    // No PRF at creation: the reason, no button.
    const laptop = within(list).getByText("Laptop").closest("li")!;
    expect(laptop).toHaveTextContent("zuletzt verwendet");
    expect(laptop).toHaveTextContent("kann Nachrichten nicht entsperren");
    expect(laptop).toHaveTextContent("PRF-Erweiterung beim Erstellen des Passkeys nicht aktiviert");
    expect(within(laptop).queryByRole("button", { name: /aktivieren/ })).toBeNull();
    // PRF enabled, no entry yet (registered on a locked device, or the assertion was cancelled): enable, once unlocked.
    const handy = within(list).getByText("Handy").closest("li")!;
    expect(handy).toHaveTextContent("noch nicht aktiviert");
    expect(handy).toHaveTextContent("Entsperre zuerst die verschlüsselten Nachrichten");
    expect(within(handy).getByRole("button", { name: "Nachrichten-Entsperrung aktivieren: Handy" })).toBeDisabled();
    expect(screen.getByTestId("totp-row")).toHaveTextContent("Aktiv");
    expect(screen.getByTestId("codes-left")).toHaveTextContent("Noch 7 Codes übrig");
    expect(screen.getByTestId("security-address")).toHaveTextContent("sec@t.local");
  });

  it("shows the last-factor guard clearly when removing a passkey or the authenticator app", async () => {
    const calls = mockFetch({ "/auth/webauthn/credentials/": lastFactor, "/auth/totp": lastFactor, "/auth/factors": { body: { ...factors, totp: true, webauthn: [factors.webauthn[0]] } } });
    renderSecurity();
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "YubiKey entfernen" }));
    const dialog = screen.getByRole("dialog");
    await u.click(within(dialog).getByRole("button", { name: "Entfernen" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Das ist dein letzter zweiter Faktor");
    await u.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    await u.click(within(screen.getByTestId("totp-row")).getByRole("button", { name: "Entfernen" }));
    const totpDialog = screen.getByRole("dialog");
    await u.type(within(totpDialog).getByLabelText("Passwort"), "pw-123456789");
    await u.click(within(totpDialog).getByRole("button", { name: "Entfernen" }));
    expect(await within(totpDialog).findByRole("alert")).toHaveTextContent("letzter zweiter Faktor");
    const del = calls.find((c) => c.url.endsWith("/auth/totp"))!;
    expect(del.init.method).toBe("DELETE");
    expect(JSON.parse(del.init.body as string)).toEqual({ password: "pw-123456789" });
  });

  it("regenerates the recovery codes after asking for the password", async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `cccc-dddd-000${i}`);
    const calls = mockFetch({ "/auth/recovery-codes/regenerate": { body: { recovery_codes: codes } }, "/auth/factors": { body: factors } });
    renderSecurity();
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Neue Codes erzeugen" }));
    const dialog = screen.getByRole("dialog");
    await u.type(within(dialog).getByLabelText("Passwort"), "pw-123456789");
    await u.click(within(dialog).getByRole("button", { name: "Erzeugen" }));
    expect(await within(dialog).findByTestId("recovery-codes")).toHaveTextContent("cccc-dddd-0009");
    expect(JSON.parse(calls.find((c) => c.url.includes("regenerate"))!.init.body as string)).toEqual({ password: "pw-123456789" });
    await u.click(within(dialog).getByLabelText("Ich habe die Codes sicher aufbewahrt"));
    await u.click(within(dialog).getByRole("button", { name: "Fertig" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lock on close and a new recovery key need an unlocked device", async () => {
    mockFetch({ "/auth/factors": { body: factors }, "/users/me/secret-storage/recovery": { body: {} } });
    renderSecurity();
    expect(await screen.findByTestId("e2ee-status")).toHaveTextContent("Auf diesem Gerät nicht eingerichtet");
    expect(screen.getByTestId("lock-on-close")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Neuen Wiederherstellungsschlüssel erzeugen" })).toBeDisabled();
  });

  it("toggles lock on close and regenerates the recovery key when unlocked", async () => {
    await cryptoStore.saveMaster(user.address, DEV, new Uint8Array(32).fill(3));
    const calls = mockFetch({ "/auth/factors": { body: factors }, "/users/me/secret-storage/recovery": { body: {} } });
    renderSecurity();
    await waitFor(() => expect(screen.getByTestId("e2ee-status")).toHaveTextContent("Entsperrt"));
    const u = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId("lock-on-close")).toBeEnabled());
    await u.click(screen.getByTestId("lock-on-close"));
    await waitFor(async () => expect(await cryptoStore.lockOnClose(user.address)).toBe(true));
    await u.click(screen.getByRole("button", { name: "Neuen Wiederherstellungsschlüssel erzeugen" }));
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByTestId("recovery-key-words");
    await u.click(within(dialog).getByLabelText("Ich habe meinen Wiederherstellungsschlüssel gesichert"));
    await u.click(within(dialog).getByRole("button", { name: "Neuen Schlüssel verwenden" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const put = calls.find((c) => c.url.endsWith("/secret-storage/recovery"))!;
    expect(put.init.method).toBe("PUT");
    expect(JSON.parse(put.init.body as string).wrapped).toMatch(/^[A-Za-z0-9_-]{82}$/);
  });

  it("enables the message unlock of a passkey: one PRF assertion with exactly that passkey, then its entry (unlocked device)", async () => {
    await cryptoStore.saveMaster(user.address, DEV, new Uint8Array(32).fill(3));
    const get = vi.fn(async () => prfAssertion("Y3JlZC0z"));
    Object.defineProperty(navigator, "credentials", { value: { get }, configurable: true });
    const calls = mockFetch({ "/auth/factors": { body: factors }, "/users/me/secret-storage": secretStorage() });
    renderSecurity();
    const list = await screen.findByTestId("passkey-list");
    const handy = await waitFor(() => within(list).getByText("Handy").closest("li")!);
    const u = userEvent.setup();
    const button = await within(handy).findByRole("button", { name: "Nachrichten-Entsperrung aktivieren: Handy" });
    await waitFor(() => expect(button).toBeEnabled());
    await u.click(button);
    await waitFor(() => expect(handy).toHaveTextContent("entsperrt Nachrichten"));
    expect(handy).not.toHaveTextContent("noch nicht aktiviert");
    const options = (get.mock.calls[0] as unknown as [CredentialRequestOptions])[0].publicKey!;
    expect(options.allowCredentials?.map((c) => b64urlEncode(new Uint8Array(c.id as ArrayBuffer)))).toEqual(["Y3JlZC0z"]);
    expect(options.userVerification).toBe("required");
    const put = calls.find((c) => c.init.method === "PUT" && c.url.includes("/secret-storage/passkey/"))!;
    expect(put.url).toMatch(/\/secret-storage\/passkey\/Y3JlZC0z$/);
    expect(JSON.parse(put.init.body as string).wrapped).toMatch(/^[A-Za-z0-9_-]{82}$/);
    // The other passkeys are untouched.
    expect(calls.filter((c) => c.init.method === "PUT")).toHaveLength(1);
  });

  it("says when the assertion gave no PRF output, and stores nothing", async () => {
    await cryptoStore.saveMaster(user.address, DEV, new Uint8Array(32).fill(3));
    const plain = { ...prfAssertion("Y3JlZC0z"), getClientExtensionResults: () => ({}) };
    Object.defineProperty(navigator, "credentials", { value: { get: vi.fn(async () => plain) }, configurable: true });
    const calls = mockFetch({ "/auth/factors": { body: factors }, "/users/me/secret-storage": secretStorage() });
    renderSecurity();
    const list = await screen.findByTestId("passkey-list");
    const handy = await waitFor(() => within(list).getByText("Handy").closest("li")!);
    const u = userEvent.setup();
    const button = await within(handy).findByRole("button", { name: "Nachrichten-Entsperrung aktivieren: Handy" });
    await waitFor(() => expect(button).toBeEnabled());
    await u.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("Handy hat hier keine PRF-Ausgabe geliefert");
    expect(calls.some((c) => c.init.method === "PUT")).toBe(false);
    expect(handy).toHaveTextContent("noch nicht aktiviert");
  });
});

describe("Security settings: security key rotation (ENCRYPTION.md §9a)", () => {
  it("is offered next to the reset only on an unlocked device", async () => {
    mockFetch({ "/auth/factors": { body: factors } });
    renderSecurity();
    expect(await screen.findByTestId("identity-key-section")).toHaveTextContent("Sicherheitsschlüssel");
    expect(screen.getByTestId("identity-rotate")).toBeDisabled();
    expect(screen.getByTestId("identity-reset-link")).toHaveAttribute("href", "/encryption?reset=1&next=%2Fsettings%2Fsecurity");
  });

  it("explains the difference to the reset and rotates with a statement signed by the current key", async () => {
    await cryptoStore.saveMaster(user.address, DEV, new Uint8Array(32).fill(3));
    const master = MasterSecret.fromBytes(new Uint8Array(32).fill(3));
    const current = b64urlEncode(master.identityPublicKey());
    master.free();
    const calls = mockFetch({
      "/auth/factors": { body: factors },
      "/users/sec/keys": { body: { user: user.address, kind: "user", identity_public_key: current, identity_reset_at: null, devices: [], retired: [], continuity: [], identity_generation: 0 } },
      "/users/me/identity/rotate": (init) => ({ body: { identity_public_key: JSON.parse(init.body as string).new_identity_public_key, identity_generation: 1 } }),
    });
    renderSecurity();
    const u = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId("identity-rotate")).toBeEnabled());
    await u.click(screen.getByTestId("identity-rotate"));
    const dialog = screen.getByTestId("identity-rotate-dialog");
    expect(dialog).toHaveTextContent("setze ihn stattdessen zurück");
    await u.click(within(dialog).getByTestId("identity-rotate-confirm"));
    await waitFor(() => expect(screen.queryByTestId("identity-rotate-dialog")).not.toBeInTheDocument());
    const body = JSON.parse(calls.find((c) => c.url.endsWith("/users/me/identity/rotate"))!.init.body as string);
    expect(body.continuity.old_key).toBe(current);
    expect(body.continuity.new_key).toBe(body.new_identity_public_key);
    expect(verifyContinuity(JSON.stringify(body.continuity))).toBe(true);
    expect(b64urlDecode(body.identity_blob)).toHaveLength(61);
    expect(await ownIdentityPublicKey(cryptoStore)).toBe(body.new_identity_public_key);
  });
});

describe("Security settings: single sign-on (APPLICATIONS.md §8.3)", () => {
  const sso = { "/api/v1/node": { body: { name: "N", domain: "t.local", sso: { label: null, only: false } } } };

  it("links the signed-in account through the provider", async () => {
    const calls = mockFetch({ ...sso, "/auth/factors": { body: factors }, "/auth/oidc/identity": { body: null }, "/auth/oidc/start": { body: { authorization_url: "https://idp.example/authorize", expires_in: 600 } } });
    renderSecurity();
    const section = await screen.findByTestId("sso-section");
    expect(await within(section).findByText("Dein Konto ist nicht mit dem Identitätsanbieter verknüpft.")).toBeInTheDocument();
    await userEvent.setup().click(within(section).getByRole("button", { name: "SSO-Konto verknüpfen" }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/auth/oidc/start"))).toBe(true));
    const start = calls.find((c) => c.url.includes("/auth/oidc/start"))!;
    expect(JSON.parse(start.init.body as string)).toMatchObject({ purpose: "link" });
    expect((start.init.headers as Record<string, string>).Authorization).toBe("Bearer acc");
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem("tavrn.sso")!)).toMatchObject({ purpose: "link", next: "/settings/security" }));
  });

  it("shows the linked identity and unlinks it; SSO-only accounts have no password form", async () => {
    useAuth.setState({ user: { ...user, has_password: false } });
    const calls = mockFetch({
      ...sso,
      "/auth/factors": { body: { totp: false, recovery_codes_left: 0, webauthn: [] } },
      "/auth/oidc/identity": (init) =>
        init.method === "DELETE"
          ? { status: 409, body: { code: "sso.last_login_method", status: 409, title: "x", detail: "x", type: "x" } }
          : { body: { issuer: "https://idp.example", linked_at: "2026-10-01T10:00:00Z", last_login_at: null } },
    });
    renderSecurity();
    expect(await screen.findByTestId("sso-linked")).toHaveTextContent("https://idp.example");
    expect(screen.queryByText("Passwort ändern")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Trennen" }));
    expect(await screen.findByText(/einzige Anmeldemöglichkeit/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/auth/oidc/identity") && c.init.method === "DELETE")).toBe(true);
  });

  it("is hidden on nodes without a provider", async () => {
    mockFetch({ "/api/v1/node": { body: { name: "N", domain: "t.local", sso: null } }, "/auth/factors": { body: factors } });
    renderSecurity();
    await screen.findByTestId("passkey-list");
    expect(screen.queryByTestId("sso-section")).toBeNull();
    expect(screen.getByText("Passwort ändern")).toBeInTheDocument();
  });
});

describe("Security settings in the Linux app (passkeys on a security key)", () => {
  afterEach(() => {
    resetPlatform();
    resetNodeWebauthn();
  });

  it("asks to plug in a security key and offers the passkey form once one is there", async () => {
    let keys = { present: 0, usable: 0 };
    const node = "https://t.local";
    setPlatform({
      kind: "desktop",
      isDesktop: true,
      nodeBase: () => node,
      webOrigin: () => node,
      openExternal: vi.fn(async () => {}),
      appVersion: async () => "0.4.0",
      node: { current: () => node, set: vi.fn(async () => {}), resolve: vi.fn(), domain: () => null },
      passkeys: { create: vi.fn(), get: vi.fn(), securityKeys: vi.fn(async () => keys) },
    });
    mockFetch({ "/auth/factors": { body: factors } });
    renderSecurity();
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Passkey hinzufügen" }));
    expect(await screen.findByTestId("passkey-insert-key")).toHaveTextContent("Sicherheitsschlüssel");
    keys = { present: 1, usable: 0 };
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByTestId("passkey-insert-key")).toHaveTextContent("udev");
    keys = { present: 1, usable: 1 };
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByLabelText("Name des Passkeys")).toBeInTheDocument();
    expect(screen.queryByTestId("passkey-insert-key")).toBeNull();
  });
});
