// SPDX-License-Identifier: Apache-2.0
/** The download icon saves through the platform's one entry point (platform/saveFile.ts), never an anchor of its own. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadButton, type ViewAttachment } from "./AttachmentView";
import { browserPlatform } from "../platform/browser";
import { resetPlatform, setPlatform } from "../platform";
import type { SaveFileRequest } from "../platform/files";
import { useToasts } from "../stores/toasts";
import { mockFetch } from "../test/render";

afterEach(() => {
  resetPlatform();
  useToasts.setState({ toasts: [] });
});

describe("DownloadButton", () => {
  it("loads the content once and hands it to saveFile with the attachment's name", async () => {
    mockFetch({});
    const saved: SaveFileRequest[] = [];
    setPlatform({ ...browserPlatform, saveFile: async (f) => (saved.push(f), { status: "cancelled" }) });
    const load = vi.fn(async () => new Blob(["secret plan"], { type: "text/plain" }));
    const a: ViewAttachment = { id: "dl1", name: "plan.txt", mime: "text/plain", size: 11, encrypted: null, load };
    render(<DownloadButton a={a} />);
    fireEvent.click(screen.getByTestId("attachment-download"));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.name).toBe("plan.txt");
    expect(await (saved[0]!.data as Blob).text()).toBe("secret plan");
    fireEvent.click(screen.getByTestId("attachment-download"));
    await waitFor(() => expect(saved).toHaveLength(2));
    expect(load).toHaveBeenCalledOnce();
  });

  it("shows a failed save as an error toast", async () => {
    mockFetch({});
    setPlatform({ ...browserPlatform, saveFile: async () => Promise.reject("download.write_failed") });
    const a: ViewAttachment = { id: "dl2", name: "x.txt", mime: "text/plain", size: 1, encrypted: null, load: async () => new Blob(["x"]) };
    render(<DownloadButton a={a} />);
    fireEvent.click(screen.getByTestId("attachment-download"));
    await waitFor(() => expect(useToasts.getState().toasts[0]?.kind).toBe("error"));
    expect(useToasts.getState().toasts[0]!.title).toContain("x.txt");
  });
});
