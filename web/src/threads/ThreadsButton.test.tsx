// SPDX-License-Identifier: Apache-2.0
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Channel } from "@tavrn/sdk";
import { renderWithProviders } from "../test/render";

vi.mock("../components/NodeScope", () => ({
  useNode: () => ({ domain: "n.test", api: { threads: { list: async () => ({ items: [], next_cursor: null }) } } }),
}));
const { ThreadsButton } = await import("./ThreadsButton");

const channel = { id: "C1", room_id: "R1", kind: "text", name: "general" } as unknown as Channel;

describe("ThreadsButton", () => {
  it("Escape closes the thread list and gives the focus back to its button; a press outside closes it", async () => {
    const u = userEvent.setup();
    renderWithProviders(
      <>
        <ThreadsButton channel={channel} onOpen={() => {}} onNew={() => {}} />
        <p>elsewhere</p>
      </>,
    );
    const button = screen.getByTestId("threads-button");
    await u.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    await u.click(await screen.findByTestId("threads-new"));
    // "New thread" closes the list; open it again and leave it with Escape from inside.
    await u.click(button);
    screen.getByTestId("threads-new").focus();
    await u.keyboard("{Escape}");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
    await u.click(button);
    fireEvent.pointerDown(screen.getByText("elsewhere"));
    expect(button).toHaveAttribute("aria-expanded", "false");
  });
});
