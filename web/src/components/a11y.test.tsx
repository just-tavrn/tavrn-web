// SPDX-License-Identifier: Apache-2.0
// Accessibility behaviour of shared widgets (design note 4.14 item 4, docs/ACCESSIBILITY.md).
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { Message } from "@tavrn/sdk";
import { Dialog, ErrorText, Field, Input } from "./ui";
import { MessageList } from "./MessageList";
import { useAccessibility } from "../stores/accessibility";
import { tabListKeyDown } from "../lib/a11y";

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <Dialog title="Titel" open={open} onClose={() => setOpen(false)}>
        <input aria-label="first" />
        <button type="button">last</button>
      </Dialog>
    </>
  );
}

const base: Message = { id: "01A", conversation_id: "c1", author: "bob@t.local", author_id: "u2", device_id: "d1", encrypted: false, format: 1, epoch: null, content: { type: "text", body: "eins" }, reply_to_id: null, thread_id: null, mentions: [], mentions_everyone: false, created_at: new Date().toISOString(), edited_at: null, attachments: [], reactions: [], pinned: false };

describe("accessibility of shared widgets", () => {
  it("a dialog is labelled, keeps Tab inside, closes with Escape and returns the focus", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const opener = screen.getByRole("button", { name: "open" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Titel" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText("first")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "last" })).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("first")).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "last" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("with a dialog opened from a dialog only the inner one keeps the focus", async () => {
    const user = userEvent.setup();
    const close = () => {};
    render(
      <>
        <Dialog title="Außen" open onClose={close}>
          <button type="button">outer</button>
        </Dialog>
        <Dialog title="Innen" open onClose={close}>
          <button type="button">inner 1</button>
          <button type="button">inner 2</button>
        </Dialog>
      </>,
    );
    screen.getByRole("button", { name: "inner 1" }).focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "inner 2" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "inner 1" })).toHaveFocus();
  });

  it("a field is described by its hint and, while shown, by the form error", () => {
    const { rerender } = render(
      <Field label="Name" hint="Hinweis">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText("Name");
    expect(input).toHaveAccessibleDescription("Hinweis");
    expect(input).not.toHaveAttribute("aria-invalid");
    rerender(
      <>
        <Field label="Name" hint="Hinweis" errorId="err">
          <Input />
        </Field>
        <ErrorText id="err">Falsch</ErrorText>
      </>,
    );
    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription("Hinweis Falsch");
    expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
  });

  it("arrow keys move between tabs and activate them", () => {
    function Tabs() {
      const [tab, setTab] = useState("a");
      return (
        <div role="tablist" onKeyDown={tabListKeyDown}>
          {["a", "b", "c"].map((x) => (
            <button key={x} type="button" role="tab" aria-selected={tab === x} tabIndex={tab === x ? 0 : -1} onClick={() => setTab(x)}>
              {x}
            </button>
          ))}
        </div>
      );
    }
    render(<Tabs />);
    const [a, b, c] = screen.getAllByRole("tab");
    a!.focus();
    fireEvent.keyDown(a!, { key: "ArrowRight" });
    expect(b).toHaveFocus();
    expect(b).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(b!, { key: "End" });
    expect(c).toHaveFocus();
    fireEvent.keyDown(c!, { key: "ArrowRight" });
    expect(a).toHaveFocus();
  });

  it("the message list is a feed and announces new messages of others unless muted", () => {
    const { rerender } = render(<MessageList messages={[base]} currentUserId="u1" canManage={false} hasMore={false} />);
    const feed = screen.getByRole("feed");
    expect(feed.querySelector("article")).toHaveAttribute("aria-posinset", "1");
    expect(feed.querySelector("article")).toHaveAttribute("aria-setsize", "1");
    const announcer = screen.getByTestId("message-announcer");
    // The first page is not announced.
    expect(announcer).toHaveTextContent("");
    const next = { ...base, id: "01B", content: { type: "text", body: "zwei" } };
    rerender(<MessageList messages={[next, base]} currentUserId="u1" canManage={false} hasMore={false} />);
    expect(announcer).toHaveTextContent("Neue Nachricht von bob: zwei");
    // Own messages are not announced.
    const own = { ...base, id: "01C", author_id: "u1", author: "me@t.local", content: { type: "text", body: "drei" } };
    rerender(<MessageList messages={[own, next, base]} currentUserId="u1" canManage={false} hasMore={false} />);
    expect(announcer).toHaveTextContent("Neue Nachricht von bob: zwei");
    act(() => useAccessibility.getState().set({ announceMessages: false }));
    const muted = { ...base, id: "01D", content: { type: "text", body: "vier" } };
    rerender(<MessageList messages={[muted, own, next, base]} currentUserId="u1" canManage={false} hasMore={false} />);
    expect(announcer).not.toHaveTextContent("vier");
    act(() => useAccessibility.getState().set({ announceMessages: true }));
  });

  it("plaintext in an encrypted conversation is announced and shown as a text warning, never with its content", () => {
    const { rerender } = render(<MessageList encrypted messages={[base]} currentUserId="u1" canManage={false} hasMore={false} />);
    const forged = { ...base, id: "01E", device_id: null, content: { type: "text", body: "neue IBAN" } };
    rerender(<MessageList encrypted messages={[forged, base]} currentUserId="u1" canManage={false} hasMore={false} />);
    expect(screen.getByTestId("message-announcer")).toHaveTextContent("Neue Nachricht von bob: Nachricht nicht Ende-zu-Ende-verschlüsselt");
    expect(screen.getByTestId("message-announcer")).not.toHaveTextContent("IBAN");
    // The warning is text (not colour alone).
    for (const row of screen.getAllByTestId("message-unencrypted")) expect(row).toHaveTextContent("nicht Ende-zu-Ende-verschlüsselt");
  });

  it("the unknown-device warning is an alert with a named button", async () => {
    const { GhostWarning } = await import("./E2eeNotices");
    render(<GhostWarning ghosts={[{ identity: "x@t.local/01J9ZK3G5M8Q2W4E6R8T0Y2VD1", reason: "unattested", key: "K810" }]} acknowledged={false} onAcknowledge={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("x@t.local/01J9ZK3G5M8Q2W4E6R8T0Y2VD1");
    expect(screen.getByRole("button", { name: "Ich verstehe" })).toBeInTheDocument();
  });
});
