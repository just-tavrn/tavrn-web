// SPDX-License-Identifier: Apache-2.0
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComponentModal, inputError } from "./ComponentModal";
import { ConfirmHost } from "../components/Confirm";
import type { Modal } from "@tavrn/sdk";

const MODAL: Modal = {
  custom_id: "note",
  title: "Raid note",
  inputs: [
    { custom_id: "name", label: "Character", style: "short", min_length: 3, max_length: 12 },
    { custom_id: "text", label: "Note", style: "paragraph", required: false, placeholder: "Anything else?", value: "Late by 5" },
  ],
};

const apiError = (code: string, status: number, meta?: Record<string, unknown>) => Object.assign(new Error(code), { name: "TavrnApiError", code, status, problem: { code, status, detail: "", title: "", meta } });

function open(onSubmit: (values: Record<string, string>) => Promise<void> = vi.fn(async () => undefined), onClose = vi.fn()) {
  render(
    <>
      <ComponentModal modal={MODAL} appName="Raid Bot" onSubmit={onSubmit} onClose={onClose} />
      <ConfirmHost />
    </>,
  );
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
    await userEvent.type(within(dialog).getByLabelText(/Character/), "x");
    await userEvent.keyboard("{Escape}");
    // The app's confirmation over the form; Escape there keeps the form (and closes only the question).
    expect(screen.getByTestId("confirm-text")).toHaveTextContent("Was du in dieses Formular geschrieben hast, verwerfen?");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByTestId("component-modal-cancel"));
    await userEvent.click(screen.getByTestId("confirm-ok"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

const SELECT_MODAL: Modal = {
  custom_id: "spec",
  title: "Choose a specialization",
  inputs: [
    { custom_id: "spec", label: "Specialization", style: "select", placeholder: "Your specialization", options: [
      { label: "Protection", value: "protection", emoji: "🛡️", description: "Tank" },
      { label: "Retribution", value: "retribution", description: "Damage" },
    ] },
    { custom_id: "backup", label: "Backup", style: "select", required: false, value: "healing", options: [{ label: "Healing", value: "healing" }] },
  ],
};

describe("select inputs in component modals", () => {
  it("renders labelled native selects, placeholders and a prefilled option", () => {
    render(<ComponentModal modal={SELECT_MODAL} appName="Raid Bot" onSubmit={vi.fn()} onClose={vi.fn()} />);
    const spec = screen.getByRole("combobox", { name: /Specialization/ });
    expect(spec).toHaveFocus();
    expect(spec).toBeRequired();
    expect(spec).toHaveValue("");
    expect(screen.getByRole("option", { name: "Your specialization" })).toBeDisabled();
    expect(screen.getByRole("option", { name: /Protection.*Tank/ })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Backup" })).toHaveValue("healing");
    expect(screen.queryByText("0/4000")).toBeNull();
  });

  it("requires a choice and submits only opaque scalar option values", async () => {
    const submitted = vi.fn(async () => undefined);
    render(<ComponentModal modal={SELECT_MODAL} appName="Raid Bot" onSubmit={submitted} onClose={vi.fn()} />);
    const spec = screen.getByRole("combobox", { name: /Specialization/ });
    await userEvent.click(screen.getByTestId("component-modal-submit"));
    expect(submitted).not.toHaveBeenCalled();
    expect(spec).toHaveFocus();
    expect(spec).toHaveAttribute("aria-invalid", "true");
    expect(spec).toHaveAccessibleDescription("Wähle eine Option aus.");
    await userEvent.selectOptions(spec, "retribution");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Backup" }), "");
    await userEvent.click(screen.getByTestId("component-modal-submit"));
    expect(submitted).toHaveBeenCalledWith({ spec: "retribution", backup: "" });
  });

  it("validates exact option membership and accepts whitespace tokens when offered", () => {
    const spec = SELECT_MODAL.inputs[0]!;
    expect(inputError(spec, "retribution")).toBeNull();
    expect(inputError(spec, "RETRIBUTION")).toEqual({ key: "components.modal.option_invalid" });
    expect(inputError(spec, " retribution ")).toEqual({ key: "components.modal.option_invalid" });
    expect(inputError(SELECT_MODAL.inputs[1]!, "")).toBeNull();
    const whitespace = { custom_id: "space", label: "Token", style: "select", options: [{ label: "Space", value: " " }] } satisfies Modal["inputs"][number];
    expect(inputError(whitespace, " ")).toBeNull();
  });

  it("asks before discarding a changed selection", async () => {
    const close = vi.fn();
    render(<><ComponentModal modal={SELECT_MODAL} appName="Raid Bot" onSubmit={vi.fn()} onClose={close} /><ConfirmHost /></>);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Specialization/ }), "protection");
    await userEvent.keyboard("{Escape}");
    expect(screen.getByTestId("confirm-text")).toBeVisible();
    expect(close).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("confirm-ok"));
    expect(close).toHaveBeenCalledOnce();
  });

  it("disables selects while sending and preserves the choice after a server rejection", async () => {
    let reject!: (error: Error) => void;
    const submitted = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    render(<ComponentModal modal={SELECT_MODAL} appName="Raid Bot" onSubmit={submitted} onClose={vi.fn()} />);
    const spec = screen.getByRole("combobox", { name: /Specialization/ });
    await userEvent.selectOptions(spec, "protection");
    await userEvent.click(screen.getByTestId("component-modal-submit"));
    expect(spec).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Backup" })).toBeDisabled();
    reject(apiError("interaction.values_invalid", 400, { path: "values.spec" }));
    await screen.findByRole("alert");
    expect(spec).toHaveValue("protection");
    expect(spec).toBeEnabled();
    expect(spec).toHaveAttribute("aria-invalid", "true");
  });
});
