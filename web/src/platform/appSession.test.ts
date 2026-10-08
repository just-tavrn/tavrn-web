// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { TavrnApi, TavrnApiError, pkceChallenge } from "@tavrn/sdk";
import { APP_SESSION_POLL_MS, connectPageUrl, runAppSession, runAppUnlock } from "./appSession";
import type { UnlockKeyPair } from "../crypto/sealedUnlock";

const session = { status: "ok", user: { address: "alice@home.example" }, access_token: "acc", refresh_token: "ref", expires_in: 3600, device_id: "D", recovery_code_used: false };

/** A node answering the app session routes: `polls` is the sequence of poll answers. */
function node(polls: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method: init.method ?? "GET", url, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/auth/connect/session")) return json(200, { session_id: "S".repeat(43), expires_in: 600 });
    if (url.endsWith("/auth/connect/code")) return new Response(null, { status: 204 });
    if (url.includes("/auth/connect/session/")) {
      const r = polls[Math.min(i++, polls.length - 1)]!;
      return json(r.status, r.body);
    }
    if (url.endsWith("/auth/connect/token")) return json(200, session);
    return json(404, { code: "route.not_found", status: 404, title: "", type: "x" });
  }) as typeof fetch;
  return { api: new TavrnApi({ baseUrl: "https://app.home.example", fetchImpl }), calls };
}

/** A key pair that "opens" exactly the box `sealed-for-S` of session `S…`. */
function fakeKeys(): UnlockKeyPair & { disposed: boolean } {
  const keys = {
    publicKey: "K".repeat(43),
    disposed: false,
    open: (sealed: string, sessionId: string) => (sealed === "sealed-for-S" && sessionId === "S".repeat(43) ? { credentialId: "Y3JlZA", prf: new Uint8Array(32).fill(7) } : null),
    dispose: () => {
      keys.disposed = true;
    },
  };
  return keys;
}

const pending = { status: 200, body: { status: "pending", device_name: "Desktop app", expires_in: 590 } };
const ready = { status: 200, body: { status: "ready", code: "c0de", node: "home.example", expires_in: 110 } };
const gone = { status: 410, body: { code: "connect.session_expired", status: 410, title: "Gone", type: "x" } };
const noSleep = async () => {};
const noKeys = async () => null;

describe("app sessions of the connect flow (FEDERATION.md §8 step 3)", () => {
  it("builds the page URL with a method and the app's key in the fragment", () => {
    const url = new URL(connectPageUrl("https://app.home.example", "S".repeat(43), "st", "login", { method: "passkey", key: "K".repeat(43) }));
    expect(url.searchParams.get("method")).toBe("passkey");
    expect(url.hash).toBe(`#k=${"K".repeat(43)}`);
    expect(url.searchParams.has("mode")).toBe(false);
    expect(new URL(connectPageUrl("https://app.home.example", "x", "st", "login", { method: "sso" })).searchParams.get("method")).toBe("sso");
    expect(new URL(connectPageUrl("https://app.home.example", "x", "st", "login")).hash).toBe("");
  });

  it("builds the page URL with the session, a state and the registration mode", () => {
    const url = new URL(connectPageUrl("https://app.home.example", "S".repeat(43), "st", "register"));
    expect(url.origin + url.pathname).toBe("https://app.home.example/connect");
    expect(url.searchParams.get("session")).toBe("S".repeat(43));
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("mode")).toBe("register");
    expect(new URL(connectPageUrl("https://app.home.example", "x", "st", "login")).searchParams.has("mode")).toBe(false);
  });

  it("creates a session, opens the page, polls until ready and exchanges the code with the verifier", async () => {
    const { api, calls } = node([pending, pending, ready]);
    const open = vi.fn(async (_url: string) => {});
    const close = vi.fn(async () => {});
    const onPage = vi.fn();
    const device = vi.fn(async () => ({ id: "D0", nonce: "n", proof: "p" }));
    const keys = fakeKeys();
    const result = await runAppSession({ api, web: "https://app.home.example", domain: "home.example", deviceName: "Desktop app", open, close, onPage, device, sleep: noSleep, keys: async () => keys });
    expect(result).toEqual({ session, unlock: null });
    expect(keys.disposed).toBe(true);
    const created = calls.find((c) => c.url.endsWith("/auth/connect/session"))!;
    expect(created.body).toMatchObject({ device_name: "Desktop app" });
    const exchange = calls.find((c) => c.url.endsWith("/auth/connect/token"))!;
    expect(exchange.body).toMatchObject({ code: "c0de", device: { id: "D0" } });
    expect(await pkceChallenge(String(exchange.body!.code_verifier))).toBe(created.body!.code_challenge);
    const url = new URL(open.mock.calls[0]![0]);
    expect(url.searchParams.get("session")).toBe("S".repeat(43));
    expect(url.hash).toBe(`#k=${keys.publicKey}`);
    expect(onPage).toHaveBeenCalledWith(url.toString());
    expect(calls.filter((c) => c.url.includes("/auth/connect/session/"))).toHaveLength(3);
    expect(close).toHaveBeenCalled();
    expect(APP_SESSION_POLL_MS).toBe(2000);
  });

  it("refuses a code of another node", async () => {
    const { api, calls } = node([{ status: 200, body: { ...ready.body, node: "evil.example" } }]);
    const close = vi.fn(async () => {});
    await expect(runAppSession({ api, web: "https://app.home.example", domain: "home.example", deviceName: "d", open: async () => {}, close, sleep: noSleep, keys: noKeys })).rejects.toThrow();
    expect(calls.some((c) => c.url.endsWith("/auth/connect/token"))).toBe(false);
    expect(close).toHaveBeenCalled();
  });

  it("an expired session ends the wait with its error", async () => {
    const { api } = node([pending, gone]);
    const close = vi.fn(async () => {});
    const err = await runAppSession({ api, web: "https://app.home.example", domain: "home.example", deviceName: "d", open: async () => {}, close, sleep: noSleep, keys: noKeys }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TavrnApiError);
    expect((err as TavrnApiError).code).toBe("connect.session_expired");
    expect(close).toHaveBeenCalled();
  });

  it("network errors while polling are retried", async () => {
    const { api } = node([pending, ready]);
    const orig = api.auth.pollConnectSession;
    let failed = false;
    api.auth.pollConnectSession = async (id: string) => {
      if (!failed) {
        failed = true;
        throw new TypeError("Failed to fetch");
      }
      return orig(id);
    };
    await expect(runAppSession({ api, web: "https://app.home.example", domain: "home.example", deviceName: "d", open: async () => {}, close: async () => {}, sleep: noSleep, keys: noKeys })).resolves.toEqual({ session, unlock: null });
  });

  it("cancelling stops polling, closes the window and resolves with null", async () => {
    const { api, calls } = node([pending]);
    const controller = new AbortController();
    const close = vi.fn(async () => {});
    const sleep = vi.fn(async () => controller.abort());
    const result = await runAppSession({ api, web: "https://app.home.example", domain: "home.example", deviceName: "d", open: async () => {}, close, sleep, signal: controller.signal, keys: noKeys });
    expect(result).toBeNull();
    expect(close).toHaveBeenCalled();
    expect(calls.some((c) => c.url.endsWith("/auth/connect/token"))).toBe(false);
  });

  it("returns the sealed unlock material of a passkey sign-in, opened with the handoff's key", async () => {
    const { api } = node([pending, { status: 200, body: { ...ready.body, sealed_unlock: "sealed-for-S" } }]);
    const open = vi.fn(async (_url: string) => {});
    const keys = fakeKeys();
    const result = await runAppSession({ api, web: "https://app.home.example", domain: "home.example", deviceName: "d", method: "passkey", open, close: async () => {}, sleep: noSleep, keys: async () => keys });
    expect(result).toEqual({ session, unlock: { credentialId: "Y3JlZA", prf: new Uint8Array(32).fill(7) } });
    expect(new URL(open.mock.calls[0]![0]).searchParams.get("method")).toBe("passkey");
    expect(keys.disposed).toBe(true);
  });

  it("material that does not open is ignored: the sign-in still succeeds (recovery key fallback)", async () => {
    const { api } = node([{ status: 200, body: { ...ready.body, sealed_unlock: "sealed-for-someone-else" } }]);
    const result = await runAppSession({ api, web: "https://app.home.example", domain: "home.example", deviceName: "d", open: async () => {}, close: async () => {}, sleep: noSleep, keys: async () => fakeKeys() });
    expect(result).toEqual({ session, unlock: null });
  });

  it("without a key pair (crypto unavailable) the page gets no fragment", async () => {
    const { api } = node([ready]);
    const open = vi.fn(async (_url: string) => {});
    await runAppSession({ api, web: "https://app.home.example", domain: "home.example", deviceName: "d", open, close: async () => {}, sleep: noSleep, keys: async () => null });
    expect(new URL(open.mock.calls[0]![0]).hash).toBe("");
  });
});

describe("unlock sessions (passkey unlock of a signed-in app)", () => {
  const unlockPending = { status: 200, body: { status: "pending", device_name: "Desktop app", purpose: "unlock", expires_in: 590 } };
  const unlockReady = { status: 200, body: { status: "ready", node: "home.example", sealed_unlock: "sealed-for-S", expires_in: 110 } };

  it("checks the node's support first, opens the page with method=passkey and returns the opened material", async () => {
    const { api, calls } = node([unlockPending, unlockPending, unlockReady]);
    const open = vi.fn(async (_url: string) => {});
    const close = vi.fn(async () => {});
    const keys = fakeKeys();
    const material = await runAppUnlock({ api, web: "https://app.home.example", domain: "home.example", deviceName: "Desktop app", open, close, sleep: noSleep, keys: async () => keys });
    expect(material).toEqual({ credentialId: "Y3JlZA", prf: new Uint8Array(32).fill(7) });
    expect(calls[0]!.body).toMatchObject({ purpose: "unlock", device_name: "Desktop app" });
    // The support check polls before the page opens.
    expect(calls[1]!.url).toContain("/auth/connect/session/");
    const url = new URL(open.mock.calls[0]![0]);
    expect(url.searchParams.get("method")).toBe("passkey");
    expect(url.hash).toBe(`#k=${keys.publicKey}`);
    expect(calls.some((c) => c.url.endsWith("/auth/connect/token"))).toBe(false);
    expect(close).toHaveBeenCalled();
    expect(keys.disposed).toBe(true);
  });

  it("a node without unlock sessions is detected before any window opens", async () => {
    const { api } = node([pending]);
    const open = vi.fn(async () => {});
    const err = await runAppUnlock({ api, web: "https://app.home.example", domain: "home.example", deviceName: "d", open, close: async () => {}, sleep: noSleep, keys: async () => fakeKeys() }).catch((e: unknown) => e);
    expect(err).toMatchObject({ problem: { code: "connect.unlock_unsupported" } });
    expect(open).not.toHaveBeenCalled();
  });

  it("material that does not open is an error; cancelling resolves with null", async () => {
    const { api } = node([unlockPending, { status: 200, body: { ...unlockReady.body, sealed_unlock: "garbage" } }]);
    const err = await runAppUnlock({ api, web: "https://app.home.example", domain: "home.example", deviceName: "d", open: async () => {}, close: async () => {}, sleep: noSleep, keys: async () => fakeKeys() }).catch((e: unknown) => e);
    expect(err).toMatchObject({ problem: { code: "connect.unlock_failed" } });

    const second = node([unlockPending]);
    const controller = new AbortController();
    const close = vi.fn(async () => {});
    const result = await runAppUnlock({ api: second.api, web: "https://app.home.example", domain: "home.example", deviceName: "d", open: async () => {}, close, sleep: async () => controller.abort(), signal: controller.signal, keys: async () => fakeKeys() });
    expect(result).toBeNull();
    expect(close).toHaveBeenCalled();
  });

  it("without a key pair there is nothing to unlock with", async () => {
    const { api } = node([unlockPending]);
    const err = await runAppUnlock({ api, web: "https://app.home.example", domain: "home.example", deviceName: "d", open: async () => {}, close: async () => {}, sleep: noSleep, keys: async () => null }).catch((e: unknown) => e);
    expect(err).toMatchObject({ problem: { code: "connect.unlock_unsupported" } });
  });
});
