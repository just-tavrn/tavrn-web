// SPDX-License-Identifier: Apache-2.0
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmHost, confirmDialog } from "./Confirm";
import { Dialog } from "./ui";

describe("confirmDialog", () => {
  it("asks in the app's dialog: Cancel has the focus, the button confirms", async () => {
    const u = userEvent.setup();
    render(<ConfirmHost />);
    let answer!: Promise<boolean>;
    act(() => {
      answer = confirmDialog({ title: "Delete message", text: "Delete this message permanently?", confirmLabel: "Delete", danger: true });
    });
    expect(screen.getByRole("dialog", { name: "Delete message" })).toBeInTheDocument();
    expect(screen.getByTestId("confirm-text")).toHaveTextContent("Delete this message permanently?");
    expect(screen.getByTestId("confirm-cancel")).toHaveFocus();
    await u.click(screen.getByRole("button", { name: "Delete" }));
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Cancel, Escape and a newer question answer false", async () => {
    const u = userEvent.setup();
    render(<ConfirmHost />);
    let first!: Promise<boolean>;
    act(() => void (first = confirmDialog({ text: "One?" })));
    // The default heading and button of the host.
    expect(screen.getByRole("dialog", { name: "Bist du sicher?" })).toBeInTheDocument();
    expect(screen.getByTestId("confirm-ok")).toHaveTextContent("Bestätigen");
    let second!: Promise<boolean>;
    act(() => void (second = confirmDialog({ text: "Two?" })));
    await expect(first).resolves.toBe(false);
    await u.keyboard("{Escape}");
    await expect(second).resolves.toBe(false);
    let third!: Promise<boolean>;
    act(() => void (third = confirmDialog({ text: "Three?" })));
    await u.click(screen.getByTestId("confirm-cancel"));
    await expect(third).resolves.toBe(false);
  });

  it("confirms nothing without a mounted host", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(confirmDialog({ text: "Anyone?" })).resolves.toBe(false);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("Escape over another dialog closes only the confirmation", async () => {
    const u = userEvent.setup();
    const outerClosed = vi.fn();
    function Outer() {
      const [answer, setAnswer] = useState<string>("none");
      return (
        <Dialog title="Form" open onClose={outerClosed}>
          <button type="button" onClick={() => void confirmDialog({ text: "Discard?" }).then((yes) => setAnswer(String(yes)))}>
            ask
          </button>
          <span data-testid="answer">{answer}</span>
        </Dialog>
      );
    }
    render(
      <>
        <Outer />
        <ConfirmHost />
      </>,
    );
    await u.click(screen.getByRole("button", { name: "ask" }));
    expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    await u.keyboard("{Escape}");
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("answer")).toHaveTextContent("false");
    expect(outerClosed).not.toHaveBeenCalled();
    // Without the confirmation on top, Escape closes the form again.
    await u.keyboard("{Escape}");
    expect(outerClosed).toHaveBeenCalledTimes(1);
  });
});
