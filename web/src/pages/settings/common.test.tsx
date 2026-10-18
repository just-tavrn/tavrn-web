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

describe("OverrideTriState: channel-scoped bits only, inherited values", () => {
  it("lists only channel-scoped bits in five groups", () => {
    render(<OverrideTriState allow={0n} deny={0n} onChange={() => {}} />);
    expect(screen.getAllByRole("group")).toHaveLength(5);
    expect(screen.getByRole("radiogroup", { name: "Channel ansehen" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Rollen verwalten" })).toBeInTheDocument();
    for (const roomWide of ["Mitglieder bannen", "Administrator", "Raum verwalten"]) expect(screen.queryByRole("radiogroup", { name: roomWide })).toBeNull();
  });

  it("shows the inherited value in grey and as the accessible description", () => {
    const inherited = (bit: bigint) => (bit === Permission.SEND_MESSAGES ? { allowed: false, source: "category" as const } : { allowed: true, source: "role" as const });
    render(<OverrideTriState allow={0n} deny={0n} onChange={() => {}} inherited={inherited} />);
    expect(screen.getByTestId("inherited-SEND_MESSAGES")).toHaveTextContent("Geerbt: von der Kategorie verboten");
    expect(screen.getByTestId("inherited-SEND_MESSAGES")).toHaveClass("text-fg-2");
    expect(screen.getByRole("radio", { name: "Nachrichten senden: neutral" })).toHaveAccessibleDescription("Geerbt: von der Kategorie verboten");
    expect(screen.getByRole("radiogroup", { name: "Channel ansehen" })).toHaveAccessibleDescription("Geerbt: von den Rollen erlaubt");
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

  it("shows the confirmation word exactly as it must be typed (entities and markup stay text)", async () => {
    const word = "Tom &amp; <b>Jerry</b>";
    render(<ConfirmDialog open title="Löschen" text="Wirklich?" confirmWord={word} actionLabel="Löschen" onConfirm={() => {}} onClose={() => {}} />);
    const strong = screen.getByText(word, { selector: "strong" });
    expect(strong.querySelector("b")).toBeNull();
    const u = userEvent.setup();
    await u.type(screen.getByLabelText("Bestätigung"), word);
    expect(screen.getByRole("button", { name: "Löschen" })).toBeEnabled();
  });
});

describe("PermissionCheckboxes: phase 4E bits", () => {
  it("shows the whiteboard and webhook permissions with localized labels", () => {
    render(<PermissionCheckboxes value={0n} onChange={() => {}} />);
    for (const label of ["Whiteboard benutzen", "Whiteboards verwalten", "Webhooks verwalten"]) expect(screen.getByLabelText(label)).toBeInTheDocument();
  });
});

it("offers whisper initiation in both Voice permission editors independently of speaking", async () => {
  const whisper = 1n << 41n;
  const onChange = vi.fn();
  const view = render(<PermissionCheckboxes value={Permission.SPEAK} onChange={onChange} />);
  const box = screen.getByRole("checkbox", { name: /^Flüstern beginnen/ });
  expect(box.closest("fieldset")?.querySelector("legend")).toHaveTextContent("Sprache");
  await userEvent.click(box);
  expect(onChange).toHaveBeenCalledWith(Permission.SPEAK | whisper);
  view.rerender(<OverrideTriState allow={Permission.SPEAK} deny={0n} onChange={onChange} />);
  await userEvent.click(screen.getByRole("radio", { name: "Flüstern beginnen: verbieten" }));
  expect(onChange).toHaveBeenLastCalledWith(Permission.SPEAK, whisper);
});
