// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "@tavrn/sdk";
import { MessageList } from "./MessageList";
import { AuthorAvatarProvider, AuthorProfiles, createAuthorAvatarStore } from "./AuthorProfiles";
import { useAuth } from "../stores/auth";
import { mockFetch, renderWithProviders } from "../test/render";

const base: Message = { id: "m1", conversation_id: "c1", author: "alice@t.local", author_id: "u1", device_id: "d1", encrypted: false, format: 1, epoch: null, content: { type: "text", body: "Hallo\nWelt" }, reply_to_id: null, thread_id: null, mentions: [], mentions_everyone: false, created_at: new Date().toISOString(), edited_at: null, attachments: [], reactions: [], pinned: false };

describe("MessageList", () => {
  it("shows text, system messages, ciphertext and unknown types appropriately", () => {
    const messages: Message[] = [
      { ...base, id: "m4", content: { type: "poll", question: "?" } },
      { ...base, id: "m3", encrypted: true, content: "Y2lwaGVy" },
      { ...base, id: "m2", device_id: null, content: { type: "system.encryption_changed", by: "alice@t.local", encrypted: true } },
      base,
    ];
    render(<MessageList messages={messages} currentUserId="u1" canManage={false} hasMore={false} />);
    const items = screen.getAllByTestId("message");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Hallo");
    expect(items[0]!.querySelector("br")).not.toBeNull();
    expect(screen.getByTestId("system-message")).toHaveTextContent("hat die Verschlüsselung eingeschaltet");
    expect(items[1]).toHaveTextContent("Verschlüsselte Nachricht");
    expect(items[1]).not.toHaveTextContent("Y2lwaGVy");
    expect(items[2]).toHaveTextContent("(poll) kann dein Client nicht anzeigen");
  });

  it("offers deletion only for own messages or with the manage permission", async () => {
    const onDelete = vi.fn();
    const foreign = { ...base, id: "m9", author_id: "u2", author: "bob@t.local" };
    const { rerender } = render(<MessageList messages={[foreign, base]} currentUserId="u1" canManage={false} hasMore={false} actions={{ onDelete }} />);
    expect(screen.getAllByRole("button", { name: "Nachricht löschen" })).toHaveLength(1);
    rerender(<MessageList messages={[foreign, base]} currentUserId="u1" canManage={true} hasMore={false} actions={{ onDelete }} />);
    const buttons = screen.getAllByRole("button", { name: "Nachricht löschen" });
    expect(buttons).toHaveLength(2);
    await userEvent.setup().click(buttons[0]!);
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }));
  });

  it("jumps to a message: highlights it; after a jump newer pages and the way back to the latest", async () => {
    const onLoadNewer = vi.fn();
    const onJumpLatest = vi.fn();
    const messages = [{ ...base, id: "m3", content: { type: "text", body: "drei" } }, { ...base, id: "m2", content: { type: "text", body: "zwei" } }, base];
    render(<MessageList messages={messages} currentUserId="u1" canManage={false} hasMore={false} focus={{ id: "m2", n: 1 }} hasNewer onLoadNewer={onLoadNewer} onJumpLatest={onJumpLatest} />);
    const row = screen.getByText("zwei").closest("article");
    expect(row).toHaveAttribute("data-highlighted", "true");
    expect(screen.getByText("drei").closest("article")).not.toHaveAttribute("data-highlighted");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("load-newer"));
    expect(onLoadNewer).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("jump-latest"));
    expect(onJumpLatest).toHaveBeenCalled();
  });

  it("shows the empty state and the button for older messages", async () => {
    const onLoadOlder = vi.fn();
    render(<MessageList messages={[]} currentUserId="u1" canManage={false} hasMore={true} onLoadOlder={onLoadOlder} />);
    expect(screen.getByText(/Noch keine Nachrichten/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Ältere Nachrichten laden" }));
    expect(onLoadOlder).toHaveBeenCalled();
  });
});

describe("MessageList: attachments, reactions, pins, Markdown", () => {
  it("shows Markdown, attachments, reactions and the pin marker", async () => {
    const onReact = vi.fn();
    const onPin = vi.fn();
    const m: Message = { ...base, content: { type: "text", body: "**fett** [l](https://x.y)" }, attachments: [{ id: "01J00000000000000000000000", name: "doc.pdf", mime: "application/pdf", size: 2048, sha256: "x" }], reactions: [{ emoji: "👍", count: 2, me: true }], pinned: true };
    renderWithProviders(<MessageList messages={[m]} currentUserId="u2" canManage={false} canReact canPin hasMore={false} actions={{ onReact, onPin }} />);
    const item = screen.getByTestId("message");
    expect(item.querySelector("strong")).toHaveTextContent("fett");
    expect(item.querySelector("a")).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(screen.getByTestId("attachment-file")).toHaveTextContent("doc.pdf");
    expect(screen.getByLabelText("Angepinnt")).toBeInTheDocument();
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "👍 2" }));
    expect(onReact).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }), "👍", true);
    await u.click(screen.getByRole("button", { name: "Anpinnen aufheben" }));
    expect(onPin).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }), false);
    await u.click(screen.getByRole("button", { name: "Reagieren" }));
    await u.click(await screen.findByRole("menuitem", { name: "🔥" }));
    expect(onReact).toHaveBeenLastCalledWith(expect.objectContaining({ id: "m1" }), "🔥", false);
  });
});

describe("MessageList: editing", () => {
  it("opens the editor only for own text messages and saves with Enter", async () => {
    const onEdit = vi.fn(async () => {});
    const foreign = { ...base, id: "m2", author_id: "u2" };
    render(<MessageList messages={[foreign, base]} currentUserId="u1" canManage hasMore={false} actions={{ onEdit }} />);
    expect(screen.getAllByRole("button", { name: "Nachricht bearbeiten" })).toHaveLength(1);
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Nachricht bearbeiten" }));
    const box = screen.getByLabelText("Neuer Text");
    await u.clear(box);
    await u.type(box, "neu{Enter}");
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }), "neu");
    await vi.waitFor(() => expect(screen.queryByTestId("message-editor")).not.toBeInTheDocument());
  });
});

describe("MessageList: encrypted messages", () => {
  const enc: Message = { ...base, id: "e1", encrypted: true, epoch: 3, content: "Y2lwaGVydGV4dA" };

  it("shows decrypted content, a neutral placeholder on failure, and never the ciphertext", () => {
    const failed: Message = { ...enc, id: "e2", content: "Z2VoZWlt" };
    render(
      <MessageList
        messages={[failed, enc]}
        currentUserId="u2"
        canManage={false}
        hasMore={false}
        decrypted={{ e1: { ok: true, content: { type: "text", body: "**geheim** entschlüsselt" } }, e2: { ok: false, reason: "bad_signature" } }}
      />,
    );
    const [ok, bad] = screen.getAllByTestId("message");
    expect(ok!.querySelector("strong")).toHaveTextContent("geheim");
    expect(bad).toHaveTextContent("Signatur ungültig");
    expect(screen.getByTestId("undecryptable")).toHaveAttribute("data-reason", "bad_signature");
    expect(screen.getByTestId("undecryptable")).toHaveAttribute("title", "Die Signatur des sendenden Geräts ist ungültig.");
    expect(document.body).not.toHaveTextContent("Z2VoZWlt");
    expect(document.body).not.toHaveTextContent("Y2lwaGVydGV4dA");
  });

  it("names the reason of a failure and marks messages of removed devices", () => {
    const a: Message = { ...enc, id: "a1", content: "QQ" };
    const b: Message = { ...enc, id: "b1", content: "Qg" };
    const r: Message = { ...enc, id: "r1", content: "Uw" };
    render(
      <MessageList
        messages={[a, b, r]}
        currentUserId="u2"
        canManage={false}
        hasMore={false}
        decrypted={{ a1: { ok: false, reason: "missing_key" }, b1: { ok: false, reason: "unknown_device" }, r1: { ok: true, content: { type: "text", body: "alt" }, retired: true } }}
      />,
    );
    const reasons = screen.getAllByTestId("undecryptable");
    expect(reasons.map((e) => e.getAttribute("data-reason")).sort()).toEqual(["missing_key", "unknown_device"]);
    const byReason = (r: string) => reasons.find((e) => e.getAttribute("data-reason") === r)!;
    expect(byReason("missing_key")).toHaveTextContent("Kein Schlüssel für diese Nachricht");
    expect(byReason("unknown_device")).toHaveTextContent("Sendendes Gerät nicht bestätigt");
    expect(screen.getByTestId("retired-device")).toHaveAttribute("title", "Diese Nachricht wurde von einem Gerät gesendet, das später entfernt wurde.");
  });

  it("does not render system types from encrypted content as system notices", () => {
    render(<MessageList messages={[enc]} currentUserId="u2" canManage={false} hasMore={false} decrypted={{ e1: { ok: true, content: { type: "system.encryption_changed", encrypted: false, by: "x" } } }} />);
    expect(screen.queryByTestId("system-message")).not.toBeInTheDocument();
    expect(screen.getByTestId("message")).toHaveTextContent("kann dein Client nicht anzeigen");
  });

  it("marks bots and authors whose security key changed", async () => {
    const { useMlsUi } = await import("../stores/mls");
    useMlsUi.setState({ changedKeys: { "alice@t.local": true } });
    render(<MessageList messages={[base]} currentUserId="u2" canManage={false} hasMore={false} bots={new Set(["alice@t.local"])} />);
    expect(screen.getByTestId("bot-badge")).toHaveTextContent("Bot");
    expect(screen.getByTestId("key-changed-badge")).toHaveTextContent("Sicherheitsschlüssel geändert");
    useMlsUi.setState({ changedKeys: {} });
  });
});

describe("MessageList: plaintext signatures and verified contacts (FEDERATION.md §10)", () => {
  it("marks unsigned and unverifiable messages, hides invalid ones and leaves valid and system messages alone", () => {
    const messages: Message[] = [
      { ...base, id: "s5", device_id: null, content: { type: "system.encryption_changed", by: "alice@t.local", encrypted: false } },
      { ...base, id: "s4", content: { type: "text", body: "Wiederholt" }, attachments: [{ id: "a1", name: "x.txt", mime: "text/plain", size: 1, sha256: "x" }] },
      { ...base, id: "s3", content: { type: "text", body: "Gefälscht" } },
      { ...base, id: "s2", content: { type: "text", body: "Ohne Signatur" } },
      { ...base, id: "s1", content: { type: "text", body: "Signiert" } },
    ];
    render(<MessageList messages={messages} currentUserId="u2" canManage={false} hasMore={false} signatures={{ s1: "valid", s2: "unsigned", s3: "invalid", s4: "replay" }} />);
    const [signed, unsigned, forged, replayed] = screen.getAllByTestId("message");
    expect(signed).toHaveTextContent("Signiert");
    expect(signed!.querySelector("[data-testid=unverified-marker]")).toBeNull();
    const marker = unsigned!.querySelector("[data-testid=unverified-marker]");
    expect(marker).toHaveTextContent("nicht verifiziert");
    expect(marker).toHaveAttribute("title", expect.stringContaining("Nicht vom Gerät des Absenders signiert"));
    // Wrong or reused signatures: the content (and attachments) are hidden.
    expect(forged).not.toHaveTextContent("Gefälscht");
    expect(forged).toHaveTextContent("Diese Nachricht konnte nicht verifiziert werden");
    expect(replayed).not.toHaveTextContent("Wiederholt");
    expect(replayed).not.toHaveTextContent("x.txt");
    expect(screen.getByTestId("system-message")).toBeInTheDocument();
    expect(screen.getAllByTestId("unverified-marker")).toHaveLength(1);
  });

  it("shows nothing while the signature is not checked yet (e.g. locked device)", () => {
    render(<MessageList messages={[base]} currentUserId="u2" canManage={false} hasMore={false} />);
    expect(screen.queryByTestId("unverified-marker")).not.toBeInTheDocument();
    expect(screen.getByTestId("message")).toHaveTextContent("Hallo");
  });

  it("shows the verified badge and the broken verification next to the author", async () => {
    const { useMlsUi } = await import("../stores/mls");
    useMlsUi.setState({ verification: { "alice@t.local": "verified" } });
    const { unmount } = render(<MessageList messages={[base]} currentUserId="u2" canManage={false} hasMore={false} />);
    expect(screen.getByTestId("verified-badge")).toHaveTextContent("verifiziert");
    unmount();
    useMlsUi.setState({ verification: { "alice@t.local": "broken" } });
    render(<MessageList messages={[base]} currentUserId="u2" canManage={false} hasMore={false} />);
    expect(screen.getByTestId("verification-broken-badge")).toHaveTextContent("Verifizierung ungültig");
    useMlsUi.setState({ verification: {} });
  });
});

describe("MessageList: lazy history", () => {
  /** jsdom has no layout: fake the scroll metrics of the list. */
  function scrollTo(list: HTMLElement, top: number, height = 2000, client = 400) {
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: height });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: client });
    list.scrollTop = top;
    fireEvent.scroll(list);
  }

  it("loads older messages automatically at the top, once while loading", () => {
    const onLoadOlder = vi.fn();
    const { rerender } = render(<MessageList messages={[base]} currentUserId="u1" canManage={false} hasMore onLoadOlder={onLoadOlder} />);
    const list = screen.getByTestId("message-list");
    scrollTo(list, 900);
    expect(onLoadOlder).not.toHaveBeenCalled();
    scrollTo(list, 10);
    scrollTo(list, 5);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    rerender(<MessageList messages={[base]} currentUserId="u1" canManage={false} hasMore={false} onLoadOlder={onLoadOlder} />);
    scrollTo(list, 0);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it("offers a jump to the latest messages when scrolled up and new ones arrive, and reports the bottom", async () => {
    const onAtBottom = vi.fn();
    const props = { currentUserId: "u1", canManage: false, hasMore: false, onAtBottom };
    const { rerender } = render(<MessageList messages={[base]} {...props} />);
    const list = screen.getByTestId("message-list");
    scrollTo(list, 300);
    const incoming = { ...base, id: "m2", author_id: "u2", author: "bob@t.local", content: { type: "text", body: "neu" } };
    rerender(<MessageList messages={[incoming, base]} {...props} />);
    const jump = screen.getByRole("button", { name: "Zu den neuesten Nachrichten" });
    await userEvent.setup().click(jump);
    scrollTo(list, 1600);
    expect(onAtBottom).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Zu den neuesten Nachrichten" })).not.toBeInTheDocument();
    // At the bottom, new messages scroll into view without the button.
    rerender(<MessageList messages={[{ ...incoming, id: "m3" }, incoming, base]} {...props} />);
    expect(screen.queryByRole("button", { name: "Zu den neuesten Nachrichten" })).not.toBeInTheDocument();
  });

  it("marks the beginning of the conversation once everything is loaded", () => {
    const { rerender } = render(<MessageList messages={[base]} currentUserId="u1" canManage={false} hasMore />);
    expect(screen.queryByTestId("history-start")).not.toBeInTheDocument();
    rerender(<MessageList messages={[base]} currentUserId="u1" canManage={false} hasMore={false} />);
    expect(screen.getByTestId("history-start")).toHaveTextContent("Hier beginnt die Unterhaltung.");
  });
});

describe("Emoji picker", () => {
  it("opens outside the row, moves the focus into the menu and closes with Escape or a click outside", async () => {
    const onReact = vi.fn();
    renderWithProviders(<MessageList messages={[base]} currentUserId="u2" canManage={false} canReact hasMore={false} actions={{ onReact }} />);
    const u = userEvent.setup();
    const button = screen.getByRole("button", { name: "Reagieren" });
    await u.click(button);
    const menu = screen.getByRole("dialog", { name: "Emoji wählen" });
    expect(screen.getByTestId("message").contains(menu)).toBe(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]));
    // Arrow keys move in the grid.
    await u.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[1]);
    await u.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(button);
    await u.click(button);
    await u.click(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onReact).not.toHaveBeenCalled();
  }, 30_000);

  it("places the popup below the button, or above it without room below, inside the viewport", async () => {
    const { pickerPosition } = await import("./Reactions");
    const viewport = { width: 400, height: 800 };
    expect(pickerPosition({ top: 100, bottom: 132, right: 380 }, 120, viewport)).toEqual({ top: 136, left: 44 });
    expect(pickerPosition({ top: 700, bottom: 732, right: 380 }, 120, viewport)).toEqual({ top: 576, left: 44 });
    // Narrow phones: the popup shrinks to the viewport.
    expect(pickerPosition({ top: 100, bottom: 132, right: 300 }, 120, { width: 320, height: 800 }).left).toBe(4);
    expect(pickerPosition({ top: 100, bottom: 132, right: 50 }, 120, viewport).left).toBe(4);
    // Short viewports (a phone in landscape): fits neither below nor above the button, starts at the top edge.
    expect(pickerPosition({ top: 250, bottom: 282, right: 380 }, 384, { width: 400, height: 392 }).top).toBe(4);
  });
});

describe("MessageList: author avatars (design note 4.9)", () => {
  const STILL = "http://localhost/api/v1/media/A";
  const ANIM = "http://localhost/api/v1/media/A/animated";

  it("shows the author's image (still, animated only on hover, never on touch), initials otherwise", () => {
    const store = createAuthorAvatarStore({ "alice@t.local": { still: STILL, animated: ANIM } });
    const bob = { ...base, id: "m2", author: "bob@t.local", author_id: "u2", created_at: new Date(Date.now() + 1000).toISOString() };
    render(
      <AuthorAvatarProvider store={store}>
        <MessageList messages={[bob, base]} currentUserId="u1" canManage={false} hasMore={false} />
      </AuthorAvatarProvider>,
    );
    const [aliceRow, bobRow] = screen.getAllByTestId("message");
    const avatar = within(aliceRow!).getByTestId("message-avatar");
    expect(avatar).toHaveAccessibleName("Profil von alice anzeigen");
    expect(within(avatar).getByTestId("avatar-image")).toHaveAttribute("src", STILL);
    fireEvent.pointerEnter(avatar, { pointerType: "touch" });
    expect(within(avatar).getByTestId("avatar-image")).toHaveAttribute("src", STILL);
    fireEvent.pointerEnter(avatar, { pointerType: "mouse" });
    expect(within(avatar).getByTestId("avatar-image")).toHaveAttribute("src", ANIM);
    fireEvent.pointerLeave(avatar);
    expect(within(avatar).getByTestId("avatar-image")).toHaveAttribute("src", STILL);
    // Bob has no image: his initials, as before.
    const bobAvatar = within(bobRow!).getByTestId("message-avatar");
    expect(within(bobAvatar).queryByTestId("avatar-image")).toBeNull();
    expect(bobAvatar).toHaveTextContent("B");
  });

  it("AuthorProfiles loads each author's profile once from the node and opens the card from the avatar", async () => {
    useAuth.setState({ token: "t", user: { id: "u9", username: "me", domain: "t.local", address: "me@t.local", display_name: "Me", kind: "user", is_node_admin: false, created_at: "", email: null, email_verified: false, has_identity_key: true } });
    const profile = { id: "u1", username: "alice", domain: "t.local", address: "alice@t.local", display_name: "Alice", kind: "user", is_node_admin: false, created_at: "", avatar: "/api/v1/media/A/animated", avatar_still: "/api/v1/media/A", links: [], bio: "", profile_version: 1 };
    const calls = mockFetch({ "/users/alice%40t.local/profile": { body: profile } });
    const messages = [{ ...base, id: "m3" }, { ...base, id: "m2" }, base];
    renderWithProviders(
      <AuthorProfiles messages={messages}>
        <MessageList messages={messages} currentUserId="u9" canManage={false} hasMore={false} />
      </AuthorProfiles>,
    );
    await waitFor(() => expect(screen.getByTestId("avatar-image")).toHaveAttribute("src", expect.stringMatching(/\/api\/v1\/media\/A$/)));
    expect(calls.filter((c) => c.url.includes("/profile"))).toHaveLength(1);
    await userEvent.setup().click(screen.getByTestId("message-avatar"));
    expect(await screen.findByTestId("profile-popover")).toBeInTheDocument();
  });
});
