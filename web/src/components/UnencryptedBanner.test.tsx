// SPDX-License-Identifier: Apache-2.0
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UnencryptedBanner } from "./UnencryptedBanner";

describe("UnencryptedBanner", () => {
  it("names the operator and is marked as a status (protocol section 8)", () => {
    render(<UnencryptedBanner domain="node.example" />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("nicht Ende-zu-Ende-verschlüsselt");
    expect(banner).toHaveTextContent("Betreiber von node.example kann mitlesen");
  });
});
