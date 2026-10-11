// SPDX-License-Identifier: Apache-2.0
import "fake-indexeddb/auto";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router";
import { MasterSecret, RecoveryKey, passkeyMethod, passkeyWrappingKey, wrapMasterSecret } from "@tavrn/crypto";
import { b64urlEncode } from "@tavrn/sdk";
import { EncryptionPage } from "./EncryptionPage";
import { useAuth } from "../stores/auth";
import { useAuthFlow } from "../stores/authFlow";
import { cryptoStore } from "../crypto/store";
import { mockFetch, renderWithProviders } from "../test/render";
import { initCryptoForTests } from "../test/wasm";
import { resetPlatform, setPlatform, type NodePageUnlock, type Platform } from "../platform";

const DEV = "01J9ZK3G5M8Q2W4E6R8T0Y2VA1";
let n = 0;

function signIn(hasIdentity: boolean) {
  const username = `enc${++n}`;
  const user = { id: "u1", username, domain: "t.local", address: `${username}@t.local`, display_name: "A", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: hasIdentity };
  useAuth.setState({ token: "acc", refresh: "ref", user, deviceId: DEV });
  return user;
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/encryption" element={<EncryptionPage />} />
      <Route path="/rooms/x" element={<p>Raumseite</p>} />
    </Routes>,
    { route: "/encryption?next=%2Frooms%2Fx" },
  );
}

const json = (c: { init: RequestInit }) => JSON.parse(c.init.body as string) as Record<string, unknown>;

beforeAll(() => initCryptoForTests());
beforeEach(() => {
  cryptoStore.lock();
  useAuthFlow.getState().setSetup(null);
});

describe("EncryptionPage", () => {
  it("new account: shows the recovery key, requires the confirmation, then sets up keys and continues", async () => {
    const user = signIn(false);
    useAuthFlow.getState().setSetup({ kind: "register" });
    let identity: string | null = null;
    const calls = mockFetch({
      "/users/me/identity": (init) => ((identity = (JSON.parse(init.body as string) as { identity_public_key: string }).identity_public_key), { body: {} }),
      "/users/me/secret-storage/recovery": { body: {} },
      // No recovery entry yet: the account is not set up (setup refuses otherwise).
      "/users/me/secret-storage": { body: { items: [] } },
      [`/users/me/devices/${DEV}/key-packages`]: (init) => ({ body: { count: init.method === "POST" ? 20 : 0 } }),
      [`/users/me/devices/${DEV}/key`]: { body: {} },
      [`/users/${user.username}/keys`]: () => ({ body: { user: user.address, identity_public_key: identity, devices: [] } }),
      "/auth/factors": { body: { totp: true, webauthn: [], recovery_codes_left: 10 } },
      "/api/v1/users/me": () => ({ body: { ...user, has_identity_key: identity !== null } }),
    });
    renderPage();
    expect(await screen.findByRole("heading", { name: "Dein Wiederherstellungsschlüssel" })).toBeInTheDocument();
    expect(screen.getByTestId("wizard-steps")).toHaveTextContent("Schritt 4 von 4");
    expect(screen.getByTestId("encryption-account")).toHaveTextContent(user.address);
    const words = (await screen.findByTestId("recovery-key-words")).getAttribute("data-words")!;
    expect(words.split(" ")).toHaveLength(24);
    expect(screen.getByTestId("recovery-key-compact").textContent).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const finish = screen.getByRole("button", { name: "Einrichtung abschließen" });
    expect(finish).toBeDisabled();
    const u = userEvent.setup();
    await u.click(screen.getByLabelText("Ich habe meinen Wiederherstellungsschlüssel gesichert"));
    await u.click(finish);
    expect(await screen.findByText("Raumseite")).toBeInTheDocument();
    expect(identity).toBeTruthy();
    expect(cryptoStore.isUnlocked(user.address)).toBe(true);
    expect(useAuth.getState().user?.has_identity_key).toBe(true);
    const kp = calls.find((c) => c.url.endsWith("/key-packages") && c.init.method === "POST")!;
    expect(json(kp).key_packages).toHaveLength(20);
    // The recovery key itself never goes to the node.
    for (const c of calls) expect(String(c.init.body ?? "")).not.toContain(words.split(" ")[0]! + " " + words.split(" ")[1]!);
  });

  it("existing account on a new device: unlocks with the recovery key, rejects a wrong one", async () => {
    const user = signIn(true);
    const master = MasterSecret.generate();
    const recovery = RecoveryKey.generate();
    const wrapped = b64urlEncode(wrapMasterSecret(master, recovery.wrappingKey(), user.address, "recovery"));
    const identity = b64urlEncode(master.identityPublicKey());
    mockFetch({
      "/users/me/secret-storage": { body: { items: [{ method: "recovery", wrapped, params: {}, updated_at: "" }] } },
      [`/users/me/devices/${DEV}/key-packages`]: (init) => ({ body: { count: init.method === "POST" ? 20 : 0 } }),
      [`/users/me/devices/${DEV}/key`]: { body: {} },
      [`/users/${user.username}/keys`]: { body: { user: user.address, identity_public_key: identity, devices: [] } },
      "/api/v1/users/me": { body: user },
    });
    renderPage();
    expect(await screen.findByRole("heading", { name: "Verschlüsselte Nachrichten entsperren" })).toBeInTheDocument();
    const u = userEvent.setup();
    await u.type(await screen.findByTestId("recovery-key-input"), RecoveryKey.generate().toWords());
    await u.click(screen.getByRole("button", { name: "Entsperren" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("gehört nicht zu deinem Konto");
    await u.clear(screen.getByTestId("recovery-key-input"));
    await u.type(screen.getByTestId("recovery-key-input"), recovery.toCompact());
    await u.click(screen.getByRole("button", { name: "Entsperren" }));
    expect(await screen.findByText("Raumseite")).toBeInTheDocument();
    expect(cryptoStore.masterSecret()).toEqual(master.toBytes());
  });

  it("a node that says \"no identity key\" to a device with locked local data gets the unlock screen, not a new setup", async () => {
    const user = signIn(false);
    const master = MasterSecret.generate();
    await cryptoStore.saveMaster(user.address, DEV, master.toBytes(), { lockOnClose: true });
    cryptoStore.lock();
    mockFetch({ "/users/me/secret-storage": { body: { items: [] } }, "/api/v1/users/me": { body: user } });
    renderPage();
    expect(await screen.findByRole("heading", { name: "Verschlüsselte Nachrichten entsperren" })).toBeInTheDocument();
    expect(screen.queryByTestId("recovery-key-words")).not.toBeInTheDocument();
    // The local data is still there.
    expect(await cryptoStore.status(user.address)).toBe("locked");
  });

  it("offers the degraded mode and the identity reset with a warning", async () => {
    const user = signIn(true);
    mockFetch({ "/users/me/secret-storage": { body: { items: [] } }, "/api/v1/users/me": { body: user } });
    renderPage();
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: /Identität zurücksetzen/ }));
    expect(screen.getByTestId("reset-warning")).toHaveTextContent("endgültig unlesbar");
    await u.type(screen.getByLabelText("Passwort"), "pw-123456789");
    await u.click(screen.getByRole("button", { name: "Weiter" }));
    expect(await screen.findByTestId("recovery-key-words")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Zurück" }));
    await u.click(screen.getByRole("button", { name: "Zurück" }));
    await u.click(screen.getByTestId("skip-unlock"));
    expect(await screen.findByText("Raumseite")).toBeInTheDocument();
    expect(sessionStorage.getItem("tavrn.e2ee.skip")).toBe("1");
  });
});

describe("EncryptionPage in the desktop app: passkey unlock on the node's page", () => {
  const CRED = "Y3JlZC1hcHA";
  const prf = () => new Uint8Array(32).fill(3);

  function desktop(unlock: (req: NodePageUnlock) => Promise<{ credentialId: string; prf: Uint8Array } | null>) {
    const fn = vi.fn(unlock);
    const platform: Platform = {
      kind: "desktop",
      isDesktop: true,
      nodeBase: () => "https://t.local",
      webOrigin: () => "https://t.local",
      openExternal: async () => {},
      appVersion: async () => "0.2.0",
      auth: { signInOnNodePage: async () => null, unlockOnNodePage: fn },
    };
    setPlatform(platform);
    return fn;
  }

  function account() {
    const user = signIn(true);
    const master = MasterSecret.generate();
    const wrapped = b64urlEncode(wrapMasterSecret(master, passkeyWrappingKey(prf()), user.address, passkeyMethod(CRED)));
    const routes = {
      "/.well-known/tavrn": { body: { tavrn: 1, domain: "t.local", api: "https://t.local/api/v1", ws: "wss://t.local/api/v1/ws", web: "https://t.local", capabilities: ["connect.app"] } },
      "/users/me/secret-storage": { body: { items: [{ method: passkeyMethod(CRED), wrapped, params: {}, updated_at: "" }] } },
      [`/users/me/devices/${DEV}/key-packages`]: (init: RequestInit) => ({ body: { count: init.method === "POST" ? 20 : 0 } }),
      [`/users/me/devices/${DEV}/key`]: { body: {} },
      [`/users/${user.username}/keys`]: { body: { user: user.address, identity_public_key: b64urlEncode(master.identityPublicKey()), devices: [] } },
      "/api/v1/users/me": { body: user },
    };
    return { user, master, routes };
  }

  afterEach(() => resetPlatform());

  it("opens the node's page for the passkey, waits with Cancel and unlocks with the sealed PRF output", async () => {
    const { master, routes } = account();
    let finish: (v: { credentialId: string; prf: Uint8Array } | null) => void = () => {};
    const unlock = desktop(() => new Promise((resolve) => (finish = resolve)));
    mockFetch(routes);
    renderPage();
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Mit Passkey entsperren" }));
    expect(await screen.findByTestId("unlock-waiting")).toHaveTextContent("t.local");
    // No second form while the window is open.
    expect(screen.queryByTestId("recovery-key-input")).toBeNull();
    expect(unlock.mock.calls[0]![0].endpoints).toMatchObject({ domain: "t.local", web: "https://t.local" });
    expect(unlock.mock.calls[0]![0].api).toBeTruthy();
    finish({ credentialId: CRED, prf: prf() });
    expect(await screen.findByText("Raumseite")).toBeInTheDocument();
    expect(cryptoStore.masterSecret()).toEqual(master.toBytes());
  });

  it("cancel returns to the recovery key; a node without unlock sessions says so", async () => {
    const { routes } = account();
    const unlock = desktop((req) => new Promise((resolve) => req.signal?.addEventListener("abort", () => resolve(null))));
    mockFetch(routes);
    renderPage();
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Mit Passkey entsperren" }));
    await u.click(await screen.findByRole("button", { name: "Abbrechen" }));
    expect(await screen.findByTestId("recovery-key-input")).toBeInTheDocument();
    expect(unlock.mock.calls[0]![0].signal?.aborted).toBe(true);

    unlock.mockImplementation(async () => {
      throw Object.assign(new Error("unsupported"), { problem: { code: "connect.unlock_unsupported" } });
    });
    await u.click(screen.getByRole("button", { name: "Mit Passkey entsperren" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("noch nicht mit einem Passkey");
    expect(screen.getByTestId("recovery-key-input")).toBeInTheDocument();
  });

  it("without a passkey entry or app sessions there is no passkey button", async () => {
    const { routes } = account();
    desktop(async () => null);
    mockFetch({ ...routes, "/.well-known/tavrn": { body: { tavrn: 1, domain: "t.local", capabilities: [] } } });
    renderPage();
    expect(await screen.findByTestId("recovery-key-input")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("button", { name: "Mit Passkey entsperren" })).toBeNull();
  });
});
