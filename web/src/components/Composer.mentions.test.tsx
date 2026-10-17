// SPDX-License-Identifier: Apache-2.0
// The composer's @-mention autocomplete (docs/CLIENT.md "The composer"): opens only at the start of a word, keyboard
// and mouse picking, Escape leaves the text as typed, never together with the command palette, combobox semantics.
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import { BUILTIN_COMMANDS } from "../commands/builtin";
import type { MentionCandidate } from "../composer/mentions";

const user = (username: string, name: string, extra: Partial<MentionCandidate> = {}): MentionCandidate => ({
  kind: "user",
  key: `${username}@a.example`,
  insert: `@${username}`,
  name,
  username,
  remote: null,
  avatar: { address: `${username}@a.example`, display_name: name, avatar: null, avatar_still: null },
  ...extra,
});
const mentions: MentionCandidate[] = [
  user("alice", "Alice"),
  user("albert", "Albert"),
  user("carol", "Carol", { key: "carol@b.example", insert: "@carol@b.example", remote: "b.example" }),
  user("helper", "Helper", { bot: true }),
  user("me", "Me", { self: true }),
  { kind: "role", key: "role:staff", insert: "@Mod Team", name: "Mod Team", color: "#ff0000" },
];

function setup(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn(async () => {});
  render(<Composer placeholder="Nachricht" onSend={onSend} mentions={mentions} {...props} />);
  const box = screen.getByLabelText("Nachricht") as HTMLTextAreaElement;
  return { onSend, box, u: userEvent.setup() };
}
const list = () => screen.queryByRole("listbox", { name: "Personen und Rollen zum Erwähnen" });
const options = () => within(list()!).getAllByRole("option");

describe("Composer: mention autocomplete", () => {
  it("opens after @ at the start of a word with matching people, avatars, BOT badge and remote domains", async () => {
    const { box, u } = setup();
    await u.type(box, "hi @");
    expect(list()).not.toBeNull();
    // Everybody, the own user last; the bot carries its badge, the remote user its domain.
    expect(options().map((o) => o.getAttribute("data-key"))).toEqual(["alice@a.example", "albert@a.example", "carol@b.example", "helper@a.example", "role:staff", "me@a.example"]);
    expect(within(options()[3]!).getByTestId("bot-badge")).toBeInTheDocument();
    expect(within(options()[2]!).getByTestId("suggest-handle")).toHaveTextContent("@carol@b.example");
    // Prefix matches first, then fuzzy ones (c-a-r-o-l contains a…l).
    await u.type(box, "al");
    expect(options().map((o) => o.getAttribute("data-key"))).toEqual(["alice@a.example", "albert@a.example", "carol@b.example"]);
  });

  it("a word that already is a candidate's mention exactly is not offered again: Enter sends", async () => {
    const { box, u, onSend } = setup();
    await u.type(box, "/kick @alice");
    // "@alice" is alice's mention as typed (case-insensitive too): only other matches would stay offered.
    expect(list()).toBeNull();
    await u.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect((onSend.mock.calls[0] as unknown as [{ body: string }])[0].body).toBe("/kick @alice");
    await u.type(box, "hi @ALICE");
    expect(list()).toBeNull();
    // A prefix is still completed with Enter.
    await u.clear(box);
    await u.type(box, "@ali");
    expect(options().map((o) => o.getAttribute("data-key"))).toEqual(["alice@a.example"]);
    await u.keyboard("{Enter}");
    expect(box.value).toBe("@alice ");
  });

  it("is a combobox: aria-expanded, aria-controls and aria-activedescendant follow the list", async () => {
    const { box, u } = setup();
    expect(box).toHaveAttribute("role", "combobox");
    expect(box).toHaveAttribute("aria-expanded", "false");
    await u.type(box, "@ca");
    expect(box).toHaveAttribute("aria-expanded", "true");
    const lb = list()!;
    expect(box).toHaveAttribute("aria-controls", lb.id);
    expect(box.getAttribute("aria-activedescendant")).toBe(options()[0]!.id);
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
  });

  it("picks with Enter or Tab and inserts the form extractMentions recognises, with one space", async () => {
    const { box, u, onSend } = setup();
    await u.type(box, "hallo @car");
    await u.keyboard("{Enter}");
    expect(box.value).toBe("hallo @carol@b.example ");
    expect(onSend).not.toHaveBeenCalled();
    expect(list()).toBeNull();
    await u.type(box, "und @Mod");
    await u.keyboard("{Tab}");
    expect(box.value).toBe("hallo @carol@b.example und @Mod Team ");
    // Enter sends once no list is open.
    await u.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ body: "hallo @carol@b.example und @Mod Team" }));
  });

  it("navigates with the arrow keys and picks with the mouse without losing the focus", async () => {
    const { box, u } = setup();
    await u.type(box, "@al");
    expect(options()).toHaveLength(3);
    await u.keyboard("{ArrowDown}");
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    await u.keyboard("{ArrowUp}{ArrowUp}");
    // Wraps around.
    expect(options()[2]).toHaveAttribute("aria-selected", "true");
    await u.keyboard("{Enter}");
    expect(box.value).toBe("@carol@b.example ");
    await u.type(box, "@al");
    fireEvent.mouseDown(options()[1]!);
    expect(box.value).toBe("@carol@b.example @albert ");
    expect(box).toHaveFocus();
  });

  it("Escape closes the list and leaves the text exactly as typed; a new trigger opens it again", async () => {
    const { box, u, onSend } = setup();
    await u.type(box, "@ali");
    await u.keyboard("{Escape}");
    expect(list()).toBeNull();
    expect(box.value).toBe("@ali");
    // Typing on in the same word keeps it closed; Enter sends the text as typed.
    await u.type(box, "c");
    expect(list()).toBeNull();
    await u.type(box, " @ca");
    expect(list()).not.toBeNull();
    await u.keyboard("{Escape}{Enter}");
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ body: "@alic @ca" }));
  });

  it("never blocks writing @: addresses, URLs, code and unmatched words just continue", async () => {
    const { box, u, onSend } = setup();
    await u.type(box, "mail an foo@al");
    expect(list()).toBeNull();
    await u.clear(box);
    await u.type(box, "https://x.example/@al");
    expect(list()).toBeNull();
    await u.clear(box);
    await u.type(box, "`@al");
    expect(list()).toBeNull();
    await u.clear(box);
    // No match: no list, the space and Enter behave as always.
    await u.type(box, "@zzz weiter{Enter}");
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ body: "@zzz weiter" }));
  });

  it("a role name with a space keeps the list while it still matches", async () => {
    const { box, u } = setup();
    await u.type(box, "@Mod T");
    expect(options().map((o) => o.getAttribute("data-key"))).toEqual(["role:staff"]);
    await u.type(box, "x");
    expect(list()).toBeNull();
  });

  it("the slash-command palette keeps working and both never open at once", async () => {
    const { box, u } = setup({ commands: { available: BUILTIN_COMMANDS.filter((d) => ["me", "shrug"].includes(d.name)), run: vi.fn(async () => {}) } });
    await u.type(box, "/m");
    expect(screen.getByTestId("command-palette")).toBeInTheDocument();
    expect(list()).toBeNull();
    await u.clear(box);
    // In a command's free text the mention list works.
    await u.type(box, "/me winkt @ali");
    expect(screen.queryByTestId("command-palette")).toBeNull();
    expect(list()).not.toBeNull();
    await u.keyboard("{Enter}");
    expect(box.value).toBe("/me winkt @alice ");
  });

  it("a command the user does not have is plain text: no mention list, Enter sends it as typed", async () => {
    const { box, u, onSend } = setup({ commands: { available: BUILTIN_COMMANDS.filter((d) => ["me", "shrug"].includes(d.name)), run: vi.fn(async () => {}) } });
    await u.type(box, "/kick @al");
    expect(list()).toBeNull();
    await u.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ body: "/kick @al" }));
  });

  it("without candidates the text box is no combobox (nothing to suggest)", () => {
    render(<Composer placeholder="Nachricht" onSend={vi.fn()} />);
    expect(screen.getByLabelText("Nachricht")).not.toHaveAttribute("role");
  });
});
