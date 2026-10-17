// SPDX-License-Identifier: Apache-2.0
// Unsent text per conversation (docs/CLIENT.md "The composer"): kept in memory while the app runs, restored when the
// conversation is opened again, gone after sending and when the account ends.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import { DRAFT_DEBOUNCE_MS, clearDrafts, draftKey, getDraft } from "../composer/drafts";

afterEach(() => clearDrafts());

const KEY_A = draftKey("me@a.example", "a.example", "CHANNEL_A")!;
const KEY_B = draftKey("me@a.example", "a.example", "CHANNEL_B")!;
const KEY_THREAD = draftKey("me@a.example", "a.example", "CHANNEL_A", "THREAD_1")!;
const box = () => screen.getByLabelText("Nachricht") as HTMLTextAreaElement;

describe("Composer: drafts", () => {
  it("switching away and back restores the text with the caret at its end", async () => {
    const u = userEvent.setup();
    const first = render(<Composer placeholder="Nachricht" onSend={vi.fn()} draftKey={KEY_A} />);
    await u.type(box(), "halb fertig");
    // Leaving the conversation (another channel, the settings) unmounts the composer: written at once.
    first.unmount();
    expect(getDraft(KEY_A)?.text).toBe("halb fertig");
    render(<Composer placeholder="Nachricht" onSend={vi.fn()} draftKey={KEY_A} />);
    expect(box()).toHaveValue("halb fertig");
    expect([box().selectionStart, box().selectionEnd]).toEqual([11, 11]);
  });

  it("is written while typing (debounced) and kept per conversation and per thread", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const u = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const view = render(<Composer placeholder="Nachricht" onSend={vi.fn()} draftKey={KEY_A} />);
      await u.type(box(), "im Kanal");
      act(() => vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS + 10));
      expect(getDraft(KEY_A)?.text).toBe("im Kanal");
      // Another conversation in the same composer: its own (empty) box; the channel's text stays.
      view.rerender(<Composer placeholder="Nachricht" onSend={vi.fn()} draftKey={KEY_THREAD} />);
      expect(box()).toHaveValue("");
      await u.type(box(), "im Thread");
      view.rerender(<Composer placeholder="Nachricht" onSend={vi.fn()} draftKey={KEY_B} />);
      expect(box()).toHaveValue("");
      view.rerender(<Composer placeholder="Nachricht" onSend={vi.fn()} draftKey={KEY_A} />);
      expect(box()).toHaveValue("im Kanal");
      view.rerender(<Composer placeholder="Nachricht" onSend={vi.fn()} draftKey={KEY_THREAD} />);
      expect(box()).toHaveValue("im Thread");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a successful send clears the draft; a failed one keeps it", async () => {
    const u = userEvent.setup();
    let fail = true;
    const onSend = vi.fn(async () => {
      if (fail) throw new Error("offline");
    });
    const first = render(<Composer placeholder="Nachricht" onSend={onSend} draftKey={KEY_A} />);
    await u.type(box(), "nachricht{Enter}");
    first.unmount();
    expect(getDraft(KEY_A)?.text).toBe("nachricht");
    fail = false;
    const second = render(<Composer placeholder="Nachricht" onSend={onSend} draftKey={KEY_A} />);
    expect(box()).toHaveValue("nachricht");
    box().focus();
    await u.keyboard("{Enter}");
    expect(onSend).toHaveBeenLastCalledWith(expect.objectContaining({ body: "nachricht" }));
    expect(getDraft(KEY_A)).toBeUndefined();
    second.unmount();
    expect(getDraft(KEY_A)).toBeUndefined();
  });

  it("signing out (or the app locking) clears every draft, also of a composer still open", async () => {
    const u = userEvent.setup();
    const view = render(<Composer placeholder="Nachricht" onSend={vi.fn()} draftKey={KEY_A} />);
    await u.type(box(), "geheim");
    clearDrafts();
    view.unmount();
    expect(getDraft(KEY_A)).toBeUndefined();
    render(<Composer placeholder="Nachricht" onSend={vi.fn()} draftKey={KEY_A} />);
    expect(box()).toHaveValue("");
  });

  it("without a key nothing is kept", async () => {
    const u = userEvent.setup();
    const view = render(<Composer placeholder="Nachricht" onSend={vi.fn()} />);
    await u.type(box(), "flüchtig");
    view.unmount();
    render(<Composer placeholder="Nachricht" onSend={vi.fn()} />);
    expect(box()).toHaveValue("");
  });
});
