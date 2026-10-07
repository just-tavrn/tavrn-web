// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { TavrnApi } from "@tavrn/sdk";
import { mockFetch } from "../test/render";
import { SSO_MAX_AGE_MS, checkSsoCallback, forgetSsoLogout, hasReauthToken, peekSsoLogout, rememberSsoLogout, setReauthToken, startSso, takePendingSso, takeReauthToken, withReauthToken, type PendingSso } from "./sso";

const pending: PendingSso = { state: "s".repeat(43), verifier: "v".repeat(43), purpose: "login", next: "/", startedAt: 1_000_000 };
const params = (q: string) => new URLSearchParams(q);

beforeEach(() => sessionStorage.clear());

describe("SSO flow helpers", () => {
  it("startSso sends a fresh S256 challenge and client state and remembers the verifier for this tab only", async () => {
    const calls = mockFetch({ "/api/v1/auth/oidc/start": { body: { authorization_url: "https://idp.example/authorize?x=1", expires_in: 600 } } });
    rememberSsoLogout("https://idp.example/logout");
    let went = "";
    await startSso(new TavrnApi({ baseUrl: "" }), "login", "//evil.example", (u) => (went = u));
    expect(went).toBe("https://idp.example/authorize?x=1");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.purpose).toBe("login");
    expect(body.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = takePendingSso()!;
    expect(stored.state).toBe(body.client_state);
    expect(stored.verifier).not.toBe(body.code_challenge);
    // No open redirect after the sign-in.
    expect(stored.next).toBe("/");
    expect(takePendingSso()).toBeNull();
    expect(peekSsoLogout()).toBeNull();
  });

  it("checks state, age and errors of the callback", () => {
    expect(checkSsoCallback(params(`code=c1&state=${pending.state}`), pending, 1_000_001)).toEqual({ ok: true, code: "c1" });
    expect(checkSsoCallback(params("code=c1&state=other"), pending, 1_000_001)).toEqual({ ok: false, reason: "state", error: undefined });
    expect(checkSsoCallback(params(`code=c1&state=${pending.state}`), null)).toMatchObject({ ok: false, reason: "state" });
    expect(checkSsoCallback(params(`code=c1&state=${pending.state}`), pending, 1_000_000 + SSO_MAX_AGE_MS + 1)).toMatchObject({ ok: false, reason: "state" });
    expect(checkSsoCallback(params(`error=sso.token_invalid&state=${pending.state}`), pending, 1_000_001)).toEqual({ ok: false, reason: "error", error: "sso.token_invalid" });
    expect(checkSsoCallback(params("error=sso.state_invalid"), null)).toEqual({ ok: false, reason: "error", error: "sso.state_invalid" });
    expect(checkSsoCallback(params(`state=${pending.state}`), pending, 1_000_001)).toMatchObject({ ok: false, reason: "state" });
  });

  it("hands the reauth token over once and sends it instead of the password", async () => {
    setReauthToken("rt-1", 300);
    expect(hasReauthToken()).toBe(true);
    expect(takeReauthToken()).toBe("rt-1");
    expect(takeReauthToken()).toBeNull();
    setReauthToken("old", -1);
    expect(takeReauthToken()).toBeNull();
    const calls = mockFetch({ "/api/v1/users/me/identity/reset": { status: 200, body: {} }, "/api/v1/users/me": { body: { id: "u" } } });
    const api = new TavrnApi({ baseUrl: "", getToken: () => "tok" });
    const wrapped = withReauthToken(api, "rt-2");
    await wrapped.keys.resetIdentity({ identity_public_key: "k", password: "ignored" });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ identity_public_key: "k", reauth_token: "rt-2" });
    await wrapped.users.me();
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("remembers only http(s) logout URLs", () => {
    rememberSsoLogout("javascript:alert(1)");
    expect(peekSsoLogout()).toBeNull();
    rememberSsoLogout("https://idp.example/logout?client_id=x");
    expect(peekSsoLogout()).toBe("https://idp.example/logout?client_id=x");
    forgetSsoLogout();
    expect(peekSsoLogout()).toBeNull();
  });
});
