// SPDX-License-Identifier: Apache-2.0
/**
 * Routing of system notifications (docs/DESKTOP.md "Notifications"): the desktop app shows native notifications only
 * while its window is not focused (in-app toasts otherwise, as today), never subscribes to web push, and keeps
 * encrypted content out of them; the browser keeps its behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { Conversation, Message } from "@tavrn/sdk";
import { desktopNotificationsEnabled, notifyMessage, setDesktopNotifications, systemNotify } from "./notify";
import { resetPlatform, setPlatform } from "../platform";
import type { NativeNotice, Platform } from "../platform/types";
import { DEFAULT_SETTINGS, useNotifications } from "../stores/notifications";
import { useToasts } from "../stores/toasts";
import { useMlsUi } from "../stores/mls";
import { onRingEvent } from "../voice/calls/actions";
import { useCalls } from "../voice/calls/state";

const shown: NativeNotice[] = [];
const desktop: Platform = {
  kind: "desktop",
  isDesktop: true,
  nodeBase: () => "https://t.local",
  webOrigin: () => "https://t.local",
  openExternal: async () => {},
  appVersion: async () => "0.2.0",
  notifications: { show: async (n) => void shown.push(n), onOpen: () => () => {} },
};

let focused = true;
beforeEach(() => {
  shown.length = 0;
  focused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  localStorage.removeItem("tavrn.desktop.notifications");
  useNotifications.setState({ settings: { ...DEFAULT_SETTINGS, global: { ...DEFAULT_SETTINGS.global, sound: false } }, entries: [] });
  useToasts.setState({ toasts: [] });
  useMlsUi.setState({ open: null });
  useCalls.getState().reset();
});

afterEach(() => {
  resetPlatform();
  vi.restoreAllMocks();
});

const notice = { title: "Bob", body: "hi", tag: "dm1", path: "/conversations/dm1" };

describe("systemNotify", () => {
  it("desktop: native while the window is not focused, nothing extra while it is", () => {
    setPlatform(desktop);
    expect(systemNotify(notice, { browser: false })).toBe("none");
    expect(shown).toHaveLength(0);
    focused = false;
    expect(systemNotify(notice, { browser: false })).toBe("native");
    expect(shown).toEqual([{ title: "Bob", body: "hi", path: "/conversations/dm1" }]);
  });

  it("desktop: the switch in the notification settings turns native notifications off", () => {
    setPlatform(desktop);
    focused = false;
    expect(desktopNotificationsEnabled()).toBe(true);
    setDesktopNotifications(false);
    expect(desktopNotificationsEnabled()).toBe(false);
    expect(systemNotify(notice, { browser: true })).toBe("none");
    setDesktopNotifications(true);
    expect(systemNotify(notice, { browser: false })).toBe("native");
  });

  it("browser: browser notifications as before, only with the setting", () => {
    focused = false;
    expect(systemNotify(notice, { browser: false })).toBe("none");
    expect(systemNotify(notice, { browser: true })).toBe("browser");
    expect(shown).toHaveLength(0);
  });
});

describe("what goes native in the desktop app", () => {
  const qc = () => {
    const c = new QueryClient();
    c.setQueryData<Partial<Conversation>[]>(["conversations"], [{ id: "dm1", kind: "dm", members: [{ address: "bob@localhost", display_name: "Bob" } as Conversation["members"][number]] }]);
    return c;
  };
  const dm = (over: Partial<Message> = {}) =>
    ({ id: "m1", conversation_id: "dm1", author: "bob@localhost", author_id: "u2", device_id: null, encrypted: true, format: 1, content: "c2VjcmV0", mentions: [], mentions_everyone: false, created_at: "", reactions: [], attachments: [], pinned: false, ...over }) as Message;

  it("a direct message in the background: native, with the fixed text for encrypted content; the toast stays", async () => {
    setPlatform(desktop);
    focused = false;
    await notifyMessage(dm(), { queryClient: qc(), node: null, me: { id: "u1", address: "me@localhost" } });
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: "Bob", path: "/conversations/dm1" });
    expect(shown[0]!.body).not.toContain("c2VjcmV0");
    expect(useToasts.getState().toasts).toHaveLength(1);
  });

  it("an incoming call in the background: native", () => {
    setPlatform(desktop);
    focused = false;
    onRingEvent("a.test", { conversation_id: "01J9ZZZZZZZZZZZZZZZZZZZZZZ", node: "a.test", from: "alice@a.test", started_at: new Date().toISOString(), group: false });
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toContain("alice");
    expect(shown[0]!.path).toBe("/n/a.test/conversations/01J9ZZZZZZZZZZZZZZZZZZZZZZ");
  });

  it("an incoming call while the window is focused: in-app only", () => {
    setPlatform(desktop);
    onRingEvent("a.test", { conversation_id: "01J9ZZZZZZZZZZZZZZZZZZZZZZ", node: "a.test", from: "alice@a.test", started_at: new Date().toISOString(), group: false });
    expect(shown).toHaveLength(0);
    expect(useNotifications.getState().entries).toHaveLength(1);
  });
});
