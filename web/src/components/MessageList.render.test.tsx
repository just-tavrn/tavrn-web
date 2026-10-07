// SPDX-License-Identifier: Apache-2.0
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@tavrn/sdk";
import type { Decrypted } from "@tavrn/e2ee";

// Count row renders (every ungrouped row renders one avatar) and markdown renderings, behavior unchanged.
const counts = vi.hoisted(() => ({ avatar: 0, markdown: 0, media: 0 }));
vi.mock("./ui", async (orig) => {
  const mod = await orig<typeof import("./ui")>();
  return {
    ...mod,
    Avatar: (p: Parameters<typeof mod.Avatar>[0]) => {
      counts.avatar++;
      return mod.Avatar(p);
    },
  };
});
vi.mock("./Avatar", async (orig) => {
  const mod = await orig<typeof import("./Avatar")>();
  return {
    ...mod,
    MediaAvatar: (p: Parameters<typeof mod.MediaAvatar>[0]) => {
      counts.media++;
      return mod.MediaAvatar(p);
    },
  };
});
vi.mock("../lib/markdown", async (orig) => {
  const mod = await orig<typeof import("../lib/markdown")>();
  return {
    ...mod,
    renderMarkdown: (...args: Parameters<typeof mod.renderMarkdown>) => {
      counts.markdown++;
      return mod.renderMarkdown(...args);
    },
  };
});

const { MessageList } = await import("./MessageList");
const { AuthorAvatarProvider, createAuthorAvatarStore, mergeAuthorAvatars } = await import("./AuthorProfiles");

const at = (i: number) => new Date(Date.UTC(2026, 9, 4, 12, 0, i)).toISOString();
/** Alternating authors, so no message is grouped and every row shows an avatar. */
function message(i: number, extra: Partial<Message> = {}): Message {
  const author = i % 2 ? "alice@t.local" : "bob@t.local";
  return { id: `m${String(i).padStart(4, "0")}`, conversation_id: "c1", author, author_id: author, device_id: null, encrypted: false, format: 1, epoch: null, content: { type: "text", body: `**msg** ${i}` }, reply_to_id: null, thread_id: null, mentions: [], mentions_everyone: false, created_at: at(i), edited_at: null, attachments: [], reactions: [], pinned: false, ...extra };
}

describe("MessageList: render cost per incoming message (design note 9e)", () => {
  beforeEach(() => {
    counts.avatar = 0;
    counts.markdown = 0;
    counts.media = 0;
  });

  it("renders only the new or changed row, even with fresh callback and lookup objects from the caller", () => {
    const customEmojis = [{ id: "e1", name: "wave", roomId: "r1" }];
    const emojiUrls = {};
    let messages = Array.from({ length: 50 }, (_, i) => message(50 - i)); // newest first
    // Like ConversationView: a new `actions` object and new lookup maps on every render.
    const props = () => ({ currentUserId: "alice@t.local", canManage: true, canReact: true, canPin: true, hasMore: true, roomId: "r1", customEmojis, emojiUrls, actions: { onDelete: vi.fn(), onEdit: vi.fn(), onReact: vi.fn(), onPin: vi.fn() }, decrypted: {}, signatures: {}, onAtBottom: () => {} });
    const { rerender } = render(<MessageList messages={messages} {...props()} />);
    expect(screen.getAllByTestId("message")).toHaveLength(50);
    expect(counts.avatar).toBe(50);
    expect(counts.markdown).toBe(50);

    // A new message arrives: one row renders.
    messages = [message(51), ...messages];
    rerender(<MessageList messages={messages} {...props()} />);
    expect(screen.getAllByTestId("message")).toHaveLength(51);
    expect(counts.avatar).toBe(51);
    expect(counts.markdown).toBe(51);

    // A reaction on an older message: that row renders again, its markdown is not rebuilt.
    messages = messages.map((m) => (m.id === message(10).id ? { ...m, reactions: [{ emoji: "👍", count: 1, me: false }] } : m));
    rerender(<MessageList messages={messages} {...props()} />);
    expect(counts.avatar).toBe(52);
    expect(counts.markdown).toBe(51);
    expect(screen.getByRole("button", { name: "👍 1" })).toBeInTheDocument();

    // An edit: the row renders with the new body.
    messages = messages.map((m) => (m.id === message(20).id ? { ...m, content: { type: "text", body: "*edited*" }, edited_at: at(99) } : m));
    rerender(<MessageList messages={messages} {...props()} />);
    expect(counts.avatar).toBe(53);
    expect(counts.markdown).toBe(52);
    expect(document.querySelector(`[data-message-id=${message(20).id}] em`)).toHaveTextContent("edited");
  });

  it("does not re-render decrypted rows when the decryption map is rebuilt with the same results", () => {
    const results: Record<string, Decrypted> = {};
    const messages = Array.from({ length: 20 }, (_, i) => {
      const m = message(20 - i, { encrypted: true, content: `cipher${i}`, epoch: 1 });
      results[m.id] = { ok: true, content: { type: "text", body: `secret ${i}` } };
      return m;
    });
    const props = { currentUserId: "u9", canManage: false, hasMore: false };
    const { rerender } = render(<MessageList messages={messages} {...props} decrypted={{ ...results }} />);
    expect(counts.avatar).toBe(20);
    // useDecrypted returns a new map per pass, the results themselves are cached objects.
    const next = message(21, { encrypted: true, content: "cipherX", epoch: 1 });
    rerender(<MessageList messages={[next, ...messages]} {...props} decrypted={{ ...results, [next.id]: { ok: true, content: { type: "text", body: "fresh" } } }} />);
    expect(counts.avatar).toBe(21);
    expect(counts.markdown).toBe(21);
    expect(screen.getAllByTestId("message")[20]).toHaveTextContent("fresh");
  });

  it("a profile change re-renders only the avatars of that author, not the rows (design note 4.9)", () => {
    const store = createAuthorAvatarStore();
    const messages = Array.from({ length: 50 }, (_, i) => message(50 - i));
    const props = { currentUserId: "u9", canManage: false, hasMore: false };
    render(
      <AuthorAvatarProvider store={store}>
        <MessageList messages={messages} {...props} />
      </AuthorAvatarProvider>,
    );
    expect(counts.avatar).toBe(50);
    expect(counts.markdown).toBe(50);
    expect(screen.queryAllByTestId("avatar-image")).toHaveLength(0);
    // Bob's profile arrives: his 25 avatars switch to the image, Alice's rows do not render again.
    act(() => mergeAuthorAvatars(store, { "bob@t.local": { still: "https://n/api/v1/media/B", animated: null } }));
    expect(screen.getAllByTestId("avatar-image")).toHaveLength(25);
    expect(counts.media).toBe(25);
    expect(counts.avatar).toBe(50);
    expect(counts.markdown).toBe(50);
    // Alice's arrives: Bob's avatars stay as they are; an unchanged profile renders nothing.
    act(() => mergeAuthorAvatars(store, { "alice@t.local": { still: "https://n/api/v1/media/A", animated: "https://n/api/v1/media/A/animated" }, "bob@t.local": { still: "https://n/api/v1/media/B", animated: null } }));
    expect(screen.getAllByTestId("avatar-image")).toHaveLength(50);
    expect(counts.media).toBe(50);
    expect(counts.avatar).toBe(50);
  });

  it("uses the latest actions of the caller from memoized rows", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const m = message(1);
    const props = { currentUserId: "u9", canManage: true, hasMore: false };
    const { rerender } = render(<MessageList messages={[m]} {...props} actions={{ onDelete: first }} />);
    rerender(<MessageList messages={[m]} {...props} actions={{ onDelete: second }} />);
    screen.getByRole("button", { name: "Nachricht löschen" }).click();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(m);
    // Removing the action removes the button.
    rerender(<MessageList messages={[m]} {...props} actions={{}} />);
    expect(screen.queryByRole("button", { name: "Nachricht löschen" })).not.toBeInTheDocument();
  });
});

describe("MessageList: virtualized rows (design note 9e)", () => {
  /** jsdom has no layout: a 400 px list whose rows are 40 px high. */
  function fakeLayout() {
    const height = function (this: HTMLElement) {
      if (this.dataset.testid === "message-list") return 400;
      return this.dataset.index !== undefined ? 40 : 0;
    };
    const spies = [vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(height), vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(height), vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600)];
    return () => spies.forEach((s) => s.mockRestore());
  }

  it("keeps only the rows in and near the view in the DOM, however many messages are loaded", () => {
    const restore = fakeLayout();
    try {
      const props = { currentUserId: "u9", canManage: false, hasMore: true, onAtBottom: () => {} };
      let messages = Array.from({ length: 250 }, (_, i) => message(250 - i));
      const { rerender } = render(<MessageList messages={messages} {...props} />);
      const list = screen.getByTestId("message-list");
      expect(list).toHaveAttribute("data-loaded", "250");
      const shown = screen.getAllByTestId("message").length;
      expect(shown).toBeGreaterThan(5);
      expect(shown).toBeLessThan(40);
      const rendered = counts.avatar;
      expect(rendered).toBeLessThan(80);
      // A new message renders at most its own row; the DOM stays small.
      messages = [message(251), ...messages];
      rerender(<MessageList messages={messages} {...props} />);
      expect(counts.avatar - rendered).toBeLessThanOrEqual(1);
      expect(screen.getAllByTestId("message").length).toBeLessThan(40);
      expect(list).toHaveAttribute("data-loaded", "251");
    } finally {
      restore();
    }
  });

  it("keeps the loaded window bounded while following new messages (design note 4.4)", () => {
    const onAtBottom = vi.fn();
    const props = { currentUserId: "u9", canManage: false, hasMore: true, onAtBottom };
    let messages = Array.from({ length: 249 }, (_, i) => message(249 - i));
    const { rerender } = render(<MessageList messages={messages} {...props} />);
    expect(onAtBottom).not.toHaveBeenCalled();
    messages = [message(250), message(251), ...messages];
    rerender(<MessageList messages={messages} {...props} />);
    expect(onAtBottom).toHaveBeenCalledTimes(1);
  });
});
