// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { TavrnApi, TavrnApiError, pkceChallenge } from "@tavrn/sdk";
import { APP_SESSION_POLL_MS, connectPageUrl, runAppSession } from "./appSession";

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
    if (url.includes("/auth/connect/session/")) {
      const r = polls[Math.min(i++, polls.length - 1)]!;
      return json(r.status, r.body);
    }
    if (url.endsWith("/auth/connect/token")) return json(200, session);
    return json(404, { code: "route.not_found", status: 404, title: "", type: "x" });
  }) as typeof fetch;
  return { api: new TavrnApi({ baseUrl: "https://app.home.example", fetchImpl }), calls };
}

const pending = { status: 200, body: { status: "pending", device_name: "Desktop app", expires_in: 590 } };
const ready = { status: 200, body: { status: "ready", code: "c0de", node: "home.example", expires_in: 110 } };
const gone = { status: 410, body: { code: "connect.session_expired", status: 410, title: "Gone", type: "x" } };
const noSleep = async () => {};

describe("app sessions of the connect flow (FEDERATION.md §8 step 3)", () => {
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
    const open = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const onPage = vi.fn();
    const device = vi.fn(async () => ({ id: "D0", nonce: "n", proof: "p" }));
    const result = await runAppSession({ api, web: "https://app.home.example", domain: "home.example", deviceName: "Desktop app", open, close, onPage, device, sleep: noSleep });
    expect(result).toEqual(session);
    const created = calls.find((c) => c.url.endsWith("/auth/connect/session"))!;
    expect(created.body).toMatchObject({ device_name: "Desktop app" });
    const exchange = calls.find((c) => c.url.endsWith("/auth/connect/token"))!;
    expect(exchange.body).toMatchObject({ code: "c0de", device: { id: "D0" } });
    expect(await pkceChallenge(String(exchange.body!.code_verifier))).toBe(created.body!.code_challenge);
    const url = new URL(open.mock.calls[0]![0] as unknown as string);
    expect(url.searchParams.get("session")).toBe("S".repeat(43));
    expect(onPage).toHaveBeenCalledWith(url.toString());
    expect(calls.filter((c) => c.url.includes("/auth/connect/session/"))).toHaveLength(3);
    expect(close).toHaveBeenCalled();
    expect(APP_SESSION_POLL_MS).toBe(2000);
  });

  it("refuses a code of another node", async () => {
    const { api, calls } = node([{ status: 200, body: { ...ready.body, node: "evil.example" } }]);
    const close = vi.fn(async () => {});
    await expect(runAppSession({ api, web: "https://app.home.example", domain: "home.example", deviceName: "d", open: async () => {}, close, sleep: noSleep })).rejects.toThrow();
    expect(calls.some((c) => c.url.endsWith("/auth/connect/token"))).toBe(false);
    expect(close).toHaveBeenCalled();
  });

  it("an expired session ends the wait with its error", async () => {
    const { api } = node([pending, gone]);
    const close = vi.fn(async () => {});
    const err = await runAppSession({ api, web: "https://app.home.example", domain: "home.example", deviceName: "d", open: async () => {}, close, sleep: noSleep }).catch((e: unknown) => e);
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
    await expect(runAppSession({ api, web: "https://app.home.example", domain: "home.example", deviceName: "d", open: async () => {}, close: async () => {}, sleep: noSleep })).resolves.toEqual(session);
  });

  it("cancelling stops polling, closes the window and resolves with null", async () => {
    const { api, calls } = node([pending]);
    const controller = new AbortController();
    const close = vi.fn(async () => {});
    const sleep = vi.fn(async () => controller.abort());
    const result = await runAppSession({ api, web: "https://app.home.example", domain: "home.example", deviceName: "d", open: async () => {}, close, sleep, signal: controller.signal });
    expect(result).toBeNull();
    expect(close).toHaveBeenCalled();
    expect(calls.some((c) => c.url.endsWith("/auth/connect/token"))).toBe(false);
  });
});
