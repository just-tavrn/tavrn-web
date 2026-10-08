// SPDX-License-Identifier: Apache-2.0
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmojiPicker } from "./EmojiPicker";
import { EmojiContext, type EmojiContextValue } from "../lib/emojis";
import { mockFetch, renderWithProviders } from "../test/render";

const ROOM_EMOJI = { id: "01J9ZK8Q4V6X3M2N1P0R5S7T8W", room_id: "r1", name: "local", mime: "image/webp", size: 10, created_at: "", animated: false };
// The picker loads the Unicode emoji data on first open; hosted CI runners need longer than the 1 s default.
const FIND = { timeout: 10_000 };
// The whole test may take a while on a busy CI runner (the JSON is transformed by Vite on first import).
const SLOW = { timeout: 30_000 };
const PERSONAL = { id: "01J9ZK8Q4V6X3M2N1P0R5S7T9X", name: "mine", mime: "image/webp", size: 10, animated: true, created_at: "" };

function setup(external: boolean) {
  mockFetch({ "/users/me/emojis": { body: { items: [PERSONAL], max_personal: 20, max_bytes: 1 } }, "/rooms": { body: [] } });
  const onPick = vi.fn();
  const ctx: EmojiContextValue = { domain: "t.local", roomId: "r1", externalAllowed: external, roomEmojis: [ROOM_EMOJI] };
  renderWithProviders(
    <EmojiContext.Provider value={ctx}>
      <EmojiPicker onPick={onPick} label="Emoji" />
    </EmojiContext.Provider>,
  );
  return onPick;
}

describe("EmojiPicker (design note 4.13)", () => {
  beforeEach(() => localStorage.clear());

  it("searches Unicode and custom emojis, applies the skin tone and remembers picks", SLOW, async () => {
    const onPick = setup(true);
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Emoji" }));
    await screen.findByRole("menuitem", { name: ":local:" }, FIND);
    await screen.findByRole("menuitem", { name: ":mine:" }, FIND);
    await u.selectOptions(screen.getByLabelText("Hautfarbe"), "3");
    await u.type(screen.getByLabelText("Emojis suchen"), "daumen hoch");
    const results = await screen.findByRole("group", { name: "Suchergebnisse" }, FIND);
    // The Unicode data is imported lazily (a large JSON): the results fill in once it is there.
    const [first] = await within(results).findAllByRole("menuitem", {}, FIND);
    await u.click(first!);
    expect(onPick).toHaveBeenLastCalledWith("👍🏽");
    await u.click(screen.getByRole("button", { name: "Emoji" }));
    const recent = await screen.findByRole("group", { name: "Zuletzt verwendet" }, FIND);
    expect(within(recent).getByRole("menuitem", { name: "👍🏽" })).toBeInTheDocument();
    // Room emojis insert by name, personal ones as tokens.
    await u.click(screen.getByRole("menuitem", { name: ":local:" }));
    expect(onPick).toHaveBeenLastCalledWith(":local:");
    await u.click(screen.getByRole("button", { name: "Emoji" }));
    await u.click(await screen.findByRole("menuitem", { name: ":mine:" }, FIND));
    expect(onPick).toHaveBeenLastCalledWith(`<:mine:${PERSONAL.id}>`);
  });

  it("greys out external emojis without use_external_emojis", SLOW, async () => {
    const onPick = setup(false);
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Emoji" }));
    const mine = await screen.findByRole("menuitem", { name: ":mine:" }, FIND);
    expect(mine).toHaveAttribute("aria-disabled", "true");
    expect(mine.getAttribute("title")).toContain("Externe Emojis verwenden");
    await u.click(mine);
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByTestId("emoji-external-note")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: ":local:" })).not.toHaveAttribute("aria-disabled");
  });
});
