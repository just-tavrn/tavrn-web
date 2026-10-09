// SPDX-License-Identifier: Apache-2.0
// History restore after a key reset (ENCRYPTION.md §7b): the requester's banner, the approvers' page with a mocked
// key manager, the room setting and the realtime events.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Permission, type HistoryRequest, type RoomDetail } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { useLocale } from "../i18n";
import { useNotifications } from "../stores/notifications";
import { useToasts } from "../stores/toasts";
import { mockFetch, renderWithProviders } from "../test/render";
import { HistoryRestoreBanner } from "../components/HistoryRestoreBanner";
import { HistoryRequestsTab } from "../pages/settings/HistoryRequestsTab";
import { HistoryRestoreSection } from "../pages/settings/HistoryRestoreSection";
import { historyDecidedEvent, historyRequestEvent, isPartial, restoreChannel, restoreKeys } from "./restore";

const plan = vi.fn();
const share = vi.fn();
vi.mock("../crypto/history", async (original) => ({
  ...(await original<typeof import("../crypto/history")>()),
  historyRestorePlan: (...args: unknown[]) => plan(...args),
  historyRestore: (...args: unknown[]) => share(...args),
}));

const NODE = { "/api/v1/node": { body: { capabilities: ["e2ee.mls1", "history.restore"] } } };
const room = (extra: Partial<RoomDetail> = {}) =>
  ({
    id: "r1",
    name: "Gilde",
    history_restore: "request",
    my_permissions: String(Permission.RESTORE_HISTORY | Permission.MANAGE_ROOM),
    channels: [
      { id: "c1", room_id: "r1", kind: "text", name: "allgemein", system_name: null, encrypted: true },
      { id: "f1", room_id: "r1", kind: "files", name: "ablage", system_name: null, encrypted: true },
    ],
    ...extra,
  }) as unknown as RoomDetail;
const request = (extra: Partial<HistoryRequest> = {}): HistoryRequest => ({
  id: "H1",
  room_id: "r1",
  user: "bob@t.local",
  display_name: "Bob",
  message: "Ruf mich an",
  status: "open",
  joined_at: "2026-10-01T10:00:00.000Z",
  key_reset_at: "2026-10-08T10:00:00.000Z",
  created_at: "2026-10-08T11:00:00.000Z",
  partial: false,
  channels: [
    { channel_id: "c1", kind: "text", window_start: null, reset_epoch: 4 },
    { channel_id: "f1", kind: "files", window_start: "2026-10-01T10:00:00.000Z", reset_epoch: null },
  ],
  ...extra,
});
const mine = (extra: Record<string, unknown> = {}) => ({ key_reset_at: "2026-10-08T10:00:00.000Z", restored_at: null, request: null, ...extra });

beforeEach(() => {
  useLocale.setState({ locale: "de" });
  useAuth.setState({ token: "acc" });
  useToasts.setState({ toasts: [] });
  useNotifications.setState({ entries: [] });
  plan.mockReset();
  share.mockReset();
});

describe("requester banner", () => {
  it("explains the locked history and sends a request with a message", async () => {
    let state = mine();
    const calls = mockFetch({
      ...NODE,
      "/history-requests/mine": () => ({ body: state }),
      "/rooms/r1/history-requests": (init) => {
        state = mine({ request: request() });
        return { status: init.method === "POST" ? 201 : 200, body: request() };
      },
    });
    renderWithProviders(<HistoryRestoreBanner room={room()} />);
    const banner = await screen.findByTestId("history-restore-banner");
    expect(banner).toHaveTextContent("Deine älteren verschlüsselten Nachrichten sind gesperrt");
    expect(banner).toHaveAttribute("role", "region");
    const u = userEvent.setup();
    await u.click(screen.getByTestId("history-restore-ask"));
    await u.type(screen.getByTestId("history-restore-message"), "Ruf mich an");
    await u.click(screen.getByTestId("history-restore-send"));
    const post = calls.find((c) => c.url.endsWith("/rooms/r1/history-requests") && c.init.method === "POST");
    expect(JSON.parse(String(post!.init.body))).toEqual({ message: "Ruf mich an" });
    expect(await screen.findByTestId("history-restore-status")).toHaveTextContent("Warte auf die Moderation");
  });

  it("shows the open request with a cancel button, a denial with its reason, and the room switch", async () => {
    const calls = mockFetch({ ...NODE, "/history-requests/mine": { body: mine({ request: request() }) }, "/history-requests/H1": { status: 204, body: {} } });
    const { unmount } = renderWithProviders(<HistoryRestoreBanner room={room()} />);
    const u = userEvent.setup();
    await u.click(await screen.findByTestId("history-restore-cancel"));
    expect(calls.some((c) => c.url.endsWith("/rooms/r1/history-requests/H1") && c.init.method === "DELETE")).toBe(true);
    unmount();

    mockFetch({ ...NODE, "/history-requests/mine": { body: mine({ request: request({ status: "denied", decided_by: "alice@t.local", reason: "Bitte erst anrufen" }) }) } });
    const second = renderWithProviders(<HistoryRestoreBanner room={room()} />);
    expect(await screen.findByTestId("history-restore-denied")).toHaveTextContent("alice@t.local hat deine Anfrage abgelehnt: Bitte erst anrufen");
    expect(screen.getByTestId("history-restore-ask")).toHaveTextContent("Erneut anfragen");
    second.unmount();

    mockFetch({ ...NODE, "/history-requests/mine": { body: mine() } });
    renderWithProviders(<HistoryRestoreBanner room={room({ history_restore: "off" })} />);
    expect(await screen.findByTestId("history-restore-banner")).toHaveAttribute("data-state", "off");
    expect(screen.queryByTestId("history-restore-ask")).toBeNull();
  });

  it("stays away without a reset, after a full restore and on nodes without the capability, and reports a partial restore", async () => {
    mockFetch({ ...NODE, "/history-requests/mine": { body: { key_reset_at: null, restored_at: null, request: null } } });
    const a = renderWithProviders(<HistoryRestoreBanner room={room()} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("history-restore-banner")).toBeNull();
    a.unmount();
    const calls = mockFetch({ "/api/v1/node": { body: { capabilities: ["e2ee.mls1"] } }, "/history-requests/mine": { body: mine() } });
    const b = renderWithProviders(<HistoryRestoreBanner room={room()} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.url.includes("/history-requests/mine"))).toBe(false);
    b.unmount();
    mockFetch({ ...NODE, "/history-requests/mine": { body: mine({ restored_at: "2026-10-09T00:00:00.000Z", request: request({ status: "approved", partial: true, decided_by: "alice@t.local" }) }) } });
    renderWithProviders(<HistoryRestoreBanner room={room()} />);
    expect(await screen.findByTestId("history-restore-partial")).toHaveTextContent("einige ältere Nachrichten fehlen");
  });
});

describe("History requests page", () => {
  it("shows the request, what this device would share, and approves only after the identity check, then shares", async () => {
    plan.mockImplementation(async (_q: string, c: { kind: string }) => (c.kind === "files" ? { epochs: [], missing: 0, unknown: true } : { epochs: [0, 1, 2, 3, 4], missing: 2, unknown: false }));
    share.mockResolvedValue({ epochs: [0, 1, 2, 3, 4], missing: 2, unknown: false, sent: 5, skipped: false });
    const calls = mockFetch({ ...NODE, "/rooms/r1/history-requests/H1/approve": { body: request({ status: "approved", partial: true }) }, "/rooms/r1/history-requests": { body: { items: [request()] } } });
    renderWithProviders(<HistoryRequestsTab room={room()} />);
    const card = await screen.findByTestId("history-request");
    expect(screen.getByTestId("history-verify-advice")).toHaveTextContent("Prüfe zuerst, wer anfragt");
    expect(card).toHaveTextContent("Bob");
    expect(card).toHaveTextContent("bob@t.local");
    expect(within(card).getByTestId("history-request-message")).toHaveTextContent("Ruf mich an");
    const channels = within(card).getByTestId("history-request-channels");
    await waitFor(() => expect(channels).toHaveTextContent("Epochen 0–4 von diesem Gerät (5)"));
    expect(channels).toHaveTextContent("#allgemein");
    expect(channels).toHaveTextContent("der ganze Verlauf");
    expect(channels).toHaveTextContent("2 ältere Epochen sind nicht auf diesem Gerät");
    expect(channels).toHaveTextContent("dieses Gerät kann nicht sagen");
    expect(within(card).getByTestId("history-request-partial")).toBeInTheDocument();
    const approve = within(card).getByTestId("history-approve");
    expect(approve).toBeDisabled();
    const u = userEvent.setup();
    await u.click(within(card).getByTestId("history-verified"));
    await u.click(approve);
    const post = calls.find((c) => c.url.endsWith("/history-requests/H1/approve"));
    expect(JSON.parse(String(post!.init.body))).toEqual({ partial: true });
    await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
    expect(share.mock.calls[0]![1]).toBe("bob@t.local");
    expect(share.mock.calls[0]![2]).toEqual({ kind: "text", windowStart: null });
    expect(share.mock.calls[1]![2]).toEqual({ kind: "files", windowStart: Date.parse("2026-10-01T10:00:00.000Z") });
    expect(plan.mock.calls[0]![0]).toMatch(/\/c1$/);
    await waitFor(() => expect(useToasts.getState().toasts.some((x) => x.testId === "history-approved-toast")).toBe(true));
  });

  it("denies with a reason and shows an empty state", async () => {
    plan.mockResolvedValue({ epochs: [], missing: 0, unknown: false });
    const calls = mockFetch({ ...NODE, "/rooms/r1/history-requests/H1/deny": { body: request({ status: "denied" }) }, "/rooms/r1/history-requests": { body: { items: [request({ channels: [] })] } } });
    renderWithProviders(<HistoryRequestsTab room={room()} />);
    const card = await screen.findByTestId("history-request");
    expect(card).toHaveTextContent("Kein verschlüsselter Channel");
    const u = userEvent.setup();
    await u.click(within(card).getByTestId("history-deny-open"));
    const deny = within(card).getByTestId("history-deny");
    expect(deny).toBeDisabled();
    await u.type(within(card).getByTestId("history-deny-reason"), "Bitte erst anrufen");
    await u.click(deny);
    const post = calls.find((c) => c.url.endsWith("/history-requests/H1/deny"));
    expect(JSON.parse(String(post!.init.body))).toEqual({ reason: "Bitte erst anrufen" });
    expect(share).not.toHaveBeenCalled();

    mockFetch({ ...NODE, "/rooms/r1/history-requests": { body: { items: [] } } });
    renderWithProviders(<HistoryRequestsTab room={room()} />);
    expect(await screen.findByTestId("history-requests-empty")).toHaveTextContent("Keine offenen Anfragen");
  });
});

describe("room setting", () => {
  it("switches requests off and on with manage_room, read-only without", async () => {
    const calls = mockFetch({ ...NODE, "/rooms/r1": { body: {} } });
    renderWithProviders(<HistoryRestoreSection room={room()} />);
    const toggle = await screen.findByTestId("room-history-restore");
    expect(toggle).toBeChecked();
    await userEvent.setup().click(toggle);
    const patch = calls.find((c) => c.url.endsWith("/rooms/r1") && c.init.method === "PATCH");
    expect(JSON.parse(String(patch!.init.body))).toEqual({ history_restore: "off" });
  });

  it("is disabled without manage_room", async () => {
    mockFetch(NODE);
    renderWithProviders(<HistoryRestoreSection room={room({ my_permissions: "0", history_restore: "off" })} />);
    const toggle = await screen.findByTestId("room-history-restore");
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeDisabled();
  });
});

describe("events and helpers", () => {
  it("notifies approvers of a new request and tells the requester the decision", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    historyRequestEvent({ room_id: "r1", request: request() }, null, queryClient);
    expect(useNotifications.getState().entries[0]).toMatchObject({ kind: "history", path: "/rooms/r1/settings/history" });
    expect(useToasts.getState().toasts.some((x) => x.testId === "history-request-toast")).toBe(true);
    expect(spy).toHaveBeenCalledWith({ queryKey: restoreKeys.requests(null, "r1") });
    spy.mockClear();
    historyDecidedEvent({ room_id: "r1", request: request({ status: "approved", decided_by: "alice@t.local" }) }, null, queryClient, "bob@t.local");
    expect(spy).toHaveBeenCalledWith({ queryKey: ["messages"] });
    expect(useToasts.getState().toasts.some((x) => x.title === "alice@t.local hat deinen Verlauf wiederhergestellt")).toBe(true);
    // Others only refresh their lists.
    spy.mockClear();
    historyDecidedEvent({ room_id: "r1", request: request({ status: "approved" }) }, null, queryClient, "alice@t.local");
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ["messages"] });
  });

  it("maps channels and spots a partial plan", () => {
    expect(restoreChannel({ channel_id: "c", kind: "text", window_start: null })).toEqual({ kind: "text", windowStart: null });
    expect(restoreChannel({ channel_id: "c", kind: "text", window_start: "bogus" })).toEqual({ kind: "text", windowStart: null });
    expect(isPartial([{ channelId: "c", epochs: 3, first: 0, last: 2, missing: 0, unknown: false }])).toBe(false);
    expect(isPartial([{ channelId: "c", epochs: 3, first: 0, last: 2, missing: 1, unknown: false }])).toBe(true);
  });
});
