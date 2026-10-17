// SPDX-License-Identifier: Apache-2.0
// Room settings → "Privacy & legal" (PROTOCOL.md §6b): managers edit the privacy notice and the legal notice with a
// preview and a draft template; every other member reads what the room published.
import { describe, expect, it, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Permission, type RoomDetail } from "@tavrn/sdk";
import { mockFetch, renderWithProviders } from "../../test/render";
import { useAuth } from "../../stores/auth";
import { useToasts } from "../../stores/toasts";
import { RoomLegalTab, showsLegalTab } from "./RoomLegalTab";

const ROOM = "01J0000000000000000000000R";
const room = (perms: bigint, docs: { privacy?: string | null; legal?: string | null } = {}) =>
  ({ id: ROOM, name: "Lounge", description: "", rules: "", join_mode: "invite", my_permissions: perms.toString(), privacy_notice_updated_at: docs.privacy ?? null, legal_notice_updated_at: docs.legal ?? null }) as unknown as RoomDetail;

function node(texts: { privacy_notice?: string; legal_notice?: string }, privacyPage = true) {
  const patches: unknown[] = [];
  const calls = mockFetch({
    [`/rooms/${ROOM}/preview`]: { body: { room: { id: ROOM, name: "Lounge" }, rules: "", privacy_notice: texts.privacy_notice ?? "", privacy_notice_updated_at: texts.privacy_notice ? "2026-10-01T10:00:00Z" : null, legal_notice: texts.legal_notice ?? "", legal_notice_updated_at: null } },
    [`/rooms/${ROOM}`]: (init) => (patches.push(JSON.parse(String(init.body))), { body: room(Permission.MANAGE_ROOM) }),
    "/api/v1/node": { body: { domain: "t.local", legal: { pages: privacyPage ? { privacy: { version: 1 } } : {}, notices: {}, terms_mode: "notice" } } },
  });
  return { patches, calls };
}

describe("RoomLegalTab", () => {
  beforeEach(() => {
    useAuth.setState({ token: "t", user: { id: "u0", username: "bob", domain: "t.local" } as never });
    useToasts.setState({ toasts: [] });
  });

  it("is shown to managers always, to other members only while the room publishes a document", () => {
    expect(showsLegalTab(room(Permission.MANAGE_ROOM))).toBe(true);
    expect(showsLegalTab(room(0n))).toBe(false);
    expect(showsLegalTab(room(0n, { legal: "2026-10-01T10:00:00Z" }))).toBe(true);
  });

  it("managers: both editors with the current texts, help with the guide and the node's policy, save sends both", async () => {
    const user = userEvent.setup();
    const { patches } = node({ privacy_notice: "Old privacy" });
    renderWithProviders(<RoomLegalTab room={room(Permission.MANAGE_ROOM, { privacy: "2026-10-01T10:00:00Z" })} />);
    const privacy = await screen.findByLabelText("Datenschutzhinweise (Markdown)");
    expect(privacy).toHaveValue("Old privacy");
    expect(screen.getByLabelText("Impressum (Markdown)")).toHaveValue("");
    expect(screen.getByText(/keine Rechtsberatung/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Leitfaden/ })).toHaveAttribute("href", "https://github.com/just-tavrn/tavrn/blob/main/docs/room-legal.md");
    expect(await screen.findByRole("link", { name: "Datenschutzerklärung von t.local" })).toHaveAttribute("href", expect.stringMatching(/\/legal\/privacy$/));
    const save = screen.getByRole("button", { name: "Speichern" });
    expect(save).toBeDisabled();
    await user.clear(privacy);
    await user.type(privacy, "New privacy");
    await user.type(screen.getByLabelText("Impressum (Markdown)"), "Run by Bob");
    await user.click(save);
    await waitFor(() => expect(patches).toEqual([{ privacy_notice: "New privacy", legal_notice: "Run by Bob" }]));
  });

  it("the template fills a German draft with the room and the node's policy; it asks before replacing a text", async () => {
    const user = userEvent.setup();
    node({ legal_notice: "Mine" });
    renderWithProviders(<RoomLegalTab room={room(Permission.MANAGE_ROOM)} />);
    const privacy = await screen.findByLabelText("Datenschutzhinweise (Markdown)");
    await screen.findByRole("link", { name: "Datenschutzerklärung von t.local" });
    await user.click(within(screen.getByTestId("room-legal-privacy")).getByRole("button", { name: "Vorlage laden" }));
    const draft = (privacy as HTMLTextAreaElement).value;
    expect(draft).toContain("Entwurf");
    expect(draft).toContain("„Lounge“");
    expect(draft).toMatch(/\/legal\/privacy/);
    // The legal notice has a text: the template asks first; cancelling keeps it.
    await user.click(within(screen.getByTestId("room-legal-legal")).getByRole("button", { name: "Vorlage laden" }));
    const confirm = await screen.findByRole("dialog");
    await user.click(within(confirm).getByRole("button", { name: "Abbrechen" }));
    expect(screen.getByLabelText("Impressum (Markdown)")).toHaveValue("Mine");
    // The preview renders the draft as members will see it.
    await user.click(within(screen.getByTestId("room-legal-privacy")).getByRole("button", { name: "Vorschau" }));
    expect(screen.getByRole("region", { name: "Datenschutzhinweise" })).toHaveTextContent("Datenschutzhinweise für den Raum");
  });

  it("other members read the published documents, no editors", async () => {
    node({ privacy_notice: "# Privacy\n\nWe keep messages." });
    renderWithProviders(<RoomLegalTab room={room(0n, { privacy: "2026-10-01T10:00:00Z" })} />);
    const doc = await screen.findByRole("region", { name: "Datenschutzhinweise" });
    expect(doc).toHaveTextContent("We keep messages.");
    expect(doc.querySelector("h1")).not.toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(/Aktualisiert am/)).toBeInTheDocument();
  });
});
