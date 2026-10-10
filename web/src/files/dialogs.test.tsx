// SPDX-License-Identifier: Apache-2.0
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NameDialog } from "./dialogs";

describe("NameDialog", () => {
  it("keeps the submit button disabled and says why while pending, then submits once the reason is gone", async () => {
    const onSubmit = vi.fn(async () => {});
    const view = render(<NameDialog open title="Neuer Ordner" initial="" action="Erstellen" onClose={() => {}} onSubmit={onSubmit} pending="Die Verschlüsselung ist noch nicht bereit." />);
    const u = userEvent.setup();
    await u.type(screen.getByTestId("files-name-input"), "Projekte");
    expect(screen.getByTestId("files-name-submit")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("noch nicht bereit");
    // Enter does nothing either.
    await u.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    view.rerender(<NameDialog open title="Neuer Ordner" initial="" action="Erstellen" onClose={() => {}} onSubmit={onSubmit} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("files-name-submit")).toBeEnabled();
    await u.click(screen.getByTestId("files-name-submit"));
    expect(onSubmit).toHaveBeenCalledWith("Projekte");
  });
});
