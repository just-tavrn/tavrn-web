// SPDX-License-Identifier: Apache-2.0
/**
 * The warning before saving an executable or a script (docs/CLIENT.md "Downloads"): cancel saves nothing, "Download
 * anyway" saves; archives and ordinary files are saved without a question.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DownloadButton, type ViewAttachment } from "./AttachmentView";
import { DownloadWarningDialog } from "./DownloadWarningDialog";
import { saveDownload } from "../lib/download";
import { browserPlatform } from "../platform/browser";
import { resetPlatform, setPlatform } from "../platform";
import type { SaveFileRequest } from "../platform/files";
import { useToasts } from "../stores/toasts";
import { mockFetch } from "../test/render";
import { useLocale } from "../i18n";

beforeEach(() => useLocale.setState({ locale: "en" }));

afterEach(() => {
  resetPlatform();
  useToasts.setState({ toasts: [] });
});

function capture() {
  const saved: SaveFileRequest[] = [];
  setPlatform({ ...browserPlatform, saveFile: async (f) => (saved.push(f), { status: "started" }) });
  return saved;
}

const exe = (id: string): ViewAttachment => ({ id, name: "setup.exe", mime: "application/octet-stream", size: 4, encrypted: null, load: async () => new Blob([new Uint8Array([0x4d, 0x5a, 0x90, 0])]) });

describe("download warning", () => {
  it("asks before saving an executable; cancel saves nothing", async () => {
    mockFetch({});
    const saved = capture();
    render(
      <>
        <DownloadButton a={exe("w1")} />
        <DownloadWarningDialog />
      </>,
    );
    fireEvent.click(screen.getByTestId("attachment-download"));
    const dialog = await screen.findByRole("dialog", { name: "This file can run programs on your computer" });
    expect(dialog).toHaveTextContent("setup.exe");
    expect(dialog).toHaveTextContent("Windows program");
    // "Download anyway" is not the default action: the focus starts on Cancel.
    await waitFor(() => expect(screen.getByTestId("download-warning-cancel")).toHaveFocus());
    fireEvent.click(screen.getByTestId("download-warning-cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(saved).toHaveLength(0);
    expect(useToasts.getState().toasts.filter((t) => t.kind === "error")).toHaveLength(0);
  });

  it("saves after \"Download anyway\"", async () => {
    mockFetch({});
    const saved = capture();
    render(
      <>
        <DownloadButton a={exe("w2")} />
        <DownloadWarningDialog />
      </>,
    );
    fireEvent.click(screen.getByTestId("attachment-download"));
    fireEvent.click(await screen.findByTestId("download-warning-anyway"));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.name).toBe("setup.exe");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape cancels", async () => {
    const saved = capture();
    render(<DownloadWarningDialog />);
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = saveDownload({ name: "x.sh", data: new TextEncoder().encode("echo hi") }, "text/plain");
    });
    await screen.findByRole("dialog");
    fireEvent.keyDown(window, { key: "Escape" });
    await expect(done).resolves.toEqual({ status: "cancelled" });
    expect(saved).toHaveLength(0);
  });

  it("classifies by content: a renamed binary is warned, a zip archive is not", async () => {
    const saved = capture();
    render(<DownloadWarningDialog />);
    await act(() => saveDownload({ name: "mod.zip", data: new Uint8Array([0x50, 0x4b, 3, 4]) }, "application/zip"));
    await act(() => saveDownload({ name: "notes.txt", data: new Blob(["hi"]) }, "text/plain"));
    expect(saved.map((s) => s.name)).toEqual(["mod.zip", "notes.txt"]);
    act(() => void saveDownload({ name: "photo.png", data: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]) }, "image/png"));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Linux program");
    fireEvent.click(screen.getByTestId("download-warning-anyway"));
    await waitFor(() => expect(saved).toHaveLength(3));
  });
});
