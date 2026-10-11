// SPDX-License-Identifier: Apache-2.0
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Attachment } from "@tavrn/sdk";
import type { ContentAttachment } from "@tavrn/e2ee";
import { MessageAttachments, fromEncrypted, fromPlain } from "./AttachmentView";
import { mockFetch } from "../test/render";

const SPOOF = "invoice‮fdp.exe";

describe("attachment names are shown without bidi controls", () => {
  it("plain and encrypted attachments", () => {
    expect(fromPlain({ id: "a", name: SPOOF, mime: "application/octet-stream", size: 1 } as Attachment).name).toBe("invoicefdp.exe");
    expect(fromEncrypted({ id: "b", name: SPOOF, mime: "application/octet-stream", size: 1, key: "k", sha256: "h" } as unknown as ContentAttachment).name).toBe("invoicefdp.exe");
  });

  it("a file row shows the real order of the name", () => {
    mockFetch({});
    render(<MessageAttachments items={[fromPlain({ id: "a", name: SPOOF, mime: "application/octet-stream", size: 1 } as Attachment)]} />);
    expect(screen.getByText("invoicefdp.exe")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("‮");
  });
});
