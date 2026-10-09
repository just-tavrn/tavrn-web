// SPDX-License-Identifier: Apache-2.0
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LockMark } from "./Badges";

describe("LockMark", () => {
  it("is an SVG lock named “Verschlüsselt” with the explanation as its tooltip", () => {
    render(<LockMark size={18} title="Ende-zu-Ende-verschlüsselt: Der Knoten kann den Inhalt nicht lesen." testId="encrypted-marker" />);
    const mark = screen.getByTestId("encrypted-marker");
    expect(mark).toHaveAttribute("role", "img");
    expect(mark).toHaveAccessibleName("Verschlüsselt");
    expect(mark).toHaveAttribute("title", "Ende-zu-Ende-verschlüsselt: Der Knoten kann den Inhalt nicht lesen.");
    expect(mark.querySelector("svg")).toHaveAttribute("width", "18");
    expect(mark.textContent).toBe("");
  });

  it("the open variant is named “Unverschlüsselt”", () => {
    render(<LockMark open size={16} testId="channel-unlocked" />);
    expect(screen.getByTestId("channel-unlocked")).toHaveAccessibleName("Unverschlüsselt");
    expect(screen.getByTestId("channel-unlocked")).toHaveAttribute("title", "Unverschlüsselt");
  });
});
