// SPDX-License-Identifier: Apache-2.0
// Reaction chips: who reacted on hover, focus and long press (PROTOCOL.md §7 "Reactions"), loaded lazily from the
// reactors route and cached per message, emoji and count; up to ten names and "and n more"; the same text is the
// chip's accessible description; Escape hides it; a long press does not toggle the reaction.
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Reaction, User } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { useLocale } from "../i18n";
import { mockFetch, renderWithProviders } from "../test/render";
import { ReactionBar, REACTORS_SHOWN, reactorsText } from "./Reactions";

const me = { id: "A-ID", username: "alice", domain: "a.test", address: "alice@a.test", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const reactor = (n: number) => ({ user: `user${n}@a.test`, user_id: `U${n}`, created_at: "2026-10-15T10:00:00.000Z" });
const users = new Map<string, User>([["U1", { id: "U1", display_name: "Bob" } as unknown as User]]);

let calls: ReturnType<typeof mockFetch>;
beforeEach(() => {
  useLocale.getState().setLocale("en");
  useAuth.setState({ token: "t", refresh: "r", user: me, deviceId: "D", home: null });
  calls = mockFetch({ "/reactions/": { body: { items: Array.from({ length: REACTORS_SHOWN }, (_, i) => reactor(i + 1)), next: "x" } } });
});

function bar(reactions: Reaction[], onToggle = vi.fn()) {
  renderWithProviders(<ReactionBar reactions={reactions} canReact onToggle={onToggle} conversationId="C1" messageId="M1" usersById={users} />);
  return onToggle;
}

const reactorCalls = () => calls.filter((c) => c.url.includes("/reactions/"));

describe("reactorsText", () => {
  it("names up to ten reactors and counts the rest", () => {
    const t = (key: string, p?: Record<string, unknown>) => `${key}:${p?.n}`;
    expect(reactorsText(["A", "B"], 2, t as never)).toBe("A, B");
    expect(reactorsText(Array.from({ length: 12 }, (_, i) => `N${i}`), 15, t as never)).toBe("N0, N1, N2, N3, N4, N5, N6, N7, N8, N9 reactions.more:5");
    expect(reactorsText([], 3, t as never)).toBe("reactions.more_only:3");
    expect(reactorsText([], 0, t as never)).toBe("");
  });
});

describe("reaction chips", () => {
  it("loads who reacted only when hovered, then shows names and 'and n more' as tooltip and description", async () => {
    bar([{ emoji: "👍", count: 14, me: false }]);
    const chip = screen.getByRole("button", { name: "👍 14" });
    expect(reactorCalls()).toHaveLength(0);
    fireEvent.mouseEnter(chip.parentElement!);
    const tip = await screen.findByRole("tooltip");
    await waitFor(() => expect(tip).toHaveTextContent("Bob, user2, user3, user4, user5, user6, user7, user8, user9, user10 and 4 more"));
    expect(chip).toHaveAttribute("aria-describedby", tip.id);
    expect(reactorCalls()[0]!.url).toContain("/api/v1/conversations/C1/messages/M1/reactions/%F0%9F%91%8D?limit=10");
    fireEvent.mouseLeave(chip.parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(chip).not.toHaveAttribute("aria-describedby");
    // Cached per message, emoji and count: hovering again loads nothing.
    fireEvent.mouseEnter(chip.parentElement!);
    await screen.findByRole("tooltip");
    expect(reactorCalls()).toHaveLength(1);
  });

  it("keyboard focus shows the same text, Escape hides it", async () => {
    calls = mockFetch({ "/reactions/": { body: { items: [reactor(1), reactor(2)], next: null } } });
    bar([{ emoji: "🎉", count: 2, me: true }]);
    const chip = screen.getByRole("button", { name: "🎉 2" });
    act(() => chip.focus());
    const tip = await screen.findByRole("tooltip");
    await waitFor(() => expect(tip).toHaveTextContent("Bob, user2"));
    expect(chip).toHaveAccessibleDescription("Bob, user2");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("a failed load says so", async () => {
    mockFetch({ "/reactions/": { status: 403, body: { code: "channel.view_forbidden", status: 403, title: "", detail: "", type: "x" } } });
    bar([{ emoji: "👍", count: 1, me: false }]);
    fireEvent.focus(screen.getByRole("button", { name: "👍 1" }));
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Could not load who reacted"));
  });

  it("a long press on touch shows who reacted without toggling; a tap toggles", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onToggle = bar([{ emoji: "👍", count: 1, me: false }]);
      const chip = screen.getByRole("button", { name: "👍 1" });
      fireEvent.touchStart(chip, { touches: [{ clientX: 1, clientY: 1 }] });
      act(() => void vi.advanceTimersByTime(600));
      fireEvent.touchEnd(chip);
      fireEvent.click(chip);
      expect(onToggle).not.toHaveBeenCalled();
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
      // A touch elsewhere closes it; a tap toggles.
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole("tooltip")).toBeNull();
      fireEvent.touchStart(chip, { touches: [{ clientX: 1, clientY: 1 }] });
      fireEvent.touchEnd(chip);
      fireEvent.click(chip);
      expect(onToggle).toHaveBeenCalledWith("👍", false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("without a message reference (previews) no reactors are loaded", () => {
    renderWithProviders(<ReactionBar reactions={[{ emoji: "👍", count: 1, me: false }]} canReact onToggle={vi.fn()} />);
    const chip = screen.getByRole("button", { name: "👍 1" });
    fireEvent.mouseEnter(chip.parentElement!);
    fireEvent.focus(chip);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(reactorCalls()).toHaveLength(0);
  });
});
