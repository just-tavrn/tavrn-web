// SPDX-License-Identifier: Apache-2.0
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Message } from "@tavrn/sdk";
import { AppShell } from "./AppShell";
import { MessageList } from "./MessageList";

describe("AppShell (responsive)", () => {

  it("opens and closes the navigation with the toggle", async () => {
    const user = userEvent.setup();
    render(<AppShell sidebar={<span>Channelliste</span>}>Inhalt</AppShell>);
    const drawer = screen.getByTestId("nav-drawer");
    expect(drawer).toHaveAttribute("data-open", "false");
    await user.click(screen.getByRole("button", { name: "Navigation öffnen" }));
    expect(drawer).toHaveAttribute("data-open", "true");
    expect(screen.getByRole("button", { name: "Navigation öffnen" })).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "Drawer schließen" }));
    expect(drawer).toHaveAttribute("data-open", "false");
  });

  it("opens the member list as a drawer", async () => {
    const user = userEvent.setup();
    render(<AppShell aside={<span>Mitglied A</span>}>Inhalt</AppShell>);
    await user.click(screen.getByRole("button", { name: "Mitglieder öffnen" }));
    expect(screen.getByTestId("members-drawer")).toHaveAttribute("data-open", "true");
    expect(screen.getByText("Mitglied A")).toBeInTheDocument();
  });

  it("has touch targets of at least 44px for the drawer toggles", () => {
    render(<AppShell aside={<span>Mitglied A</span>}>Inhalt</AppShell>);
    for (const name of ["Navigation öffnen", "Mitglieder öffnen"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("min-h-11", "min-w-11");
    }
  });

  it("pages without a member list (friends, discover, settings) get the full width and no member toggle", () => {
    const { unmount } = render(<AppShell aside={null}>Inhalt</AppShell>);
    expect(screen.queryByRole("button", { name: "Mitglieder öffnen" })).not.toBeInTheDocument();
    // The drawer element stays (hidden) so helpers can still read its state; the desktop grid drops its column.
    expect(screen.getByTestId("members-drawer")).toHaveClass("hidden");
    expect(screen.getByTestId("app-shell").className).toContain("xl:grid-cols-[72px_240px_1fr]");
    expect(screen.getByTestId("app-shell").className).not.toContain("1fr_240px");
    unmount();
    render(<AppShell aside={<span>Mitglied A</span>}>Inhalt</AppShell>);
    expect(screen.getByTestId("members-drawer")).not.toHaveClass("hidden");
    expect(screen.getByTestId("app-shell").className).toContain("xl:grid-cols-[72px_240px_1fr_240px]");
  });
});

describe("AppShell (no text selection on the chrome, tavrn-web#186)", () => {
  it("the rail, the sidebar, the member list and the top bar are not selectable; the message list is", () => {
    const message: Message = { id: "m1", conversation_id: "c1", author: "alice@t.local", author_id: "u1", device_id: "d1", encrypted: false, format: 1, epoch: null, content: { type: "text", body: "Kopier mich" }, reply_to_id: null, thread_id: null, mentions: [], mentions_everyone: false, created_at: new Date().toISOString(), edited_at: null, attachments: [], reactions: [], pinned: false };
    render(
      <AppShell rail={<span>Räume</span>} sidebar={<span>Channelliste</span>} aside={<span>Mitglied A</span>}>
        <MessageList messages={[message]} currentUserId="u2" canManage={false} hasMore={false} />
      </AppShell>,
    );
    expect(screen.getByRole("navigation", { name: "Räume" })).toHaveClass("select-none");
    expect(screen.getByRole("complementary", { name: "Channels" })).toHaveClass("select-none");
    expect(screen.getByTestId("members-drawer")).toHaveClass("select-none");
    expect(screen.getByTestId("nav-toggle").parentElement).toHaveClass("select-none");
    expect(screen.getByTestId("message-list").closest(".select-none")).toBeNull();
    expect(screen.getByText("Kopier mich").closest(".select-none")).toBeNull();
    expect(screen.getByRole("main")).not.toHaveClass("select-none");
  });
});
