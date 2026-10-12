// SPDX-License-Identifier: Apache-2.0
/**
 * Passkeys in the Linux app (docs/DESKTOP.md "Passkeys on Linux"): the shell runs them natively with FIDO2 security keys
 * over USB only, so the app offers them while a key is plugged in (asked on demand) and keeps the browser for any other
 * passkey otherwise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { passkeyBlocker, passkeysSupported, refreshSecurityKeys, resetNodeWebauthn, SECURITY_KEY_POLL_MS, usePasskeyBlocker, useSecurityKeys } from "./passkeys";
import { resetPlatform, setPlatform } from "../platform";
import type { Platform, SecurityKeys } from "../platform/types";

function linuxApp(keys: () => Promise<SecurityKeys>): Platform {
  const node = "https://tavrn.example";
  return {
    kind: "desktop",
    isDesktop: true,
    nodeBase: () => node,
    webOrigin: () => node,
    openExternal: vi.fn(async () => {}),
    appVersion: async () => "0.4.0",
    node: { current: () => node, set: vi.fn(async () => {}), resolve: vi.fn(), domain: () => null },
    passkeys: { create: vi.fn(), get: vi.fn(), securityKeys: vi.fn(keys) },
  };
}

beforeEach(() => resetNodeWebauthn());
afterEach(() => {
  vi.useRealTimers();
  resetPlatform();
  resetNodeWebauthn();
});

describe("passkeys in the Linux app", () => {
  const app = linuxApp(async () => ({ present: 0, usable: 0 }));

  it("run in the app while a security key it may open is plugged in", () => {
    expect(passkeyBlocker(app, null, { present: 1, usable: 1 })).toBeNull();
    expect(passkeyBlocker(app, null, { present: 2, usable: 1 })).toBeNull();
  });

  it("wait for a key, and name a key the system does not let the app open", () => {
    expect(passkeyBlocker(app, null, null)).toBe("key");
    expect(passkeyBlocker(app, null, { present: 0, usable: 0 })).toBe("key");
    expect(passkeyBlocker(app, null, { present: 1, usable: 0 })).toBe("key_access");
    expect(passkeysSupported(app)).toBe(false);
  });

  it("the Windows app's native path needs no key check", () => {
    const windows = { ...app, passkeys: { create: vi.fn(), get: vi.fn() } };
    expect(passkeyBlocker(windows, null, null)).toBeNull();
  });

  it("are asked for on demand and remembered for the synchronous checks", async () => {
    const p = linuxApp(async () => ({ present: 1, usable: 1 }));
    setPlatform(p);
    expect(passkeysSupported()).toBe(false);
    await expect(refreshSecurityKeys()).resolves.toEqual({ present: 1, usable: 1 });
    expect(useSecurityKeys.getState().keys).toEqual({ present: 1, usable: 1 });
    expect(passkeysSupported()).toBe(true);
    // A shell that fails to answer counts as no key.
    setPlatform(linuxApp(async () => Promise.reject(new Error("not implemented: passkeyStatus"))));
    await refreshSecurityKeys();
    expect(passkeysSupported()).toBe(false);
  });

  it("the hook looks for a key while active and switches as soon as one is plugged in", async () => {
    vi.useFakeTimers();
    let plugged = false;
    const p = linuxApp(async () => (plugged ? { present: 1, usable: 1 } : { present: 0, usable: 0 }));
    setPlatform(p);
    const { result, rerender } = renderHook(({ active }) => usePasskeyBlocker(active), { initialProps: { active: true } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current).toBe("key");
    plugged = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SECURITY_KEY_POLL_MS);
    });
    expect(result.current).toBeNull();
    // Inactive (a closed dialog): no more questions to the shell.
    rerender({ active: false });
    const asked = vi.mocked(p.passkeys!.securityKeys!).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SECURITY_KEY_POLL_MS * 3);
    });
    expect(vi.mocked(p.passkeys!.securityKeys!).mock.calls.length).toBe(asked);
  });

  it("the hook also looks when the window gets the focus", async () => {
    let plugged = false;
    setPlatform(linuxApp(async () => (plugged ? { present: 1, usable: 1 } : { present: 0, usable: 0 })));
    const { result } = renderHook(() => usePasskeyBlocker());
    await waitFor(() => expect(result.current).toBe("key"));
    plugged = true;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(result.current).toBeNull());
  });
});
