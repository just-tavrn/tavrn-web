// SPDX-License-Identifier: Apache-2.0
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Calendar, monthGrid } from "./Calendar";

function Harness({ min = "2026-10-14" }: { min?: string }) {
  const [days, setDays] = useState(new Set<string>());
  return (
    <>
      <Calendar selected={days} min={min} locale="de-DE" label="Hinweis" onToggle={(d) => setDays((s) => { const n = new Set(s); if (n.has(d)) n.delete(d); else n.add(d); return n; })} />
      <output data-testid="picked">{[...days].sort().join(",")}</output>
    </>
  );
}

describe("Calendar", () => {
  it("lays out a month from the locale's first weekday", () => {
    // October 2026 starts on a Thursday.
    expect(monthGrid("2026-10-14", 1)[0]).toEqual([null, null, null, "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(monthGrid("2026-10-14", 7)[0]).toEqual([null, null, null, null, "2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(monthGrid("2026-10-14", 1).flat().filter(Boolean)).toHaveLength(31);
  });

  it("is a multi-select grid with one tab stop; arrows, Home/End and Page Down move, Enter and Space toggle", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const grid = screen.getByRole("grid", { name: "Oktober 2026" });
    expect(grid).toHaveAttribute("aria-multiselectable", "true");
    expect(grid).toHaveAccessibleDescription("Hinweis");
    const today = screen.getByRole("gridcell", { name: "Mittwoch, 14. Oktober 2026" });
    expect(today).toHaveAttribute("tabindex", "0");
    expect(today).toHaveAttribute("aria-current", "date");
    expect(screen.getAllByRole("gridcell").filter((c) => c.getAttribute("tabindex") === "0")).toHaveLength(1);
    today.focus();
    await user.keyboard("{ArrowRight}{Enter}");
    expect(screen.getByRole("gridcell", { name: "Donnerstag, 15. Oktober 2026" })).toHaveFocus();
    await user.keyboard("{ArrowDown} ");
    expect(screen.getByTestId("picked")).toHaveTextContent("2026-10-15,2026-10-22");
    expect(screen.getByRole("gridcell", { name: "Donnerstag, 22. Oktober 2026" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(screen.getByRole("gridcell", { name: "Montag, 19. Oktober 2026" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("gridcell", { name: "Sonntag, 25. Oktober 2026" })).toHaveFocus();
    await user.keyboard("{PageDown}");
    expect(screen.getByRole("grid", { name: "November 2026" })).toBeInTheDocument();
    expect(screen.getByRole("gridcell", { name: "Mittwoch, 25. November 2026" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("picked")).toHaveTextContent("2026-10-15,2026-10-22,2026-11-25");
    // Deselect with a click.
    await user.click(screen.getByRole("gridcell", { name: "Mittwoch, 25. November 2026" }));
    expect(screen.getByTestId("picked")).toHaveTextContent("2026-10-15,2026-10-22");
  });

  it("past days cannot be picked and the view does not go before the first month", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const past = screen.getByRole("gridcell", { name: "Dienstag, 13. Oktober 2026" });
    expect(past).toHaveAttribute("aria-disabled", "true");
    await user.click(past);
    expect(screen.getByTestId("picked")).toHaveTextContent("");
    expect(screen.getByRole("button", { name: "Vorheriger Monat" })).toBeDisabled();
    screen.getByRole("gridcell", { name: "Mittwoch, 14. Oktober 2026" }).focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("gridcell", { name: "Mittwoch, 14. Oktober 2026" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Nächster Monat" }));
    expect(screen.getByRole("grid", { name: "November 2026" })).toBeInTheDocument();
  });
});
