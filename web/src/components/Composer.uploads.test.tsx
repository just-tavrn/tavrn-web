// SPDX-License-Identifier: Apache-2.0
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Attachment } from "@tavrn/sdk";
import { Composer } from "./Composer";

const stored = (id: string) => ({ id, name: "a.txt", mime: "text/plain", size: 3 }) as Attachment;

describe("Composer: removing uploads", () => {
  it("aborts a running upload and tells the conversation about a finished one that is removed", async () => {
    const signals: AbortSignal[] = [];
    let finish: ((a: Attachment) => void) | null = null;
    const onUpload = vi.fn((_f: File, _p: (n: number) => void, signal?: AbortSignal) => {
      signals.push(signal!);
      return signals.length === 1 ? new Promise<Attachment>((r) => (finish = r)) : Promise.resolve(stored("b2"));
    });
    const u = userEvent.setup();
    render(<Composer placeholder="Nachricht" onSend={vi.fn()} canAttach onUpload={onUpload} uploadLimitBytes={1000} />);
    const input = screen.getByLabelText("Datei auswählen") as HTMLInputElement;
    await u.upload(input, new File(["abc"], "a.txt", { type: "text/plain" }));
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
    expect(signals[0]!.aborted).toBe(false);
    await u.click(screen.getByRole("button", { name: "a.txt entfernen" }));
    expect(signals[0]!.aborted).toBe(true);
    expect(screen.queryByTestId("pending-uploads")).toBeNull();
    // A late answer changes nothing.
    finish!(stored("b1"));
    await u.upload(input, new File(["def"], "b.txt", { type: "text/plain" }));
    await waitFor(() => expect(screen.getByTestId("pending-uploads")).toHaveTextContent("3 B"));
    expect(screen.getByTestId("pending-uploads")).not.toHaveTextContent("a.txt");
    await u.click(screen.getByRole("button", { name: "b.txt entfernen" }));
    expect(signals[1]!.aborted).toBe(true);
  });

  it("aborts what is still uploading when the composer goes away", async () => {
    const signals: AbortSignal[] = [];
    const onUpload = vi.fn((_f: File, _p: (n: number) => void, signal?: AbortSignal) => {
      signals.push(signal!);
      return new Promise<Attachment>(() => {});
    });
    const { unmount } = render(<Composer placeholder="Nachricht" onSend={vi.fn()} canAttach onUpload={onUpload} uploadLimitBytes={1000} />);
    await userEvent.setup().upload(screen.getByLabelText("Datei auswählen") as HTMLInputElement, new File(["abc"], "a.txt", { type: "text/plain" }));
    await waitFor(() => expect(onUpload).toHaveBeenCalled());
    unmount();
    expect(signals[0]!.aborted).toBe(true);
  });
});
