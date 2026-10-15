// SPDX-License-Identifier: Apache-2.0
// Text selection in dialogs (tavrn-web#186): the title bar is chrome, the body stays selectable even when the dialog is
// rendered inside a non-selectable container (the channel sidebar's dialogs are).
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dialog } from "./ui";

describe("Dialog text selection", () => {
  it("has a non-selectable title and a selectable body", () => {
    render(
      <div className="select-none">
        <Dialog title="Einladen" open onClose={() => undefined}>
          <p>https://node.example/invite/abc</p>
        </Dialog>
      </div>,
    );
    expect(screen.getByRole("heading", { name: "Einladen" })).toHaveClass("select-none");
    expect(screen.getByRole("dialog")).toHaveClass("select-text");
  });
});
