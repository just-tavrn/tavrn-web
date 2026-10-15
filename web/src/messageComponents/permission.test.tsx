// SPDX-License-Identifier: Apache-2.0
// Bit 40 `use_components` (tavrn-protocol/permissions.md) in the role editor and the channel override editor.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Permission } from "@tavrn/sdk";
import { OverrideTriState, PermissionCheckboxes } from "../pages/settings/common";

describe("use_components in the permission editors", () => {
  it("the role editor lists it with its label and hint and toggles bit 40", async () => {
    const onChange = vi.fn();
    render(<PermissionCheckboxes value={0n} onChange={onChange} />);
    const box = screen.getByRole("checkbox", { name: /Knöpfe und Menüs von Anwendungen benutzen/ });
    expect(screen.getByTestId("perm-hint-USE_COMPONENTS").textContent).toContain("Formulare");
    await userEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(1n << 40n);
    expect(Permission.USE_COMPONENTS).toBe(1n << 40n);
  });

  it("the channel override editor offers it in the text group", () => {
    render(<OverrideTriState allow={0n} deny={Permission.USE_COMPONENTS} onChange={() => undefined} />);
    const text = screen.getByTestId("override-tristate").querySelector<HTMLElement>('fieldset[data-group="text"]')!;
    expect(within(text).getByText("Knöpfe und Menüs von Anwendungen benutzen")).toBeTruthy();
  });
});
