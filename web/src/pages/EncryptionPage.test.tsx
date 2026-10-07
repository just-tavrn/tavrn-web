// SPDX-License-Identifier: Apache-2.0
import "fake-indexeddb/auto";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Route, Routes } from "react-router";
import { MasterSecret, RecoveryKey, wrapMasterSecret } from "@tavrn/crypto";
import { b64urlEncode } from "@tavrn/sdk";
import { EncryptionPage } from "./EncryptionPage";
import { useAuth } from "../stores/auth";
import { useAuthFlow } from "../stores/authFlow";
import { cryptoStore } from "../crypto/store";
import { mockFetch, renderWithProviders } from "../test/render";
import { initCryptoForTests } from "../test/wasm";

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
