// SPDX-License-Identifier: Apache-2.0
// Pills and chips in message bodies: user mentions open the profile card, role mentions the role's members, tavrn
// links become chips that resolve their names with the viewer's access and navigate inside the client.
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useLocation } from "react-router";
import type { Member, Message, RoomDetail } from "@tavrn/sdk";
import { MessageList } from "../components/MessageList";
import { useAuth } from "../stores/auth";
import { useLocale } from "../i18n";
import { useHiddenChannels } from "../lib/hiddenChannels";
import { mockFetch, renderWithProviders } from "../test/render";
import { ChatLinksContext, type ChatLinksValue } from "./context";

const R = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const C = "01JCCCCCCCCCCCCCCCCCCCCCCC";
const SECRET = "01JSSSSSSSSSSSSSSSSSSSSSSS";
const F = "01JFFFFFFFFFFFFFFFFFFFFFFF";
const M = "01JMMMMMMMMMMMMMMMMMMMMMMM";

const msg = (body: string, extra: Partial<Message> = {}): Message =>
  ({ id: "m1", conversation_id: C, author: "raid@t.local", author_id: "u5", device_id: "d1", encrypted: false, format: 1, epoch: null, content: { type: "text", body }, reply_to_id: null, thread_id: null, mentions: [], mentions_everyone: false, created_at: new Date().toISOString(), edited_at: null, attachments: [], reactions: [], pinned: false, ...extra }) as Message;

const user = (name: string) => ({ id: `u-${name}`, username: name, domain: "t.local", address: `${name}@t.local`, display_name: name[0]!.toUpperCase() + name.slice(1), kind: "user", is_node_admin: false, created_at: "", avatar: null, avatar_still: null });
const member = (name: string, roles: string[]): Member => ({ user: user(name), roles, nickname: null, joined_at: "" }) as unknown as Member;
const room = { id: R, name: "Guild", icon: null, icon_still: null, roles: [{ id: "r-every", name: "@everyone", is_everyone: true, color: null }, { id: "r-raid", name: "Raid Leads", is_everyone: false, color: "#cc3333" }], channels: [{ id: C, name: "raids", kind: "text", encrypted: false }, { id: "01JDDDDDDDDDDDDDDDDDDDDDDD", name: "files", kind: "files", encrypted: false }], read_states: [] } as unknown as RoomDetail;
const members = [member("alice", ["r-raid"]), member("bob", ["r-raid"]), member("carol", []), member("raid", [])];
const profile = { ...user("alice"), links: [], bio: "", profile_version: 1 };

function Where() {
  const l = useLocation();
  return <p data-testid="where">{`${l.pathname}${l.search}`}</p>;
}

function show(m: Message, value: ChatLinksValue = { room, roomMembers: members, members: members.map((x) => x.user.address) }) {
  return renderWithProviders(
    <ChatLinksContext.Provider value={value}>
      <MessageList messages={[m]} currentUserId="u9" currentAddress="me@t.local" roomId={R} canManage={false} hasMore={false} mentionRoles={["Raid Leads"]} />
      <Where />
    </ChatLinksContext.Provider>,
    { route: `/rooms/${R}/channels/${C}` },
  );
}

beforeEach(() => {
  useLocale.setState({ locale: "en" });
  useAuth.setState({ token: "t", user: { id: "u9", username: "me", domain: "t.local", address: "me@t.local", display_name: "Me", kind: "user", is_node_admin: false, created_at: "", email: null, email_verified: false, has_identity_key: true } as never });
  useHiddenChannels.setState({ ids: {} });
});

describe("mention pills", () => {
  it("a bot card without a mentions list shows its members as pills, not as e-mail links", async () => {
    mockFetch({});
    show(msg("Tanks: alice@t.local (Warrior) · leader @bob@t.local\nwrite to someone@mail.test"));
    const body = (await screen.findByText(/Tanks:/)).closest(".markdown") as HTMLElement;
    const pills = within(body).getAllByTestId("mention");
    expect(pills.map((p) => p.getAttribute("data-address"))).toEqual(["alice@t.local", "bob@t.local"]);
    expect(body.querySelector('a[href^="mailto:alice"]')).toBeNull();
    expect(body.querySelector('a[href="mailto:someone@mail.test"]')).not.toBeNull();
  });

  it("a user pill opens the profile card with the link to the full profile; Escape closes it", async () => {
    mockFetch({ "/users/alice%40t.local/profile": { body: profile } });
    show(msg("ping @alice", { mentions: ["alice@t.local"] }));
    const pill = await screen.findByText("@alice");
    expect(pill).toHaveAttribute("role", "button");
    expect(pill).toHaveAttribute("tabindex", "0");
    await userEvent.setup().click(pill);
    const card = await screen.findByTestId("profile-popover");
    expect(await within(card).findByTestId("profile-full")).toHaveAttribute("href", "/u/alice%40t.local");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("profile-popover")).toBeNull();
  });

  it("Enter on a focused pill opens the card too; @everyone is no button", async () => {
    mockFetch({ "/users/alice%40t.local/profile": { body: profile } });
    show(msg("@everyone and @alice", { mentions: ["alice@t.local"], mentions_everyone: true }));
    expect(await screen.findByText("@everyone")).not.toHaveAttribute("role");
    const pill = screen.getByText("@alice");
    pill.focus();
    fireEvent.keyDown(pill, { key: "Enter" });
    expect(await screen.findByTestId("profile-popover")).toBeInTheDocument();
  });

  it("a role pill lists the role's members; a member opens their card", async () => {
    mockFetch({ "/users/alice%40t.local/profile": { body: profile } });
    show(msg("@Raid Leads, sign up!"));
    await userEvent.setup().click(await screen.findByText("@Raid Leads"));
    const popover = await screen.findByTestId("role-popover");
    expect(popover).toHaveAttribute("role", "dialog");
    expect(popover).toHaveAccessibleName("Members with the role Raid Leads");
    const names = within(screen.getByTestId("role-popover-members")).getAllByRole("button");
    expect(names.map((b) => b.getAttribute("data-address"))).toEqual(["alice@t.local", "bob@t.local"]);
    expect(names[0]).toHaveAccessibleName("Show the profile of Alice");
    await userEvent.setup().click(names[0]!);
    expect(screen.queryByTestId("role-popover")).toBeNull();
    expect(await screen.findByTestId("profile-popover")).toBeInTheDocument();
  });

  it("the role list is capped with 'and N more'", async () => {
    mockFetch({});
    const many = Array.from({ length: 30 }, (_, i) => member(`m${String(i).padStart(2, "0")}`, ["r-raid"]));
    show(msg("@Raid Leads"), { room, roomMembers: many, members: [] });
    await userEvent.setup().click(await screen.findByText("@Raid Leads"));
    expect(within(await screen.findByTestId("role-popover-members")).getAllByRole("button")).toHaveLength(25);
    expect(screen.getByTestId("role-popover-more")).toHaveTextContent("and 5 more");
  });
});

describe("tavrn link chips", () => {
  it("a channel link shows the channel from the room cache and navigates in the client", async () => {
    mockFetch({ [`/rooms/${R}`]: { body: room } });
    show(msg(`see https://t.local/rooms/${R}/channels/${C}`));
    const chip = await screen.findByTestId("tavrn-chip");
    expect(await within(chip).findByText("raids")).toBeInTheDocument();
    expect(chip).toHaveAttribute("href", `/rooms/${R}/channels/${C}`);
    expect(chip).toHaveAccessibleName("Channel: raids");
    await userEvent.setup().click(chip);
    expect(screen.getByTestId("where")).toHaveTextContent(`/rooms/${R}/channels/${C}`);
  });

  it("a ctrl-click keeps the browser's link behaviour (no in-app navigation)", async () => {
    mockFetch({ [`/rooms/${R}`]: { body: room } });
    show(msg(`https://t.local/rooms/${R}/channels/${C}?message=${M}`));
    const chip = await screen.findByTestId("tavrn-chip");
    expect(await within(chip).findByText("Message in raids")).toBeInTheDocument();
    fireEvent.click(chip, { ctrlKey: true });
    expect(screen.getByTestId("where")).toHaveTextContent(`/rooms/${R}/channels/${C}`);
    expect(screen.getByTestId("where").textContent).not.toContain("?m=");
    await userEvent.setup().click(chip);
    expect(screen.getByTestId("where")).toHaveTextContent(`?m=${M}`);
  });

  it("a channel the viewer cannot see is a neutral 'Private channel', never its name", async () => {
    mockFetch({ [`/rooms/${R}`]: { body: room } });
    show(msg(`https://t.local/rooms/${R}/channels/${SECRET}`));
    const chip = await screen.findByTestId("tavrn-chip");
    expect(await within(chip).findByText("Private channel")).toBeInTheDocument();
  });

  it("a channel the viewer lost access to is private even while the cache still has it", async () => {
    mockFetch({ [`/rooms/${R}`]: { body: room } });
    useHiddenChannels.setState({ ids: { [C]: true } });
    show(msg(`https://t.local/rooms/${R}/channels/${C}`));
    expect(await within(await screen.findByTestId("tavrn-chip")).findByText("Private channel")).toBeInTheDocument();
    expect(screen.queryByText("raids")).toBeNull();
  });

  it("a room the node refuses is a 'Private room'", async () => {
    const other = "01JRRRRRRRRRRRRRRRRRRRRRRR";
    mockFetch({ [`/rooms/${other}`]: { status: 403, body: { code: "room.forbidden", status: 403, title: "Forbidden", detail: "", type: "x" } } });
    show(msg(`https://t.local/rooms/${other}`));
    expect(await within(await screen.findByTestId("tavrn-chip")).findByText("Private room")).toBeInTheDocument();
  });

  it("a file shows name and size with access, 'File not available' without", async () => {
    const entry = { id: F, channel_id: "01JDDDDDDDDDDDDDDDDDDDDDDD", parent_id: null, kind: "file", name: "roster.pdf", mime: "application/pdf", size: 2048, created_at: "", updated_at: "" };
    mockFetch({ [`/files/${F}`]: { body: { entry, path: [] } } });
    const { unmount } = show(msg(`https://t.local/rooms/${R}/channels/01JDDDDDDDDDDDDDDDDDDDDDDD/files/${F}`));
    const chip = await screen.findByTestId("tavrn-chip");
    expect(await within(chip).findByText("roster.pdf")).toBeInTheDocument();
    expect(chip).toHaveTextContent("2.0 KB");
    expect(chip).toHaveAttribute("href", `/rooms/${R}/channels/01JDDDDDDDDDDDDDDDDDDDDDDD/files/${F}`);
    unmount();
    mockFetch({ [`/files/${F}`]: { status: 403, body: { code: "channel.view_forbidden", status: 403, title: "Forbidden", detail: "", type: "x" } } });
    show(msg(`https://t.local/rooms/${R}/channels/01JDDDDDDDDDDDDDDDDDDDDDDD/files/${F}`));
    expect(await within(await screen.findByTestId("tavrn-chip")).findByText("File not available")).toBeInTheDocument();
  });

  it("an invite shows the room and Join, and opens the invite page", async () => {
    mockFetch({ "/invites/AbCd12": { body: { room: { id: R, name: "Guild", member_count: 3, icon: null, icon_still: null }, rules: null } } });
    show(msg("join us: https://t.local/invite/AbCd12"));
    const chip = await screen.findByTestId("tavrn-chip");
    expect(await within(chip).findByText("Guild")).toBeInTheDocument();
    expect(within(chip).getByTestId("tavrn-chip-join")).toHaveTextContent("Join");
    await userEvent.setup().click(chip);
    expect(screen.getByTestId("where")).toHaveTextContent("/invite/AbCd12");
  });

  it("a link of an unknown node stays a plain external link and is never fetched", async () => {
    const calls = mockFetch({});
    show(msg(`https://elsewhere.test/rooms/${R}/channels/${C}`));
    const link = await screen.findByRole("link", { name: `https://elsewhere.test/rooms/${R}/channels/${C}` });
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.queryByTestId("tavrn-chip")).toBeNull();
    await act(async () => {});
    expect(calls.some((c) => c.url.includes("elsewhere.test"))).toBe(false);
  });
});
