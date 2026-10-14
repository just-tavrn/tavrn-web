// SPDX-License-Identifier: Apache-2.0
// The role preview's read-only guarantee (docs/CLIENT.md "View the room as a role"): while it is active, every request
// that would change something is refused on this device with one toast; reads and the device's background upkeep pass.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TavrnApi, TavrnApiError } from "@tavrn/sdk";
import { assertNotPreviewing, PREVIEW_REFUSED, previewDecision, previewGuard } from "./previewGuard";
import { trackingFetch, useReach } from "../stores/reach";
import { useRolePreview } from "../stores/rolePreview";
import { toastError, useToasts } from "../stores/toasts";
import { useAuth } from "../stores/auth";

const start = () => useRolePreview.getState().start({ roomId: "r1", roleIds: [], joinedAt: Date.now(), label: "@everyone" });

// Every test a little later: the toast is rate limited (one per two seconds) across the module.
let clock = Date.parse("2026-10-14T12:00:00Z");
beforeEach(() => {
  vi.useFakeTimers();
  clock += 60_000;
  vi.setSystemTime(clock);
  useToasts.setState({ toasts: [] });
  useRolePreview.getState().exit();
});
afterEach(() => {
  useRolePreview.getState().exit();
  vi.useRealTimers();
});

describe("previewDecision", () => {
  it("lets reads through and refuses every write", () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) expect(previewDecision(m, "https://n.example/api/v1/rooms/r1")).toBe("allow");
    for (const [m, path] of [
      ["POST", "/conversations/c1/messages"],
      ["PUT", "/conversations/c1/messages/m1/reactions/%F0%9F%91%8D"],
      ["PATCH", "/rooms/r1/roles/x"],
      ["DELETE", "/rooms/r1/members/u1"],
      ["POST", "/rooms/r1/invites"],
      ["POST", "/rooms/r1/voice/token"],
      ["PUT", "/rooms/r1/overrides"],
      ["POST", "/auth/reauth"],
      ["PATCH", "/users/me"],
    ]) expect(previewDecision(m!, `https://n.example/api/v1${path}`), `${m} ${path}`).toBe("refuse");
  });
  it("refuses read markers silently", () => {
    expect(previewDecision("PUT", "/api/v1/conversations/c1/read")).toBe("silent");
    expect(previewDecision("PUT", "/api/v1/threads/t1/read")).toBe("silent");
  });
  it("keeps the device's own upkeep: session refresh, MLS, keys, history keys, index and backups", () => {
    for (const [m, path] of [
      ["POST", "/auth/refresh"],
      ["POST", "/conversations/c1/mls/commits"],
      ["DELETE", "/mls/welcomes/w1"],
      ["POST", "/users/me/devices/d1/key-packages"],
      ["POST", "/users/bob/key-packages/claim"],
      ["POST", "/conversations/c1/history-keys"],
      ["DELETE", "/conversations/c1/history-keys/s1"],
      ["PUT", "/conversations/c1/inbox-key"],
      ["PUT", "/users/me/conversations-index"],
      ["PUT", "/users/me/backups/n.example/01ABC"],
    ]) expect(previewDecision(m!, `/api/v1${path}`), `${m} ${path}`).toBe("allow");
  });
});

describe("the guard in front of every node client", () => {
  it("does nothing without a preview", () => {
    expect(previewGuard("/api/v1/conversations/c1/messages", { method: "POST" })).toBeNull();
  });

  it("answers a refused write itself: nothing reaches the node, reachability untouched, one toast per burst", async () => {
    start();
    const inner = vi.fn(async () => new Response("{}", { status: 200 }));
    const f = trackingFetch(() => "n.example", inner);
    useReach.setState({ nodes: {} });
    const resp = await f("https://n.example/api/v1/conversations/c1/messages", { method: "POST", body: "{}" });
    expect(resp.status).toBe(403);
    expect((await resp.json()).code).toBe(PREVIEW_REFUSED);
    await f("https://n.example/api/v1/rooms/r1/invites", { method: "POST" });
    expect(inner).not.toHaveBeenCalled();
    expect(useReach.getState().nodes).toEqual({});
    expect(useToasts.getState().toasts.filter((t) => t.testId === "preview-refused")).toHaveLength(1);
    vi.advanceTimersByTime(2500);
    await f("https://n.example/api/v1/rooms/r1/invites", { method: "POST" });
    expect(useToasts.getState().toasts.filter((t) => t.testId === "preview-refused")).toHaveLength(2);
    // Reads still go out.
    await f("https://n.example/api/v1/rooms/r1", { method: "GET" });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("silent refusals show no toast", async () => {
    start();
    const inner = vi.fn(async () => new Response("{}", { status: 200 }));
    const resp = await trackingFetch(() => "n.example", inner)("https://n.example/api/v1/conversations/c1/read", { method: "PUT" });
    expect(resp.status).toBe(403);
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it("an SDK client raises the refusal as a TavrnApiError, which toastError does not repeat", async () => {
    useAuth.setState({ token: "t" });
    start();
    const inner = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = new TavrnApi({ baseUrl: "https://n.example", fetchImpl: trackingFetch(() => "n.example", inner), getToken: () => "t" });
    const err = await client.conversations.send("c1", { content: { type: "text", body: "hi" } } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TavrnApiError);
    expect((err as TavrnApiError).code).toBe(PREVIEW_REFUSED);
    expect(inner).not.toHaveBeenCalled();
    const before = useToasts.getState().toasts.length;
    toastError(err);
    expect(useToasts.getState().toasts.length).toBe(before);
  });

  it("assertNotPreviewing throws (after the toast) only while previewing", () => {
    expect(() => assertNotPreviewing()).not.toThrow();
    start();
    expect(() => assertNotPreviewing()).toThrow(TavrnApiError);
    expect(useToasts.getState().toasts.map((t) => t.testId)).toEqual(["preview-refused"]);
  });
});

describe("the preview ends with the session", () => {
  it("signing out clears it", () => {
    useAuth.setState({ token: "t" });
    start();
    expect(useRolePreview.getState().preview).not.toBeNull();
    useAuth.setState({ token: null });
    expect(useRolePreview.getState().preview).toBeNull();
  });
});
