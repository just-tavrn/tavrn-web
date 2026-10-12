// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { deepLinkRoute, keepPendingLink, nodeHost, parseDeepLink, takePendingLink } from "./deepLinks";

const home = { web: "https://app.tavrn.example", domain: "tavrn.example" };
const S = "S".repeat(43);
const STATE = "s".repeat(22);

describe("deep links: the forms the shells hand over (deeplink.rs, deeplink.ts)", () => {
  it("reads invites, rooms, add links and the sign-in handoff", () => {
    expect(parseDeepLink("tavrn://invite/chat.example/AbCd_123")).toEqual({ kind: "invite", node: "chat.example", code: "AbCd_123" });
    expect(parseDeepLink("TAVRN://Invite/Chat.Example/AbCd_123/")).toEqual({ kind: "invite", node: "chat.example", code: "AbCd_123" });
    expect(parseDeepLink("tavrn://room/chat.example/01J9ZQ")).toEqual({ kind: "room", node: "chat.example", room: "01J9ZQ", channel: null });
    expect(parseDeepLink("tavrn://room/chat.example/01J9ZQ/01JA00")).toEqual({ kind: "room", node: "chat.example", room: "01J9ZQ", channel: "01JA00" });
    expect(parseDeepLink("tavrn://add/chat.example/01J9ZQ")).toEqual({ kind: "add", node: "chat.example", domain: null, id: "01J9ZQ", room: null });
    expect(parseDeepLink("tavrn://add/chat.example/apps.example/01J9ZQ?room=chat.example%2F01AB")).toEqual({ kind: "add", node: "chat.example", domain: "apps.example", id: "01J9ZQ", room: "chat.example/01AB" });
    expect(parseDeepLink(`tavrn://connect?session=${S}&state=${STATE}`)).toEqual({ kind: "connect", session: S, state: STATE });
    // Android's App Links of the project's node.
    expect(parseDeepLink("https://app.tavrn.example/invite/Code_1234")).toEqual({ kind: "invite", node: "app.tavrn.example", code: "Code_1234" });
    expect(parseDeepLink("https://app.tavrn.example/add/01ABC?room=tavrn.example%2F01R")).toEqual({ kind: "add", node: "app.tavrn.example", domain: null, id: "01ABC", room: "tavrn.example/01R" });
  });

  it("refuses everything else", () => {
    for (const bad of [
      "",
      "not a url",
      "javascript:alert(1)",
      "tavrn:invite/chat.example/code1234",
      "tavrn://chat.example/invite/code1234",
      "tavrn://invite/chat.example/abc",
      "tavrn://invite/chat.example/code1234/more",
      "tavrn://invite/chat.example/code1234?next=/admin",
      "tavrn://invite/chat.example/code1234#x",
      "tavrn://invite/localhost/code1234",
      "tavrn://invite/127.0.0.1/code1234",
      "tavrn://invite/chat.example:8443/code1234",
      "tavrn://user@invite/chat.example/code1234",
      "tavrn://invite\\chat.example\\code1234",
      "tavrn://invite/chat.example//code1234",
      "tavrn://room/chat.example",
      "tavrn://room/chat.example/r1/c1/threads",
      "tavrn://add/chat.example/not_a_domain/01J9ZQ",
      "tavrn://add/chat.example/01J9ZQ?room=a&room=b",
      "tavrn://add/chat.example/01J9ZQ?other=1",
      `tavrn://connect?session=${S}`,
      `tavrn://connect?session=${S}&state=${STATE}&code=c0de`,
      `tavrn://connect?session=${S}&state=short`,
      "tavrn://settings/chat.example",
      "http://app.tavrn.example/invite/Code_1234",
      "https://app.tavrn.example/settings",
      "https://app.tavrn.example/invite/x",
      "https://app.tavrn.example:8443/invite/Code_1234",
      `tavrn://invite/chat.example/${"a".repeat(600)}`,
    ]) {
      expect(parseDeepLink(bad), bad).toBeNull();
    }
    expect(nodeHost("Chat.Example")).toBe("chat.example");
    for (const bad of ["localhost", "10.0.0.1", "-a.example", "a..example", ""]) expect(nodeHost(bad), bad).toBeNull();
  });
});

describe("deep links: the client's routes", () => {
  it("routes the home node's links as they are", async () => {
    const identity = vi.fn(async () => "other");
    expect(await deepLinkRoute({ kind: "invite", node: "app.tavrn.example", code: "Code_1234" }, home, identity)).toBe("/invite/Code_1234");
    expect(await deepLinkRoute({ kind: "invite", node: "tavrn.example", code: "Code_1234" }, home, identity)).toBe("/invite/Code_1234");
    expect(await deepLinkRoute({ kind: "room", node: "tavrn.example", room: "R1", channel: "C1" }, home, identity)).toBe("/rooms/R1/channels/C1");
    expect(await deepLinkRoute({ kind: "room", node: "tavrn.example", room: "R1", channel: null }, home, identity)).toBe("/rooms/R1");
    expect(await deepLinkRoute({ kind: "add", node: "app.tavrn.example", domain: null, id: "01ABC", room: "tavrn.example/01R" }, home, identity)).toBe("/add/01ABC?room=tavrn.example%2F01R");
    expect(identity).not.toHaveBeenCalled();
  });

  it("names another node by its identity domain", async () => {
    const identity = vi.fn(async (host: string) => (host === "app.other.example" ? "other.example" : null));
    expect(await deepLinkRoute({ kind: "invite", node: "app.other.example", code: "Code_1234" }, home, identity)).toBe("/invite/Code_1234?node=other.example");
    expect(await deepLinkRoute({ kind: "room", node: "app.other.example", room: "R1", channel: "C1" }, home, identity)).toBe("/n/other.example/rooms/R1/channels/C1");
    expect(await deepLinkRoute({ kind: "add", node: "app.other.example", domain: null, id: "01ABC", room: null }, home, identity)).toBe("/add/other.example/01ABC");
    expect(await deepLinkRoute({ kind: "add", node: "chat.example", domain: "third.example", id: "01ABC", room: null }, home, identity)).toBe("/add/third.example/01ABC");
    // Unknown identity (offline): the host itself.
    expect(await deepLinkRoute({ kind: "invite", node: "chat.example", code: "Code_1234" }, home, async () => null)).toBe("/invite/Code_1234?node=chat.example");
    expect(await deepLinkRoute({ kind: "invite", node: "chat.example", code: "Code_1234" }, home, async () => Promise.reject(new Error("offline")))).toBe("/invite/Code_1234?node=chat.example");
    // A delegated host of the home node itself.
    expect(await deepLinkRoute({ kind: "invite", node: "web.tavrn.example", code: "Code_1234" }, home, async () => "tavrn.example")).toBe("/invite/Code_1234");
    expect(await deepLinkRoute({ kind: "connect", session: S, state: STATE }, home)).toBeNull();
  });

  it("keeps one link for the node picker, for this window only", () => {
    sessionStorage.clear();
    expect(takePendingLink()).toBeNull();
    keepPendingLink("tavrn://invite/chat.example/code1234");
    expect(takePendingLink()).toBe("tavrn://invite/chat.example/code1234");
    expect(takePendingLink()).toBeNull();
    const broken = { setItem: () => { throw new Error("quota"); }, getItem: () => { throw new Error("denied"); }, removeItem: () => {} };
    expect(() => keepPendingLink("x", broken)).not.toThrow();
    expect(takePendingLink(broken)).toBeNull();
  });
});
