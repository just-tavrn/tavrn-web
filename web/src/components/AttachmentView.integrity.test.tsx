// SPDX-License-Identifier: Apache-2.0
/** Plaintext attachments are checked against the sha256 a signed message covers (FEDERATION.md §10.3). */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { b64urlEncode } from "@tavrn/sdk";
import { MessageAttachments, forgetAttachments, type ViewAttachment } from "./AttachmentView";
import { usePrivacy } from "../stores/privacy";
import { mockFetch } from "../test/render";

/** The bytes the mocked node serves for `body` (mockFetch sends JSON). */
async function sha256Of(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

const image = (id: string, sha256: string): ViewAttachment => ({ id, name: `${id}.png`, mime: "image/png", size: 10, encrypted: null, sha256 });

describe("plaintext attachments and their signed hash", () => {
  beforeEach(() => {
    usePrivacy.setState({ autoPreview: "always", maxBytes: 5000 });
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
  });

  it("shows the image when the bytes match and hides it with a note when the node swapped them", async () => {
    mockFetch({ "/blobs/ok1": { body: "picture" }, "/blobs/bad1": { body: "another picture" } });
    const hash = await sha256Of("picture");
    render(<MessageAttachments items={[image("ok1", hash), image("bad1", hash)]} inRoom />);
    await waitFor(() => expect(screen.getByTestId("attachment-failed")).toHaveTextContent("bad1.png"));
    expect(screen.getByTestId("attachment-failed")).toHaveTextContent("stimmt nicht mit der gesendeten Datei überein");
    expect(screen.getAllByTestId("attachment-image")).toHaveLength(1);
  });

  it("revokes the object URLs of the session on sign-out", async () => {
    mockFetch({ "/blobs/ok2": { body: "picture" } });
    render(<MessageAttachments items={[image("ok2", await sha256Of("picture"))]} inRoom />);
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    forgetAttachments();
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test"));
  });
});
