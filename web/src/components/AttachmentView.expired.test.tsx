// SPDX-License-Identifier: Apache-2.0
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Attachment } from "@tavrn/sdk";
import { MessageAttachments, fromEncrypted, fromPlain } from "./AttachmentView";
import { usePrivacy } from "../stores/privacy";
import { mockFetch } from "../test/render";

const plain = (id: string, mime: string, expired: boolean): Attachment => ({ id, name: `${id}.bin`, mime, size: 2048, sha256: "h", expired });

describe("MessageAttachments: expired attachments (design note 4.13 retention)", () => {
  let calls: Array<{ url: string }>;
  beforeEach(() => {
    calls = mockFetch({});
    usePrivacy.setState({ autoPreview: "always", maxBytes: 5_000_000, friends: new Set() });
  });

  it("shows 'file expired' without preview, player or download button and fetches nothing", () => {
    render(<MessageAttachments items={[fromPlain(plain("img", "image/png", true)), fromPlain(plain("snd", "audio/ogg", true)), fromPlain(plain("doc", "application/pdf", true))]} own inRoom />);
    const rows = screen.getAllByTestId("attachment-expired");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("img.bin");
    expect(rows[0]).toHaveTextContent("Datei abgelaufen");
    expect(screen.queryByTestId("attachment-image")).toBeNull();
    expect(screen.queryByTestId("audio-player")).toBeNull();
    expect(screen.queryByTestId("attachment-download")).toBeNull();
    expect(screen.queryByTestId("preview-placeholder")).toBeNull();
    expect(calls.filter((c) => c.url.includes("/blobs/"))).toHaveLength(0);
  });

  it("keeps the normal view for attachments that are not expired", () => {
    render(<MessageAttachments items={[fromPlain(plain("ok", "application/pdf", false))]} own inRoom />);
    expect(screen.getByTestId("attachment-file")).toBeInTheDocument();
    expect(screen.getByTestId("attachment-download")).toBeInTheDocument();
    expect(screen.queryByTestId("attachment-expired")).toBeNull();
  });

  it("marks encrypted attachments expired from the node's rows of the message", () => {
    const enc = { id: "e1", name: "geheim.pdf", mime: "application/pdf", size: 10, key: "k", sha256: "s" };
    const item = fromEncrypted(enc as never, [plain("e1", "application/octet-stream", true)]);
    expect(item.expired).toBe(true);
    expect(fromEncrypted(enc as never, null).expired).toBe(false);
    render(<MessageAttachments items={[item]} />);
    expect(screen.getByTestId("attachment-expired")).toHaveTextContent("geheim.pdf");
  });
});
