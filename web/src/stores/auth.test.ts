// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { useAuth } from "./auth";

afterEach(() => useAuth.getState().logout());

describe("auth store across tabs (PROTOCOL.md §5b)", () => {
  it("adopts tokens another tab rotated and follows its sign-out", () => {
    useAuth.getState().setSession({ access_token: "a1", refresh_token: "r1", device_id: "D", expires_in: 3600, status: "ok", recovery_code_used: false, user: { address: "alice@t.local" } } as never);
    // Another tab stores the rotated pair; the browser announces it with a storage event.
    const stored = JSON.parse(localStorage.getItem("tavrn.auth")!);
    localStorage.setItem("tavrn.auth", JSON.stringify({ ...stored, token: "a2", refresh: "r2" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "tavrn.auth" }));
    expect(useAuth.getState()).toMatchObject({ token: "a2", refresh: "r2", deviceId: "D" });
    localStorage.setItem("tavrn.auth", JSON.stringify({ token: null, refresh: null, user: null, deviceId: null, home: null }));
    window.dispatchEvent(new StorageEvent("storage", { key: "tavrn.auth" }));
    expect(useAuth.getState().token).toBeNull();
    // Other keys are ignored.
    window.dispatchEvent(new StorageEvent("storage", { key: "something.else" }));
    expect(useAuth.getState().token).toBeNull();
  });

  // A profile or device update of a running request must not write the session back after it left the storage
  // (signed out in another tab, the storage cleared): the next load would be signed in again (tavrn-web#226).
  it("a profile update does not restore a session removed from the storage", () => {
    useAuth.getState().setSession({ access_token: "a1", refresh_token: "r1", device_id: "D", expires_in: 3600, status: "ok", recovery_code_used: false, user: { address: "alice@t.local" } } as never);
    localStorage.removeItem("tavrn.auth");
    useAuth.getState().setUser({ address: "alice@t.local", display_name: "Alice" } as never);
    expect(localStorage.getItem("tavrn.auth")).toBeNull();
    expect(useAuth.getState()).toMatchObject({ token: null, refresh: null, user: null });
    useAuth.getState().setSession({ access_token: "a1", refresh_token: "r1", device_id: null, expires_in: 3600, status: "ok", recovery_code_used: false, user: { address: "alice@t.local" } } as never);
    localStorage.setItem("tavrn.auth", JSON.stringify({ token: null, refresh: null, user: null, deviceId: null, home: null }));
    useAuth.getState().setDeviceId("D");
    expect(JSON.parse(localStorage.getItem("tavrn.auth")!).token).toBeNull();
    expect(useAuth.getState().token).toBeNull();
  });

  it("a profile update keeps the tokens another tab rotated meanwhile", () => {
    useAuth.getState().setSession({ access_token: "a1", refresh_token: "r1", device_id: "D", expires_in: 3600, status: "ok", recovery_code_used: false, user: { address: "alice@t.local" } } as never);
    // Another tab rotated the pair; its storage event has not arrived yet.
    const stored = JSON.parse(localStorage.getItem("tavrn.auth")!);
    localStorage.setItem("tavrn.auth", JSON.stringify({ ...stored, token: "a2", refresh: "r2" }));
    useAuth.getState().setUser({ address: "alice@t.local", display_name: "Alice" } as never);
    expect(JSON.parse(localStorage.getItem("tavrn.auth")!)).toMatchObject({ token: "a2", refresh: "r2", deviceId: "D", user: { display_name: "Alice" } });
    expect(useAuth.getState()).toMatchObject({ token: "a2", refresh: "r2", user: { display_name: "Alice" } });
  });
});
