// SPDX-License-Identifier: Apache-2.0
/**
 * "Share to channel": the board as PNG, posted as an image attachment through the normal upload flow of
 * the target conversation (encrypted like any attachment in encrypted conversations, ENCRYPTION.md §6).
 */
import { apiFor } from "../stores/nodes";
import { getMls } from "../stores/mls";
import { encryptAttachment, qualify, signedAttachments } from "@tavrn/e2ee";

export interface ShareTarget {
  /** Domain of the node hosting the conversation. */
  domain: string;
  conversationId: string;
  encrypted: boolean;
  /** Shown in the picker. */
  label: string;
}

export class ShareError extends Error {
  constructor(readonly code: "locked" | "upload_mismatch") {
    super(code);
    this.name = "ShareError";
  }
}

export async function shareImage(target: ShareTarget, png: Blob, body: string, fileName = "whiteboard.png"): Promise<void> {
  const api = apiFor(target.domain);
  const file = new File([png], fileName, { type: "image/png" });
  const q = qualify(target.domain, target.conversationId);
  const mls = await getMls();
  if (target.encrypted) {
    if (!mls) throw new ShareError("locked");
    await mls.ensureJoined(q, { canCreate: true });
    const { blob, meta } = await encryptAttachment(file);
    const stored = await api.attachments.uploadToConversation(target.conversationId, blob, "");
    if (stored.sha256 !== meta.sha256) throw new ShareError("upload_mismatch");
    const sealed = await mls.encrypt(q, { type: "text", body, attachments: [{ id: stored.id, ...meta }] }, { ctx: { thread_id: null, reply_to: null } });
    await api.conversations.send(target.conversationId, { ...sealed, attachments: [stored.id] });
    return;
  }
  const stored = await api.attachments.uploadToConversation(target.conversationId, file, file.name);
  const content = { type: "text", body };
  // Plaintext messages carry the device signature when this device has a key (FEDERATION.md §10.3).
  const signature = mls?.signPlaintext(q, { reply_to: null, thread_id: null, mentions_everyone: false, mentions: [], attachments: signedAttachments([stored]) }, content) ?? null;
  await api.conversations.send(target.conversationId, { content, attachments: [stored.id], ...(signature ? { signature } : {}) });
}
