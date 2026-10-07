// SPDX-License-Identifier: Apache-2.0
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Permission } from "@tavrn/sdk";
import { ConfirmDialog, OverrideTriState, PermissionCheckboxes, overrideStateOf } from "./common";

describe("PermissionCheckboxes", () => {
  it("sets and clears bits and disables permissions outside the limit", async () => {
    const onChange = vi.fn();
    render(<PermissionCheckboxes value={Permission.VIEW_CHANNEL} onChange={onChange} limit={Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES} />);
    const u = userEvent.setup();
    await u.click(screen.getByLabelText("Nachrichten senden"));
    expect(onChange).toHaveBeenCalledWith(Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES);
    await u.click(screen.getByLabelText("Channel ansehen"));
    expect(onChange).toHaveBeenCalledWith(0n);
    expect(screen.getByLabelText("Mitglieder bannen")).toBeDisabled();
  });
});

describe("OverrideTriState", () => {
  it("switches between allow, neutral and deny", async () => {
    const onChange = vi.fn();
    render(<OverrideTriState allow={0n} deny={Permission.SEND_MESSAGES} onChange={onChange} />);
    expect(overrideStateOf(0n, Permission.SEND_MESSAGES, Permission.SEND_MESSAGES)).toBe("deny");
    expect(screen.getByRole("radio", { name: "Nachrichten senden: verbieten" })).toHaveAttribute("aria-checked", "true");
    const u = userEvent.setup();
    await u.click(screen.getByRole("radio", { name: "Nachrichten senden: erlauben" }));
    expect(onChange).toHaveBeenCalledWith(Permission.SEND_MESSAGES, 0n);
    await u.click(screen.getByRole("radio", { name: "Nachrichten senden: neutral" }));
    expect(onChange).toHaveBeenCalledWith(0n, 0n);
    await u.click(screen.getByRole("radio", { name: "Channel ansehen: verbieten" }));
    expect(onChange).toHaveBeenCalledWith(0n, Permission.SEND_MESSAGES | Permission.VIEW_CHANNEL);
  });
});

describe("ConfirmDialog", () => {
  it("enables the action only after the confirmation word", async () => {
    const onConfirm = vi.fn(async () => {});
    render(<ConfirmDialog open title="Löschen" text="Wirklich?" confirmWord="Gilde" actionLabel="Löschen" onConfirm={onConfirm} onClose={() => {}} />);
    const u = userEvent.setup();
    const button = screen.getByRole("button", { name: "Löschen" });
    expect(button).toBeDisabled();
    await u.type(screen.getByLabelText("Bestätigung"), "Gilde");
    expect(button).toBeEnabled();
    await u.click(button);
    expect(onConfirm).toHaveBeenCalled();
  });
});

describe("PermissionCheckboxes: phase 4E bits", () => {
  it("shows the whiteboard and webhook permissions with localized labels", () => {
    render(<PermissionCheckboxes value={0n} onChange={() => {}} />);
    for (const label of ["Whiteboard benutzen", "Whiteboards verwalten", "Webhooks verwalten"]) expect(screen.getByLabelText(label)).toBeInTheDocument();
  });
});
