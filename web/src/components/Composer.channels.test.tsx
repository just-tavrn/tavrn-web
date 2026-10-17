// SPDX-License-Identifier: Apache-2.0
// The composer's #channel links (docs/CLIENT.md "The composer"): the list of the room's channels after `#` and a
// character, the link inserted on Enter, `#` elsewhere untouched, and both providers in one text box.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import type { ChannelCandidate } from "../composer/channels";
import type { MentionCandidate } from "../composer/mentions";

const channels: ChannelCandidate[] = [
  { key: "C1", insert: "https://n.example/rooms/R/channels/C1", name: "allgemein", kind: "text", category: "Textkanäle" },
  { key: "C2", insert: "https://n.example/rooms/R/channels/C2", name: "Sprache", kind: "voice", category: null },
  { key: "C3", insert: "https://n.example/rooms/R/channels/C3", name: "ablage", kind: "files", category: null },
];
const mentions: MentionCandidate[] = [{ kind: "user", key: "ann@n.example", insert: "@ann", name: "Ann", username: "ann", remote: null }];

function setup() {
  const onSend = vi.fn(async () => {});
  render(<Composer placeholder="Nachricht" onSend={onSend} channels={channels} mentions={mentions} />);
  return { onSend, box: screen.getByLabelText("Nachricht") as HTMLTextAreaElement, u: userEvent.setup() };
}
const list = () => screen.queryByRole("listbox", { name: "Kanäle zum Verlinken" });

describe("Composer: #channel links", () => {
  it("offers the room's channels after # and a character, with kind icon and category, and inserts the link", async () => {
    const { box, u, onSend } = setup();
    await u.type(box, "siehe #");
    expect(list()).toBeNull();
    await u.type(box, "a");
    const options = within(list()!).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("data-key"))).toEqual(["C1", "C3"]);
    expect(within(options[0]!).getByTestId("channel-kind-icon")).toHaveAttribute("data-icon", "text");
    expect(within(options[0]!).getByTestId("suggest-category")).toHaveTextContent("Textkanäle");
    expect(box).toHaveAttribute("aria-controls", list()!.id);
    expect(box.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    await u.keyboard("{ArrowDown}{Enter}");
    expect(box.value).toBe("siehe https://n.example/rooms/R/channels/C3 ");
    expect(list()).toBeNull();
    await u.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ body: "siehe https://n.example/rooms/R/channels/C3" }));
  });

  it("never takes over # elsewhere: headings, C#, #1, numbers", async () => {
    const { box, u, onSend } = setup();
    for (const text of ["# Titel", "C#", "Ticket #1", "## a"]) {
      await u.clear(box);
      await u.type(box, text);
      expect(list(), text).toBeNull();
    }
    await u.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ body: "## a" }));
  });

  it("Escape keeps the text; the nearest trigger wins when # and @ are both in the line", async () => {
    const { box, u } = setup();
    await u.type(box, "#all");
    await u.keyboard("{Escape}");
    expect(list()).toBeNull();
    expect(box.value).toBe("#all");
    await u.type(box, " @an");
    expect(screen.getByRole("listbox", { name: "Personen und Rollen zum Erwähnen" })).toBeInTheDocument();
    await u.keyboard("{Tab}");
    expect(box.value).toBe("#all @ann ");
  });

  it("without channels (DMs) # offers nothing", async () => {
    render(<Composer placeholder="Nachricht" onSend={vi.fn()} mentions={mentions} />);
    const u = userEvent.setup();
    await u.type(screen.getByLabelText("Nachricht"), "#a");
    expect(list()).toBeNull();
  });
});
