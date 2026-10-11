// SPDX-License-Identifier: Apache-2.0
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Permission, type RoomDetail } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { mockFetch, renderWithProviders } from "../test/render";
import { ConversationView } from "./ConversationView";
import { GhostWarning } from "./E2eeNotices";

const ghost = { identity: "mallory@t.local/01J9ZK3G5M8Q2W4E6R8T0Y2VD1", reason: "not_member" as const };
let e2ee: { phase: string; mls: unknown; waiting: string[]; ghosts: unknown[]; error: null; rejoined: boolean; tick: number } = { phase: "ready", mls: null, waiting: [] as string[], ghosts: [ghost], error: null, rejoined: false, tick: 0 };

let e2eeOpts: { noBots?: boolean } | null = null;

vi.mock("../hooks/useE2eeConversation", () => ({
  useE2eeConversation: (opts: { noBots?: boolean }) => {
    e2eeOpts = opts;
    return e2ee;
  },
  useDecrypted: () => ({}),
  usePlainSignatures: () => ({}),
}));

const me = { id: "u1", username: "bob", domain: "t.local", address: "bob@t.local", display_name: "Bob", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };

function view() {
  mockFetch({ "/conversations/c1/messages": { body: [] }, "/.well-known/tavrn": { body: { policies: { upload_max_bytes: 1000, uploads_enabled: true } } }, "/node": { body: { gif_provider: null, dm_policy: "friends" } } });
  return renderWithProviders(
    <ConversationView conversationId="c1" encrypted header={<h1>x</h1>} placeholder="Nachricht" canSend canManage={false} canAttach canReact canPin members={["bob@t.local"]} mayManage={false} domain="t.local" />,
  );
}

describe("ConversationView: ghost check (ENCRYPTION.md §4.6)", () => {
  it("names the unknown device and blocks sending until the user acknowledged it", async () => {
    useAuth.setState({ token: "t", user: me });
    const acknowledgeGhosts = vi.fn(async () => undefined);
    e2ee = { ...e2ee, mls: { acknowledgeGhosts } };
    view();
    const warning = screen.getByTestId("ghost-warning");
    expect(warning).toHaveTextContent("Ein unbekanntes Gerät ist Teil dieser Unterhaltung");
    expect(warning).toHaveTextContent(ghost.identity);
    expect(warning).toHaveTextContent("kein Mitglied dieser Unterhaltung");
    expect(screen.getByLabelText("Nachricht")).toBeDisabled();
    expect(screen.getByText("Bestätige zuerst die Warnung zum unbekannten Gerät.")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Ich verstehe" }));
    await waitFor(() => expect(screen.getByLabelText("Nachricht")).toBeEnabled());
    // The session manager is told: it refuses content to an unacknowledged ghost on its own (fail closed).
    expect(acknowledgeGhosts).toHaveBeenCalledWith("t.local/c1", [ghost.identity]);
    // The warning itself stays visible.
    expect(screen.getByTestId("ghost-warning")).toBeInTheDocument();
  });

  it("shows the locked notice and disables the composer without keys; waiting for a device in DMs", () => {
    useAuth.setState({ token: "t", user: me });
    e2ee = { ...e2ee, phase: "locked", ghosts: [] };
    const { unmount } = view();
    expect(screen.getByTestId("e2ee-locked")).toBeInTheDocument();
    expect(screen.getByLabelText("Nachricht")).toBeDisabled();
    unmount();
    e2ee = { ...e2ee, phase: "ready", waiting: ["carol@t.local"] };
    view();
    expect(screen.getByTestId("e2ee-waiting")).toHaveTextContent("carol@t.local");
    expect(screen.getByLabelText("Nachricht")).toBeDisabled();
    expect(screen.queryByTestId("unencrypted-banner")).not.toBeInTheDocument();
  });
});

describe("ConversationView: verified contact with a changed key (FEDERATION.md §10.2)", () => {
  function render(direct: boolean) {
    mockFetch({ "/conversations/c1/messages": { body: [] }, "/.well-known/tavrn": { body: { policies: { upload_max_bytes: 1000, uploads_enabled: true } } }, "/node": { body: { gif_provider: null, dm_policy: "friends" } } });
    return renderWithProviders(
      <ConversationView
        conversationId="c1"
        encrypted
        header={<h1>x</h1>}
        placeholder="Nachricht"
        canSend
        canManage={false}
        canAttach
        canReact
        canPin
        members={["bob@t.local", "alice@t.local"]}
        direct={direct ? ["alice@t.local", "bob@t.local"] : undefined}
        mayManage={false}
        domain="t.local"
      />,
    );
  }

  it("blocks sending in a DM until the user verifies again or trusts the new key", async () => {
    const { useMlsUi } = await import("../stores/mls");
    useAuth.setState({ token: "t", user: me });
    e2ee = { ...e2ee, phase: "ready", waiting: [], ghosts: [] };
    useMlsUi.setState({ verification: { "alice@t.local": "broken" } });
    render(true);
    const notice = screen.getByTestId("verification-notice");
    expect(notice).toHaveAttribute("data-blocking", "true");
    expect(notice).toHaveTextContent("alice@t.local hat einen neuen Sicherheitsschlüssel. Senden ist gesperrt");
    expect(screen.getByLabelText("Nachricht")).toBeDisabled();
    expect(screen.getByText(/Verifiziere erst erneut oder vertraue dem neuen Schlüssel/)).toBeInTheDocument();
    expect(notice.querySelectorAll("button")).toHaveLength(2);
    // Once the key is trusted (or verified again) the contact is no longer "broken".
    useMlsUi.setState({ verification: {} });
    await waitFor(() => expect(screen.getByLabelText("Nachricht")).toBeEnabled());
    expect(screen.queryByTestId("verification-notice")).not.toBeInTheDocument();
  });

  it("only warns in room channels, and ignores verified contacts", async () => {
    const { useMlsUi } = await import("../stores/mls");
    useAuth.setState({ token: "t", user: me });
    e2ee = { ...e2ee, phase: "ready", waiting: [], ghosts: [] };
    useMlsUi.setState({ verification: { "alice@t.local": "broken" } });
    const { unmount } = render(false);
    expect(screen.getByTestId("verification-notice")).toHaveAttribute("data-blocking", "false");
    expect(screen.getByLabelText("Nachricht")).toBeEnabled();
    unmount();
    useMlsUi.setState({ verification: { "alice@t.local": "verified" } });
    render(true);
    expect(screen.queryByTestId("verification-notice")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Nachricht")).toBeEnabled();
    useMlsUi.setState({ verification: {} });
  });
});

describe("ConversationView: \"no bots\" channels (APPLICATIONS.md §3.5)", () => {
  it("passes the channel's effective flag to the ghost check", () => {
    useAuth.setState({ token: "t", user: me });
    e2ee = { ...e2ee, phase: "ready", waiting: [], ghosts: [] };
    mockFetch({ "/conversations/c1/messages": { body: [] }, "/.well-known/tavrn": { body: { policies: { upload_max_bytes: 1000, uploads_enabled: true } } }, "/node": { body: { gif_provider: null, dm_policy: "friends" } } });
    const room = { id: "r1", roles: [], channels: [{ id: "c1", kind: "text", no_bots: false, no_bots_effective: true, history_for_new_members: "since_join" }] } as unknown as RoomDetail;
    const { unmount } = renderWithProviders(
      <ConversationView conversationId="c1" encrypted header={<h1>x</h1>} placeholder="Nachricht" canSend canManage={false} canAttach canReact canPin members={["bob@t.local"]} mayManage={false} domain="t.local" room={room} />,
    );
    expect(e2eeOpts?.noBots).toBe(true);
    unmount();
    view();
    expect(e2eeOpts?.noBots).toBe(false);
  });
});

describe("GhostWarning", () => {
  it("renders nothing without violations and lists every reason", () => {
    const { container, rerender } = renderWithProviders(<GhostWarning ghosts={[]} acknowledged={false} onAcknowledge={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<GhostWarning ghosts={[ghost, { identity: "a@t.local/X", reason: "unattested" }, { identity: "b@t.local/Y", reason: "duplicate" }]} acknowledged onAcknowledge={() => {}} />);
    expect(screen.getByTestId("ghost-warning")).toHaveTextContent("nicht mit dem Sicherheitsschlüssel des Nutzers bestätigt");
    expect(screen.getByTestId("ghost-warning")).toHaveTextContent("kommt mehrfach vor");
    expect(screen.queryByRole("button", { name: "Ich verstehe" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("ghost-bot-hint")).not.toBeInTheDocument();
  });

  it("explains a bot in a \"no bots\" channel (APPLICATIONS.md §3.5)", () => {
    renderWithProviders(<GhostWarning ghosts={[{ identity: "weatherbot@t.local/01J9ZK3G5M8Q2W4E6R8T0Y2VC1", reason: "bot" }]} acknowledged={false} onAcknowledge={() => {}} />);
    const warning = screen.getByTestId("ghost-warning");
    expect(warning).toHaveTextContent("weatherbot@t.local/01J9ZK3G5M8Q2W4E6R8T0Y2VC1");
    expect(warning).toHaveTextContent("ein Bot in einem Channel, in dem Bots nicht erlaubt sind");
    expect(screen.getByTestId("ghost-bot-hint")).toHaveTextContent("In diesem Channel sind keine Bots erlaubt");
    expect(screen.getByRole("button", { name: "Ich verstehe" })).toBeInTheDocument();
  });
});

describe("ConversationView: slash commands use the composer's send path", () => {
  it("encrypts /me with the MLS manager that became ready after the command runner was built", async () => {
    const { useMlsUi } = await import("../stores/mls");
    useAuth.setState({ token: "t", user: me });
    // Opening the channel: the device is still joining the group, no MLS manager yet.
    e2ee = { phase: "joining", mls: null, waiting: [], ghosts: [], error: null, rejoined: false, tick: 0 };
    const posted: unknown[] = [];
    mockFetch({
      "/conversations/c1/messages": (init) => {
        if (init.method !== "POST") return { body: [] };
        const body = JSON.parse(String(init.body));
        posted.push(body);
        return { body: { id: "01J00000000000000000000001", conversation_id: "c1", author: "bob@t.local", ...body, encrypted: true, created_at: "2026-10-05T00:00:00Z", reactions: [], attachments: [] } };
      },
      "/.well-known/tavrn": { body: { policies: { upload_max_bytes: 1000, uploads_enabled: true } } },
      "/node": { body: { gif_provider: null, dm_policy: "friends" } },
    });
    const encrypt = vi.fn(async (_q: string, _content: Record<string, unknown>, _opts?: unknown) => ({ content: { ciphertext: "CIPHERTEXT" }, epoch: 7 }));
    const signPlaintext = vi.fn(() => "SIG");
    renderWithProviders(
      <ConversationView conversationId="c1" encrypted header={<h1>x</h1>} placeholder="Nachricht" canSend canManage={false} canAttach canReact canPin members={["bob@t.local"]} mayManage={false} domain="t.local" permissions={Permission.SEND_MESSAGES} />,
    );
    expect(screen.getByLabelText("Nachricht")).toBeDisabled();
    // The group is joined: the view renders again with the manager (the command runner stays memoized).
    e2ee = { ...e2ee, phase: "ready", mls: { encrypt, signPlaintext } };
    useMlsUi.setState({ verification: {} });
    await waitFor(() => expect(screen.getByLabelText("Nachricht")).toBeEnabled());
    const u = userEvent.setup();
    await u.type(screen.getByLabelText("Nachricht"), "/me waves");
    await u.keyboard("{Enter}");
    await waitFor(() => expect(posted).toHaveLength(1));
    // The thread and reply are signed inside; the members go along for the re-check (ENCRYPTION.md §5.2, §4.6).
    expect(encrypt).toHaveBeenCalledWith("t.local/c1", { type: "action", body: "waves" }, { ctx: { thread_id: null, reply_to: null }, members: ["bob@t.local"], noBots: false });
    expect(signPlaintext).not.toHaveBeenCalled();
    expect(posted[0]).toMatchObject({ content: { ciphertext: "CIPHERTEXT" }, epoch: 7, mentions: [], mentions_everyone: false, reply_to_id: null });
    expect(JSON.stringify(posted[0])).not.toContain("waves");
    expect(screen.getByLabelText("Nachricht")).toHaveValue("");
  });
});
