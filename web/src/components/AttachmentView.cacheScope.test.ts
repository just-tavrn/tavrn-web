// SPDX-License-Identifier: Apache-2.0
// The attachment cache keeps one node's bytes for that node only: plaintext attachments are cached per node, id and
// the signed hash, files-channel entries per node and id. A cached copy never stands in for an attachment of another
// node, or for the same id with another hash, without the hash check of the attachment being shown.
import { beforeEach, describe, expect, it } from "vitest";
import { AttachmentIntegrityError } from "@tavrn/e2ee";
import { forgetAttachments, loadAttachment, type ViewAttachment } from "./AttachmentView";

async function sha(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const nodeServing = (bytes: Uint8Array) => ({ attachments: { download: async () => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }) } }) as never;
const text = async (b: Blob) => new TextDecoder().decode(new Uint8Array(await b.arrayBuffer()));
const ID = "01ATTACHMENTIDKNOWN0000000";
const evil = new TextEncoder().encode("EVIL CONTENT");
const genuine = new TextEncoder().encode("GENUINE CONTENT");

describe("the attachment cache is scoped to the node, the id and the signed hash", () => {
  beforeEach(() => forgetAttachments());

  it("another node's bytes cached under the same id are never shown for a signed attachment", async () => {
    await loadAttachment(nodeServing(evil), { id: ID, name: "a.png", mime: "image/png", size: evil.length, encrypted: null, sha256: await sha(evil) });
    const shown = await loadAttachment(nodeServing(genuine), { id: ID, name: "a.png", mime: "image/png", size: genuine.length, encrypted: null, sha256: await sha(genuine) });
    expect(await text(shown)).toBe("GENUINE CONTENT");
  });

  it("the same node and id with another hash is checked again", async () => {
    const home = nodeServing(evil);
    await loadAttachment(home, { id: ID, name: "a.png", mime: "image/png", size: evil.length, encrypted: null, sha256: await sha(evil) });
    await expect(loadAttachment(home, { id: ID, name: "a.png", mime: "image/png", size: evil.length, encrypted: null, sha256: await sha(genuine) })).rejects.toBeInstanceOf(AttachmentIntegrityError);
  });

  it("an attachment without a hash is cached per node", async () => {
    const a: ViewAttachment = { id: ID, name: "a.png", mime: "image/png", size: 12, encrypted: null };
    await loadAttachment(nodeServing(evil), a);
    expect(await text(await loadAttachment(nodeServing(genuine), a))).toBe("GENUINE CONTENT");
  });

  it("files-channel entries with the same id on two nodes are kept apart", async () => {
    const entry = (bytes: Uint8Array): ViewAttachment => ({ id: ID, name: "f.txt", mime: "text/plain", size: bytes.length, encrypted: null, load: async () => new Blob([bytes as Uint8Array<ArrayBuffer>]) });
    await loadAttachment(nodeServing(evil), entry(evil));
    expect(await text(await loadAttachment(nodeServing(genuine), entry(genuine)))).toBe("GENUINE CONTENT");
  });

  it("the same node, id and hash share one download", async () => {
    let downloads = 0;
    const home = { attachments: { download: async () => (downloads++, new Blob([genuine as Uint8Array<ArrayBuffer>])) } } as never;
    const a: ViewAttachment = { id: ID, name: "a.png", mime: "image/png", size: genuine.length, encrypted: null, sha256: await sha(genuine) };
    await loadAttachment(home, a);
    await loadAttachment(home, { ...a });
    expect(downloads).toBe(1);
  });
});
