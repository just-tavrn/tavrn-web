// SPDX-License-Identifier: Apache-2.0
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Member } from "@tavrn/sdk";
import type { MlsManager } from "@tavrn/e2ee";
import { BotReaders } from "./BotReaders";

const mls = (identities: string[]) => ({ roster: () => identities }) as unknown as MlsManager;
const members = [{ user: { address: "echo@x", display_name: "Echo" } }, { user: { address: "carol@x", display_name: "Carol" } }] as unknown as Member[];

describe("bots reading an encrypted channel (APPLICATIONS.md §3.6)", () => {
  it("counts the bots in this device's roster and names them", () => {
    render(<BotReaders mls={mls(["carol@x/d1", "echo@x/d1", "echo@x/d2", "relay@x/d1"])} conversation="x/c1" tick={0} bots={new Set(["echo@x", "relay@x", "absent@x"])} members={members} />);
    const mark = screen.getByRole("img", { name: "Bots, die diesen Channel mitlesen können: Echo, relay" });
    expect(mark).toHaveAttribute("data-count", "2");
    expect(mark).toHaveTextContent("2");
  });

  it("shows nothing without bots in the group or before the group is open", () => {
    const { container, rerender } = render(<BotReaders mls={mls(["carol@x/d1"])} conversation="x/c1" tick={0} bots={new Set(["echo@x"])} members={members} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<BotReaders mls={null} conversation="x/c1" tick={0} bots={new Set(["echo@x"])} members={members} />);
    expect(container).toBeEmptyDOMElement();
  });
});
