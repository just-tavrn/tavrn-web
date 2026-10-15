// SPDX-License-Identifier: Apache-2.0
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComponentModal, inputError } from "./ComponentModal";
import type { Modal } from "./types";

const MODAL: Modal = {
  custom_id: "note",
  title: "Raid note",
  inputs: [
    { custom_id: "name", label: "Character", style: "short", min_length: 3, max_length: 12 },
    { custom_id: "text", label: "Note", style: "paragraph", required: false, placeholder: "Anything else?", value: "Late by 5" },
  ],
};

const apiError = (code: string, status: number, meta?: Record<string, unknown>) => Object.assign(new Error(code), { name: "TavrnApiError", code, status, problem: { code, status, detail: "", title: "", meta } });

function open(onSubmit = vi.fn(async () => undefined), onClose = vi.fn()) {
  render(<ComponentModal modal={MODAL} appName="Raid Bot" onSubmit={onSubmit} onClose={onClose} />);
  return { onSubmit, onClose, dialog: screen.getByRole("dialog", { name: "Raid note" }) };
}

describe("component modal (APPLICATIONS.md §5.10)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is a labelled dialog with labelled inputs, the prefilled value and the first field focused", () => {
    const { dialog } = open();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const name = within(dialog).getByLabelText(/Character/);
    const note = within(dialog).getByLabelText(/Note/);
    expect(name.tagName).toBe("INPUT");
    expect(note.tagName).toBe("TEXTAREA");
    expect(note).toHaveValue("Late by 5");
    expect(note).toHaveAttribute("placeholder", "Anything else?");
    expect(name).toHaveAttribute("maxLength", "12");
    expect(name).toHaveFocus();
    expect(within(dialog).getByText(/Raid Bot/)).toBeTruthy();
  });

  it("checks required, min and max length before sending and describes the errors at their fields", async () => {
    const { onSubmit, dialog } = open();
    await userEvent.click(within(dialog).getByTestId("component-modal-submit"));
    const name = within(dialog).getByLabelText(/Character/);
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription(/Füll dieses Feld aus/);
    expect(name).toHaveFocus();
    await userEvent.type(name, "Al");
    expect(name).toHaveAccessibleDescription(/Mindestens 3 Zeichen/);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(inputError({ custom_id: "x", label: "x", style: "short", max_length: 2 }, "abc")).toEqual({ key: "components.modal.too_long", vars: { max: 2 } });
    expect(inputError({ custom_id: "x", label: "x", style: "short", required: false }, "")).toBeNull();
  });

  it("sends every value, disables the submit button while pending and closes", async () => {
    let finish!: () => void;
    const onSubmit = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const { onClose, dialog } = open(onSubmit);
    await userEvent.type(within(dialog).getByLabelText(/Character/), "Aldara");
    await userEvent.click(within(dialog).getByTestId("component-modal-submit"));
    expect(onSubmit).toHaveBeenCalledWith({ name: "Aldara", text: "Late by 5" });
    expect(within(dialog).getByTestId("component-modal-submit")).toBeDisabled();
    expect(within(dialog).getByTestId("component-modal-submit")).toHaveAttribute("aria-busy", "true");
    finish();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it.each([
    ["interaction.expired", 410, /abgelaufen/],
    ["interaction.already_submitted", 409, /schon gesendet/],
    ["interaction.values_invalid", 400, /nimmt diese Werte nicht an/],
  ])("shows %s as an inline alert", async (code, status, text) => {
    const { dialog, onClose } = open(vi.fn(async () => Promise.reject(apiError(code, status, code === "interaction.values_invalid" ? { path: "values.name" } : undefined))));
    await userEvent.type(within(dialog).getByLabelText(/Character/), "Aldara");
    await userEvent.click(within(dialog).getByTestId("component-modal-submit"));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(text);
    expect(onClose).not.toHaveBeenCalled();
    if (code === "interaction.values_invalid") {
      expect(within(dialog).getByLabelText(/Character/)).toHaveAttribute("aria-invalid", "true");
      expect(within(dialog).getByTestId("component-modal-submit")).toBeEnabled();
    } else {
      // Expired or answered: the form cannot be sent again.
      expect(within(dialog).getByTestId("component-modal-submit")).toBeDisabled();
    }
  });

  it("Escape discards an untouched form at once and asks once something was typed", async () => {
    const { onClose, dialog } = open();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await userEvent.type(within(dialog).getByLabelText(/Character/), "x");
    await userEvent.keyboard("{Escape}");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    confirm.mockReturnValue(true);
    await userEvent.click(within(dialog).getByTestId("component-modal-cancel"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
