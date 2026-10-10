// SPDX-License-Identifier: Apache-2.0
/** Toasts with an action ("show in folder" after a download in the desktop app). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { Toaster } from "./Toaster";
import { useToasts } from "../stores/toasts";

afterEach(() => useToasts.setState({ toasts: [] }));

describe("Toaster", () => {
  it("offers a toast's action as a keyboard-reachable button inside the live region and dismisses the toast", async () => {
    const run = vi.fn();
    render(
      <MemoryRouter>
        <Toaster />
      </MemoryRouter>,
    );
    useToasts.getState().push({ kind: "info", title: "Gespeichert in Downloads", detail: "plan.pdf", testId: "download-saved", action: { label: "Im Ordner zeigen", run } });
    const toast = await screen.findByTestId("download-saved");
    expect(toast).toHaveAttribute("role", "status");
    expect(toast.closest("[aria-live]")).not.toBeNull();
    const button = screen.getByRole("button", { name: "Im Ordner zeigen" });
    const user = userEvent.setup();
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(run).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("download-saved")).toBeNull();
  });
});
