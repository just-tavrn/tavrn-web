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
});
