// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearReauth, currentReauth, finishReauth, requestReauth, setReauth, useReauth } from "./reauth";
import { useAuth } from "./auth";

afterEach(() => {
  clearReauth();
  useReauth.setState({ pending: null });
  vi.useRealTimers();
});

describe("reauth store (PROTOCOL.md §5c)", () => {
  it("keeps a token until shortly before it expires", () => {
    vi.useFakeTimers();
    setReauth("rt", 300);
    expect(currentReauth()).toBe("rt");
    vi.advanceTimersByTime(289_000);
    expect(currentReauth()).toBe("rt");
    vi.advanceTimersByTime(2_000);
    expect(currentReauth()).toBeNull();
  });

  it("shares one confirmation between concurrent requests and drops the refused token", async () => {
    setReauth("stale");
    const a = requestReauth(["password"]);
    const b = requestReauth(["password"]);
    expect(currentReauth()).toBeNull();
    expect(useReauth.getState().pending?.methods).toEqual(["password"]);
    setReauth("fresh");
    finishReauth(true);
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(useReauth.getState().pending).toBeNull();
    const c = requestReauth(["webauthn"]);
    finishReauth(false);
    expect(await c).toBe(false);
  });

  it("takes the login's token and forgets it on sign-out", () => {
    useAuth.getState().setSession({ access_token: "a", refresh_token: "r", device_id: "D", expires_in: 3600, status: "ok", recovery_code_used: false, reauth_token: "login-rt", user: { address: "alice@t.local" } } as never);
    expect(currentReauth()).toBe("login-rt");
    useAuth.getState().logout();
    expect(currentReauth()).toBeNull();
  });
});
