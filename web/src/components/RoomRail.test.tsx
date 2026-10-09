// SPDX-License-Identifier: Apache-2.0
// The room rail with folders: menus, expand/collapse, badges, keyboard and drag and drop (docs/CLIENT.md).
import { act, createEvent, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../stores/auth";
import { resetNodeCaches, useNodes } from "../stores/nodes";
import { useUnread } from "../stores/unread";
import { RAIL_STATE_VERSION, roomKey, useRailFolders, type RailState } from "../stores/railFolders";
import { mockFetch, renderWithProviders } from "../test/render";
import { RoomRail } from "./RoomRail";

const me = { id: "A-ID", username: "alice", domain: "a.test", address: "alice@a.test", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const room = (id: string, name: string) => ({ id, name, icon: null, icon_still: null, description: "", join_mode: "invite", owner_id: "A-ID" });
const ROOMS = [room("A", "Alpha"), room("B", "Bravo"), room("C", "Charlie")];
const k = (id: string) => roomKey("a.test", id);
const detail = (id: string, unread = 0, mentions = 0) => ({
  body: { ...room(id, id), channels: [{ id: `c${id}`, kind: "text", name: "general" }], read_states: [{ conversation_id: `c${id}`, last_message_id: "02", last_read_message_id: "01", unread_count: unread, mention_count: mentions }], my_permissions: "0", is_owner: false },
});
const STORE = "tavrn.rail:alice@a.test";

function stored(s: Partial<RailState>) {
  localStorage.setItem(STORE, JSON.stringify({ clientStateVersion: RAIL_STATE_VERSION, folders: [], order: [], expanded: [], ...s }));
}
const saved = (): RailState => JSON.parse(localStorage.getItem(STORE)!);

let now = Date.parse("2026-10-09T10:00:00Z");

beforeEach(() => {
  // loadRoomDetails runs at most every 30 s per node: every test starts a minute later.
  now += 60_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  localStorage.clear();
  resetNodeCaches();
  useNodes.getState().clear();
  useUnread.setState({ states: {}, held: {} });
  useRailFolders.getState().reset();
  useAuth.setState({ token: "t", refresh: "r", user: me, deviceId: "D", home: null });
  mockFetch({
    "/rooms/A": detail("A"),
    "/rooms/B": detail("B"),
    "/rooms/C": detail("C"),
    "/rooms": { body: ROOMS },
    "/conversations": { body: [] },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const list = () => screen.getByTestId("rail-list");
const roomLink = (name: string) => screen.getByRole("link", { name, exact: true } as never);
const folderButton = () => screen.getByTestId("rail-folder-button");
const topLevelNames = () => [...list().children].map((li) => (li.getAttribute("data-testid") === "rail-folder" ? `[${li.querySelector("button")!.getAttribute("title")}]` : li.querySelector("a")!.getAttribute("aria-label")));

async function openMenu(el: HTMLElement) {
  fireEvent.contextMenu(el, { clientX: 10, clientY: 10 });
  await act(() => new Promise((r) => setTimeout(r, 5)));
}

describe("room rail", () => {
  it("lists the rooms in the node's order as links; arrow keys move through the rail", async () => {
    renderWithProviders(<RoomRail />);
    await waitFor(() => expect(topLevelNames()).toEqual(["Alpha", "Bravo", "Charlie"]));
    expect(list()).toHaveAccessibleName("Deine Räume");
    const home = screen.getByRole("link", { name: "Start" });
    home.focus();
    fireEvent.keyDown(home, { key: "ArrowDown" });
    expect(roomLink("Alpha")).toHaveFocus();
    fireEvent.keyDown(roomLink("Alpha"), { key: "ArrowDown" });
    expect(roomLink("Bravo")).toHaveFocus();
    fireEvent.keyDown(roomLink("Bravo"), { key: "ArrowUp" });
    expect(roomLink("Alpha")).toHaveFocus();
    fireEvent.keyDown(roomLink("Alpha"), { key: "End" });
    expect(screen.getByTestId("nav-discover")).toHaveFocus();
  });

  it("a collapsed folder is a disclosure button named by its name and room count; click expands it inline", async () => {
    stored({ folders: [{ id: "F", name: "Games", roomIds: [k("B"), k("C")] }], order: [k("A"), "folder:F"] });
    const user = userEvent.setup();
    renderWithProviders(<RoomRail />);
    await waitFor(() => expect(topLevelNames()).toEqual(["Alpha", "[Games]"]));
    const button = folderButton();
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAccessibleName("Ordner Games, 2 Räume");
    expect(within(button).getAllByTestId("rail-folder-icon")).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "Bravo" })).toBeNull();
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const rooms = screen.getByRole("list", { name: "Räume in Games" });
    expect(button).toHaveAttribute("aria-controls", rooms.id);
    expect(within(rooms).getAllByRole("link").map((a) => a.getAttribute("aria-label"))).toEqual(["Bravo", "Charlie"]);
    expect(saved().expanded).toEqual(["F"]);
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Räume in Games" })).toBeNull();
  });

  it("an unnamed folder is named after its rooms", async () => {
    stored({ folders: [{ id: "F", name: "", roomIds: [k("B"), k("C")] }], order: ["folder:F"] });
    renderWithProviders(<RoomRail />);
    await waitFor(() => expect(folderButton()).toHaveAccessibleName("Ordner Bravo, Charlie, 2 Räume"));
  });

  it("the empty rail's menu creates a named, coloured folder", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoomRail />);
    await waitFor(() => expect(topLevelNames()).toHaveLength(3));
    await openMenu(screen.getByTestId("rail-end"));
    await user.click(within(screen.getByTestId("rail-menu")).getByRole("menuitem", { name: "Neuer Ordner…" }));
    const dialog = screen.getByRole("dialog", { name: "Neuer Ordner" });
    await user.type(within(dialog).getByLabelText("Name"), "Raids");
    await user.click(within(dialog).getByRole("radio", { name: "Violett" }));
    await user.click(within(dialog).getByRole("button", { name: "Ordner erstellen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(topLevelNames()).toEqual(["Alpha", "Bravo", "Charlie", "[Raids]"]);
    expect(saved().folders).toEqual([expect.objectContaining({ name: "Raids", color: "violet", roomIds: [] })]);
  });

  it("a room's menu keeps the room entries and moves it into a folder, out again, up and down", async () => {
    stored({ folders: [{ id: "F", name: "Games", roomIds: [k("C")] }], order: [k("A"), k("B"), "folder:F"], expanded: ["F"] });
    const user = userEvent.setup();
    renderWithProviders(<RoomRail />);
    await waitFor(() => expect(topLevelNames()).toEqual(["Alpha", "Bravo", "[Games]"]));
    await openMenu(roomLink("Alpha"));
    const menu = screen.getByTestId("room-menu");
    // The room's own entries are still there.
    expect(within(menu).getByRole("menuitem", { name: "Raum verlassen" })).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "Nach unten" }));
    expect(topLevelNames()).toEqual(["Bravo", "Alpha", "[Games]"]);
    await openMenu(roomLink("Alpha"));
    await user.click(within(screen.getByTestId("room-menu")).getByRole("menuitem", { name: "In Ordner verschieben" }));
    await user.click(within(screen.getByTestId("context-submenu")).getByRole("menuitem", { name: "Games" }));
    expect(topLevelNames()).toEqual(["Bravo", "[Games]"]);
    expect(saved().folders[0]!.roomIds).toEqual([k("C"), k("A")]);
    await openMenu(roomLink("Alpha"));
    await user.click(within(screen.getByTestId("room-menu")).getByRole("menuitem", { name: "In Ordner verschieben" }));
    await user.click(within(screen.getByTestId("context-submenu")).getByRole("menuitem", { name: "Aus dem Ordner nehmen" }));
    expect(topLevelNames()).toEqual(["Bravo", "[Games]", "Alpha"]);
  });

  it("a room's menu starts a new folder with the room in it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoomRail />);
    await waitFor(() => expect(topLevelNames()).toHaveLength(3));
    await openMenu(roomLink("Bravo"));
    await user.click(within(screen.getByTestId("room-menu")).getByRole("menuitem", { name: "In Ordner verschieben" }));
    await user.click(within(screen.getByTestId("context-submenu")).getByRole("menuitem", { name: "Neuer Ordner…" }));
    await user.type(screen.getByLabelText("Name"), "Work");
    await user.click(screen.getByRole("button", { name: "Ordner erstellen" }));
    expect(topLevelNames()).toEqual(["Alpha", "[Work]", "Charlie"]);
  });

  it("a folder's menu renames, recolours, collapses and deletes it (its rooms return to its place)", async () => {
    stored({ folders: [{ id: "F", name: "Games", roomIds: [k("B"), k("C")] }], order: [k("A"), "folder:F"] });
    const user = userEvent.setup();
    renderWithProviders(<RoomRail />);
    await waitFor(() => expect(topLevelNames()).toEqual(["Alpha", "[Games]"]));
    await openMenu(folderButton());
    const menu = screen.getByTestId("folder-menu");
    for (const name of ["Umbenennen…", "Farbe", "Aufklappen", "Nach oben", "Ordner löschen"]) expect(within(menu).getByRole("menuitem", { name })).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "Umbenennen…" }));
    const name = screen.getByLabelText("Name");
    expect(name).toHaveValue("Games");
    await user.clear(name);
    await user.type(name, "Raids");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    expect(folderButton()).toHaveAttribute("title", "Raids");
    await openMenu(folderButton());
    await user.click(within(screen.getByTestId("folder-menu")).getByRole("menuitem", { name: "Farbe" }));
    await user.click(within(screen.getByTestId("context-submenu")).getByRole("menuitemcheckbox", { name: "Bernstein" }));
    expect(saved().folders[0]!.color).toBe("amber");
    await openMenu(folderButton());
    await user.click(within(screen.getByTestId("folder-menu")).getByRole("menuitem", { name: "Ordner löschen" }));
    expect(topLevelNames()).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(saved().folders).toEqual([]);
  });

  it("a collapsed folder shows the sum of its rooms' counts, the mention badge first, and the open room", async () => {
    stored({ folders: [{ id: "F", name: "Games", roomIds: [k("B"), k("C")] }], order: [k("A"), "folder:F"] });
    mockFetch({ "/rooms/A": detail("A"), "/rooms/B": detail("B", 3, 2), "/rooms/C": detail("C"), "/rooms": { body: ROOMS }, "/conversations": { body: [] } });
    renderWithProviders(<RoomRail />, { route: "/rooms/C" });
    // The details of the rooms in folders are loaded for the badge: B has 3 unread, 2 mentions.
    await waitFor(() => expect(screen.getByTestId("rail-mention-badge")).toHaveTextContent("2"));
    expect(folderButton()).toHaveAccessibleName("Ordner Games, 2 Räume, 2 Erwähnungen, enthält den geöffneten Raum");
    expect(folderButton()).toHaveAttribute("data-selected", "true");
    expect(screen.queryByTestId("rail-unread-dot")).toBeNull();
    // Unread without mentions: a dot, and the name says so.
    act(() => useUnread.getState().seed([{ conversation_id: "cB", last_message_id: "03", last_read_message_id: "02", unread_count: 1, mention_count: 0 }]));
    expect(screen.getByTestId("rail-unread-dot")).toBeInTheDocument();
    expect(folderButton()).toHaveAccessibleName("Ordner Games, 2 Räume, Ungelesene Nachrichten, enthält den geöffneten Raum");
    // Expanded, the rooms carry their own badges and the open room its own state.
    fireEvent.click(folderButton());
    expect(folderButton()).toHaveAccessibleName("Ordner Games, 2 Räume, Ungelesene Nachrichten");
    expect(roomLink("Bravo")).toHaveAttribute("aria-description", "Ungelesene Nachrichten");
    expect(roomLink("Charlie")).toHaveAttribute("aria-current", "page");
  });

  it("keyboard: → expands and enters a folder, ← goes back and collapses, the menu key opens its menu", async () => {
    stored({ folders: [{ id: "F", name: "Games", roomIds: [k("B"), k("C")] }], order: [k("A"), "folder:F"] });
    renderWithProviders(<RoomRail />);
    await waitFor(() => expect(topLevelNames()).toEqual(["Alpha", "[Games]"]));
    const button = folderButton();
    button.focus();
    fireEvent.keyDown(button, { key: "ArrowRight" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(button, { key: "ArrowRight" });
    expect(roomLink("Bravo")).toHaveFocus();
    fireEvent.keyDown(roomLink("Bravo"), { key: "ArrowDown" });
    expect(roomLink("Charlie")).toHaveFocus();
    fireEvent.keyDown(roomLink("Charlie"), { key: "ArrowLeft" });
    expect(button).toHaveFocus();
    fireEvent.keyDown(button, { key: "ArrowLeft" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    // The context-menu key and Shift+F10 fire `contextmenu` at the focused element (no pointer position).
    fireEvent.contextMenu(button, { clientX: 0, clientY: 0 });
    expect(screen.getByTestId("folder-menu")).toBeInTheDocument();
  });

  it("drag and drop: a room onto a room makes a folder, onto a folder adds it, onto the empty rail takes it out", async () => {
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: "", dropEffect: "" };
    renderWithProviders(<RoomRail />);
    await waitFor(() => expect(topLevelNames()).toHaveLength(3));
    const drag = (from: HTMLElement, to: HTMLElement) => {
      fireEvent.dragStart(from, { dataTransfer });
      fireEvent.dragOver(to, { dataTransfer, clientY: 0 });
      fireEvent.drop(to, { dataTransfer, clientY: 0 });
      fireEvent.dragEnd(from, { dataTransfer });
    };
    drag(roomLink("Charlie"), roomLink("Alpha"));
    expect(topLevelNames()).toEqual(["[Alpha, Charlie]", "Bravo"]);
    drag(roomLink("Bravo"), folderButton());
    expect(topLevelNames()).toEqual(["[Alpha, Charlie, Bravo]"]);
    fireEvent.click(folderButton());
    drag(roomLink("Alpha"), screen.getByTestId("rail-end"));
    expect(topLevelNames()).toEqual(["[Charlie, Bravo]", "Alpha"]);
  });

  it("drag and drop reorders with a drop indicator above or below an entry", async () => {
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: "", dropEffect: "" };
    renderWithProviders(<RoomRail />);
    await waitFor(() => expect(topLevelNames()).toHaveLength(3));
    const alpha = roomLink("Alpha");
    vi.spyOn(alpha, "getBoundingClientRect").mockReturnValue({ top: 100, height: 48, bottom: 148, left: 0, right: 48, width: 48, x: 0, y: 100, toJSON: () => ({}) });
    // jsdom has no DragEvent: the pointer position is put on the event by hand.
    const at = (event: Event) => Object.assign(Object.defineProperty(event, "clientY", { value: 102 }), { dataTransfer });
    fireEvent.dragStart(roomLink("Charlie"), { dataTransfer });
    fireEvent(alpha, at(createEvent.dragOver(alpha)));
    expect(within(alpha).getByTestId("rail-drop-indicator")).toHaveAttribute("data-at", "before");
    fireEvent(alpha, at(createEvent.drop(alpha)));
    expect(topLevelNames()).toEqual(["Charlie", "Alpha", "Bravo"]);
    expect(screen.queryByTestId("rail-drop-indicator")).toBeNull();
  });

  it("rooms the node no longer lists leave their folders", async () => {
    stored({ folders: [{ id: "F", name: "Games", roomIds: [k("B"), k("Z")] }], order: ["folder:F"] });
    renderWithProviders(<RoomRail />);
    await waitFor(() => expect(saved().folders[0]!.roomIds).toEqual([k("B")]));
  });
});
