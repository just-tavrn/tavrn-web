// SPDX-License-Identifier: Apache-2.0
// Room rules and the room's documents on every join path (tavrn-web#195): the invite list, public rooms of the home
// page, Discover, the "+" dialog's pasted link and the invite page. With rules: the dialog with the checkbox, which
// `accept_rules` follows; with a privacy notice only: a link, no checkbox; with nothing: a direct join.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import type { PendingInvite, UserPrivate } from "@tavrn/sdk";
import { mockFetch, renderWithProviders } from "../test/render";
import { useAuth } from "../stores/auth";
import { useToasts } from "../stores/toasts";
import { InviteList } from "./InviteList";
import { HomePage } from "../pages/HomePage";
import { InvitePage } from "../pages/InvitePage";
import { CreateRoomDialog } from "./CreateRoomDialog";

const ROOM = "01J0000000000000000000000R";
const room = { id: ROOM, name: "Lounge", description: "", icon_animated: false, member_count: 3, age_gate: "none" };
const RULES = "Be **kind**.";
const PRIVACY = "# Privacy\n\nWe keep messages.";
const LEGAL = "Run by Alice";

type Docs = { rules?: string; privacy_notice?: string; legal_notice?: string };
const preview = (d: Docs) => ({ room, rules: d.rules ?? "", privacy_notice: d.privacy_notice ?? "", privacy_notice_updated_at: d.privacy_notice ? "2026-10-01T10:00:00Z" : null, legal_notice: d.legal_notice ?? "", legal_notice_updated_at: d.legal_notice ? "2026-10-02T10:00:00Z" : null });
const detail = { ...room, channels: [], categories: [], roles: [], overrides: [], my_roles: [], my_permissions: "0", is_owner: false, read_states: [] };

function signIn() {
  useAuth.setState({ token: "t", user: { id: "u0", username: "bob", domain: "t.local", address: "bob@t.local", display_name: "Bob", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true } as UserPrivate, home: null });
}

/** Routes of the home node; `joins` collects the bodies of the join requests. */
function node(docs: Docs, extra: Parameters<typeof mockFetch>[0] = {}) {
  const joins: Array<{ url: string; body: unknown }> = [];
  const join = (init: RequestInit, url: string) => {
    joins.push({ url: new URL(url, "http://localhost").pathname, body: init.body ? JSON.parse(String(init.body)) : null });
    return { body: detail };
  };
  const calls = mockFetch({
    ...extra,
    "/invites/code1/join": join,
    "/invites/code1": { body: { code: "code1", ...preview(docs) } },
    [`/rooms/${ROOM}/join`]: join,
    [`/rooms/${ROOM}/preview`]: { body: preview(docs) },
    "/rooms/discover": { body: [room] },
    "/users/me/conversations-index": { body: { version: 1, items: [] } },
    "/users/me/friends": { body: { friends: [], incoming: [], outgoing: [], blocked: [] } },
  });
  return { joins, calls };
}

const invite = { id: "I1", kind: "room", node: "t.local", inviter: "alice@t.local", invite_code: "code1", room: { id: ROOM, name: "Lounge" }, conversation: null, received_at: "", expires_at: "" } as unknown as PendingInvite;

beforeEach(() => {
  signIn();
  useToasts.setState({ toasts: [] });
});

describe("the invite list", () => {
  const render = (docs: Docs) => {
    let items: PendingInvite[] = [invite];
    const n = node(docs, { "/users/me/invites": (init) => (init.method === "DELETE" ? ((items = []), { body: {} }) : { body: { items } }) });
    renderWithProviders(
      <Routes>
        <Route path="/" element={<InviteList />} />
        <Route path="/rooms/:roomId" element={<p>in the room</p>} />
      </Routes>,
    );
    return n;
  };

  it("with rules: the dialog with rules, checkbox and document links; Join waits for the checkbox", async () => {
    const user = userEvent.setup();
    const { joins } = render({ rules: RULES, privacy_notice: PRIVACY, legal_notice: LEGAL });
    await user.click(await screen.findByRole("button", { name: "Annehmen" }));
    const dialog = await screen.findByRole("dialog", { name: "Lounge beitreten" });
    expect(within(dialog).getByTestId("room-rules")).toHaveTextContent("Be kind.");
    expect(within(dialog).getByRole("button", { name: /Datenschutzhinweise/ })).toHaveAttribute("aria-expanded", "false");
    expect(within(dialog).getByRole("button", { name: /Impressum/ })).toBeInTheDocument();
    const submit = within(dialog).getByRole("button", { name: "Beitreten" });
    expect(submit).toBeDisabled();
    expect(joins).toEqual([]);
    await user.click(within(dialog).getByRole("checkbox", { name: "Ich akzeptiere die Regeln" }));
    await user.click(submit);
    await screen.findByText("in the room");
    expect(joins).toEqual([{ url: "/api/v1/invites/code1/join", body: { accept_rules: true } }]);
  });

  it("with a privacy notice only: a link that opens the notice, no checkbox, Join right away without accepting rules", async () => {
    const user = userEvent.setup();
    const { joins } = render({ privacy_notice: PRIVACY });
    await user.click(await screen.findByRole("button", { name: "Annehmen" }));
    const dialog = await screen.findByRole("dialog", { name: "Lounge beitreten" });
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(within(dialog).queryByTestId("room-rules")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Impressum/ })).toBeNull();
    const link = within(dialog).getByRole("button", { name: /Datenschutzhinweise/ });
    await user.click(link);
    expect(link).toHaveAttribute("aria-expanded", "true");
    const doc = within(dialog).getByRole("region", { name: "Datenschutzhinweise" });
    expect(doc).toHaveTextContent("We keep messages.");
    expect(link.getAttribute("aria-controls")).toBe(doc.parentElement?.id);
    expect(within(dialog).getByText(/Aktualisiert am/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Beitreten" }));
    await screen.findByText("in the room");
    expect(joins).toEqual([{ url: "/api/v1/invites/code1/join", body: { accept_rules: false } }]);
  });

  it("with nothing to show: joins directly, as before", async () => {
    const user = userEvent.setup();
    const { joins } = render({});
    await user.click(await screen.findByRole("button", { name: "Annehmen" }));
    await screen.findByText("in the room");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(joins).toEqual([{ url: "/api/v1/invites/code1/join", body: { accept_rules: false } }]);
  });

  it("Cancel closes the dialog without joining", async () => {
    const user = userEvent.setup();
    const { joins } = render({ rules: RULES });
    await user.click(await screen.findByRole("button", { name: "Annehmen" }));
    const dialog = await screen.findByRole("dialog", { name: "Lounge beitreten" });
    await user.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(joins).toEqual([]);
  });
});

describe("public rooms of the home page", () => {
  const render = (docs: Docs) => {
    const n = node(docs, { "/users/me/invites": { body: { items: [] } } });
    renderWithProviders(
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/rooms/:roomId" element={<p>in the room</p>} />
      </Routes>,
    );
    return n;
  };
  const joinButton = async () => within((await screen.findByText("Lounge")).closest("li")!).getByRole("button", { name: "Beitreten" });

  it("with rules: the dialog; the join carries the ticked checkbox", async () => {
    const user = userEvent.setup();
    const { joins, calls } = render({ rules: RULES });
    await user.click(await joinButton());
    const dialog = await screen.findByRole("dialog", { name: "Lounge beitreten" });
    expect(calls.some((c) => c.url.endsWith(`/rooms/${ROOM}/preview`))).toBe(true);
    await user.click(within(dialog).getByRole("checkbox", { name: "Ich akzeptiere die Regeln" }));
    await user.click(within(dialog).getByRole("button", { name: "Beitreten" }));
    await screen.findByText("in the room");
    expect(joins).toEqual([{ url: `/api/v1/rooms/${ROOM}/join`, body: { accept_rules: true } }]);
  });

  it("with a legal notice only: the link, no checkbox", async () => {
    const user = userEvent.setup();
    const { joins } = render({ legal_notice: LEGAL });
    await user.click(await joinButton());
    const dialog = await screen.findByRole("dialog", { name: "Lounge beitreten" });
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(within(dialog).getByRole("button", { name: /Impressum/ })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Beitreten" }));
    await screen.findByText("in the room");
    expect(joins).toEqual([{ url: `/api/v1/rooms/${ROOM}/join`, body: { accept_rules: false } }]);
  });

  it("with nothing to show: joins directly", async () => {
    const user = userEvent.setup();
    const { joins } = render({});
    await user.click(await joinButton());
    await screen.findByText("in the room");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(joins).toEqual([{ url: `/api/v1/rooms/${ROOM}/join`, body: { accept_rules: false } }]);
  });

  it("a node without the preview route: joins directly; a refusal for rules is shown", async () => {
    const user = userEvent.setup();
    const joins: unknown[] = [];
    mockFetch({
      "/users/me/invites": { body: { items: [] } },
      [`/rooms/${ROOM}/join`]: (init) => (joins.push(JSON.parse(String(init.body))), { status: 403, body: { type: "x", title: "", status: 403, detail: "", code: "room.rules_not_accepted" } }),
      "/rooms/discover": { body: [room] },
    });
    renderWithProviders(<HomePage />);
    await user.click(await joinButton());
    await waitFor(() => expect(useToasts.getState().toasts.length).toBe(1));
    expect(joins).toEqual([{ accept_rules: false }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rules added after the preview: the refused direct join opens the dialog", async () => {
    const user = userEvent.setup();
    let previews = 0;
    const joins: unknown[] = [];
    mockFetch({
      "/users/me/invites": { body: { items: [] } },
      [`/rooms/${ROOM}/preview`]: () => ({ body: preview(previews++ === 0 ? {} : { rules: RULES }) }),
      [`/rooms/${ROOM}/join`]: (init) => {
        const body = JSON.parse(String(init.body)) as { accept_rules: boolean };
        joins.push(body);
        return body.accept_rules ? { body: detail } : { status: 403, body: { type: "x", title: "", status: 403, detail: "", code: "room.rules_not_accepted" } };
      },
      "/rooms/discover": { body: [room] },
      "/users/me/conversations-index": { body: { version: 1, items: [] } },
    });
    renderWithProviders(<HomePage />);
    await user.click(await joinButton());
    const dialog = await screen.findByRole("dialog", { name: "Lounge beitreten" });
    await user.click(within(dialog).getByRole("checkbox", { name: "Ich akzeptiere die Regeln" }));
    await user.click(within(dialog).getByRole("button", { name: "Beitreten" }));
    await waitFor(() => expect(joins).toEqual([{ accept_rules: false }, { accept_rules: true }]));
  });
});

describe("the + dialog's pasted link and the invite page use the same block", () => {
  it("+ dialog: rules with the checkbox and the document links in the preview", async () => {
    const user = userEvent.setup();
    const { joins } = node({ rules: RULES, legal_notice: LEGAL });
    const onCreated = vi.fn();
    renderWithProviders(<CreateRoomDialog open onClose={() => {}} onCreated={onCreated} />);
    await user.click(screen.getByRole("tab", { name: "Mit Einladung beitreten" }));
    await user.type(screen.getByLabelText("Einladungslink oder Code"), "code1");
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    const block = await screen.findByTestId("join-block");
    expect(within(block).getByTestId("join-preview-name")).toHaveTextContent("Lounge");
    expect(within(block).getByRole("button", { name: /Impressum/ })).toBeInTheDocument();
    const submit = screen.getByTestId("join-invite-submit");
    expect(submit).toBeDisabled();
    await user.click(within(block).getByRole("checkbox", { name: "Ich akzeptiere die Regeln" }));
    await user.click(submit);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(`/rooms/${ROOM}`));
    expect(joins).toEqual([{ url: "/api/v1/invites/code1/join", body: { accept_rules: true } }]);
  });

  it("invite page: a privacy notice without rules is a link, Join is enabled", async () => {
    node({ privacy_notice: PRIVACY });
    renderWithProviders(
      <Routes>
        <Route path="/invite/:code" element={<InvitePage />} />
      </Routes>,
      { route: "/invite/code1" },
    );
    expect(await screen.findByTestId("invite-room-name")).toHaveTextContent("Lounge");
    expect(screen.getByRole("button", { name: /Datenschutzhinweise/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Beitreten" })).toBeEnabled();
  });

  it("invite page: rules keep the page's box and the checkbox gates Join", async () => {
    const user = userEvent.setup();
    node({ rules: RULES });
    renderWithProviders(
      <Routes>
        <Route path="/invite/:code" element={<InvitePage />} />
      </Routes>,
      { route: "/invite/code1" },
    );
    expect(await screen.findByText("Regeln")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Beitreten" });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Ich akzeptiere die Regeln" }));
    expect(submit).toBeEnabled();
  });
});
