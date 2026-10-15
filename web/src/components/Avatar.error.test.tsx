// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MediaAvatar } from "./Avatar";

describe("MediaAvatar: failed images", () => {
  it("falls back to the still when the animated variant fails", () => {
    render(<MediaAvatar name="Alice" still="https://n.test/still.webp" animated="https://n.test/anim.webp" testId="av" />);
    const host = screen.getByTestId("av");
    fireEvent.pointerEnter(host, { pointerType: "mouse" });
    expect(screen.getByTestId("avatar-image")).toHaveAttribute("src", "https://n.test/anim.webp");
    fireEvent.error(screen.getByTestId("avatar-image"));
    expect(screen.getByTestId("avatar-image")).toHaveAttribute("src", "https://n.test/still.webp");
    fireEvent.pointerLeave(host);
    expect(screen.getByTestId("avatar-image")).toHaveAttribute("src", "https://n.test/still.webp");
  });

  it("shows a new image after an earlier one failed", () => {
    const { rerender } = render(<MediaAvatar name="Alice" still="https://n.test/old.webp" />);
    fireEvent.error(screen.getByTestId("avatar-image"));
    expect(screen.queryByTestId("avatar-image")).toBeNull();
    expect(screen.getByText("A")).toBeInTheDocument();
    rerender(<MediaAvatar name="Alice" still="https://n.test/new.webp" />);
    expect(screen.getByTestId("avatar-image")).toHaveAttribute("src", "https://n.test/new.webp");
  });
});
