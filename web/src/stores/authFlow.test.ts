// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { useAuthFlow } from "./authFlow";

describe("authFlow store", () => {
  beforeEach(() => {
    sessionStorage.clear();
    useAuthFlow.getState().refresh();
  });

  it("keeps the pre-auth step in sessionStorage with its expiry", () => {
    useAuthFlow.getState().startPreauth({ status: "enrollment_required", preauth_token: "jwt", methods: ["totp", "webauthn"], expires_in: 600 }, "register", "alice");
    const stored = JSON.parse(sessionStorage.getItem("tavrn.preauth")!);
    expect(stored).toMatchObject({ token: "jwt", status: "enrollment_required", kind: "register", username: "alice" });
    expect(stored.expiresAt).toBeGreaterThan(Date.now() + 590_000);
    useAuthFlow.setState({ preauth: null });
    useAuthFlow.getState().refresh();
    expect(useAuthFlow.getState().preauth?.token).toBe("jwt");
    useAuthFlow.getState().clearPreauth();
    expect(sessionStorage.getItem("tavrn.preauth")).toBeNull();
  });

  it("drops expired or malformed state", () => {
    sessionStorage.setItem("tavrn.preauth", JSON.stringify({ token: "jwt", expiresAt: Date.now() - 1 }));
    useAuthFlow.getState().refresh();
    expect(useAuthFlow.getState().preauth).toBeNull();
    expect(sessionStorage.getItem("tavrn.preauth")).toBeNull();
    sessionStorage.setItem("tavrn.preauth", "{kaputt");
    useAuthFlow.getState().refresh();
    expect(useAuthFlow.getState().preauth).toBeNull();
  });

  it("remembers which wizard the setup belongs to", () => {
    useAuthFlow.getState().setSetup({ kind: "register" });
    useAuthFlow.setState({ setup: null });
    useAuthFlow.getState().refresh();
    expect(useAuthFlow.getState().setup).toEqual({ kind: "register" });
    useAuthFlow.getState().setSetup(null);
    expect(sessionStorage.getItem("tavrn.setup")).toBeNull();
  });
});
