// SPDX-License-Identifier: Apache-2.0
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PollComposer } from "./PollComposer";
import { todayLocal } from "./Calendar";

const NOW = Date.parse("2026-10-14T10:00:00Z");

describe("PollComposer", () => {
  it("validates before sending and names the problems", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<PollComposer open onClose={() => {}} onCreate={onCreate} now={() => NOW} />);
    expect(screen.getByRole("dialog", { name: "Umfrage erstellen" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Umfrage erstellen" }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Bitte prüfe die markierten Felder.");
    expect(screen.getByLabelText("Frage")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Frage")).toHaveAccessibleDescription("Gib eine Frage ein.");
    expect(screen.getAllByText("Gib einen Text für diese Antwort ein oder entferne sie.")).toHaveLength(2);
  });

  it("creates a multiple-choice poll; options are added with Enter, moved with Alt+arrows and removed", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<PollComposer open question="Wohin?" onClose={onClose} onCreate={onCreate} now={() => NOW} />);
    expect(screen.getByLabelText("Frage")).toHaveValue("Wohin?");
    await user.type(screen.getByLabelText("Antwort 1"), "Küche{Enter}");
    expect(screen.getAllByTestId("poll-option")).toHaveLength(3);
    expect(screen.getByLabelText("Antwort 2")).toHaveFocus();
    await user.type(screen.getByLabelText("Antwort 2"), "Garten");
    await user.type(screen.getByLabelText("Antwort 3"), "Keller");
    screen.getByLabelText("Antwort 3").focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(screen.getAllByTestId("poll-option").map((x) => (x as HTMLInputElement).value)).toEqual(["Küche", "Keller", "Garten"]);
    expect(screen.getByRole("button", { name: "Antwort 1 nach oben verschieben" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Mehrere Antworten erlauben" }));
    await user.selectOptions(screen.getByTestId("poll-max-choices"), "2");
    await user.selectOptions(screen.getByLabelText("Ergebnisse zeigen"), "after_vote");
    await user.click(screen.getByRole("radio", { name: "1 Tag" }));
    await user.click(screen.getByRole("button", { name: "Umfrage erstellen" }));
    expect(onCreate).toHaveBeenCalledWith(
      { type: "poll", kind: "choice", question: "Wohin?", options: [{ id: "o1", label: "Küche" }, { id: "o2", label: "Keller" }, { id: "o3", label: "Garten" }], max_choices: 2, results_visible: "after_vote", votes_visible: "public" },
      new Date(NOW + 86_400_000).toISOString(),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps at least two options and at most twenty", async () => {
    const user = userEvent.setup();
    render(<PollComposer open onClose={() => {}} onCreate={vi.fn()} now={() => NOW} />);
    expect(screen.getByRole("button", { name: "Antwort 1 entfernen" })).toBeDisabled();
    for (let i = 0; i < 18; i++) await user.click(screen.getByRole("button", { name: /Antwort hinzufügen/ }));
    expect(screen.getAllByTestId("poll-option")).toHaveLength(20);
    expect(screen.getByRole("button", { name: /Antwort hinzufügen/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Antwort 20 entfernen" }));
    expect(screen.getAllByTestId("poll-option")).toHaveLength(19);
  });

  it("creates a date poll from calendar days, all day or with times, in the creator's zone", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<PollComposer open kind="date" onClose={() => {}} onCreate={onCreate} now={() => NOW} />);
    expect(screen.getByRole("radio", { name: /Terminumfrage/ })).toBeChecked();
    await user.type(screen.getByLabelText("Frage"), "Teamessen");
    await user.click(screen.getByRole("button", { name: "Nächster Monat" }));
    await user.click(screen.getByRole("gridcell", { name: "Freitag, 6. November 2026" }));
    await user.click(screen.getByRole("gridcell", { name: "Samstag, 7. November 2026" }));
    expect(screen.getByTestId("poll-zone")).toHaveTextContent("2 von 60 Terminen");
    const friday = screen.getAllByTestId("poll-day")[0]!;
    await user.click(within(friday).getByRole("checkbox", { name: "Ganztägig" }));
    const start = within(friday).getByLabelText(/Beginn von Zeit 1/);
    await user.clear(start);
    await user.type(start, "19:00");
    await user.type(within(friday).getByLabelText(/Ende von Zeit 1/), "22:00");
    await user.click(within(friday).getByRole("button", { name: /Zeit hinzufügen/ }));
    expect(screen.getByTestId("poll-zone")).toHaveTextContent("3 von 60 Terminen");
    await user.click(screen.getByRole("button", { name: "Umfrage erstellen" }));
    const [content, closes] = onCreate.mock.calls[0]!;
    expect(closes).toBeNull();
    expect(content.kind).toBe("date");
    expect(content.slots).toHaveLength(3);
    const off = (d: string, t: string) => {
      const m = -new Date(`${d}T${t}:00`).getTimezoneOffset();
      return `${m < 0 ? "-" : "+"}${String(Math.floor(Math.abs(m) / 60)).padStart(2, "0")}:${String(Math.abs(m) % 60).padStart(2, "0")}`;
    };
    expect(content.slots[0]).toEqual({ id: "s1", start: `2026-11-06T19:00:00${off("2026-11-06", "19:00")}`, end: `2026-11-06T22:00:00${off("2026-11-06", "22:00")}` });
    expect(content.slots[1]).toEqual({ id: "s2", start: `2026-11-06T20:00:00${off("2026-11-06", "20:00")}` });
    expect(content.slots[2]).toMatchObject({ id: "s3", all_day: true });
    expect(content.slots[2].start.startsWith("2026-11-07T00:00:00")).toBe(true);
  });

  it("refuses a day without times and an end before the start", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<PollComposer open kind="date" onClose={() => {}} onCreate={onCreate} now={() => NOW} />);
    await user.type(screen.getByLabelText("Frage"), "Wann?");
    await user.click(screen.getByRole("button", { name: "Umfrage erstellen" }));
    expect(screen.getByText("Wähle im Kalender mindestens einen Tag aus.")).toBeInTheDocument();
    expect(todayLocal(NOW) < "2026-10-20").toBe(true);
    await user.click(screen.getByRole("gridcell", { name: "Dienstag, 20. Oktober 2026" }));
    const d = screen.getByTestId("poll-day");
    await user.click(within(d).getByRole("checkbox", { name: "Ganztägig" }));
    await user.type(within(d).getByLabelText(/Ende von Zeit 1/), "08:00");
    await user.click(screen.getByRole("button", { name: "Umfrage erstellen" }));
    expect(screen.getByText("Das Ende muss nach dem Beginn liegen.")).toBeInTheDocument();
    await user.click(within(d).getByRole("button", { name: /Zeit 1 am .* entfernen/ }));
    expect(screen.getByText("Jeder Tag braucht eine Zeit oder „Ganztägig“.")).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("keeps the dialog open with the error when sending fails", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<PollComposer open question="Q" onClose={onClose} onCreate={vi.fn().mockRejectedValue(new Error("Du kannst hier keine Umfragen erstellen."))} now={() => NOW} />);
    await user.type(screen.getByLabelText("Antwort 1"), "A");
    await user.type(screen.getByLabelText("Antwort 2"), "B");
    await user.click(screen.getByRole("button", { name: "Umfrage erstellen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Du kannst hier keine Umfragen erstellen.");
    expect(onClose).not.toHaveBeenCalled();
  });
});
