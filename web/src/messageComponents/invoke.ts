// SPDX-License-Identifier: Apache-2.0
/**
 * Invoking components and submitting modals (tavrn-protocol/APPLICATIONS.md §5.10), and what the client does with
 * the node's answer — the same answers as for application commands (§5.7) plus `update` and `modal`.
 */
import type { InvokeResponse, Message, PaletteApplication, TavrnApi } from "@tavrn/sdk";
import type { ContentEncryptor } from "@tavrn/e2ee";
import { useInteractions } from "../stores/interactions";
import { errorText, modalOf } from "./model";
import type { Modal } from "./types";

/** The invocation of a component (§5.10): plaintext values, or the sealed `component.values` object. */
export interface ComponentInvokeBody {
  custom_id: string;
  values: string[] | null;
  values_ciphertext: string | null;
  epoch: number | null;
}

/** The submission of a modal: plaintext values, or the sealed `modal.values` object. */
export interface ModalSubmitBody {
  values: Record<string, string> | null;
  values_ciphertext: string | null;
  epoch: number | null;
}

/** The node's answer to an invocation or a submission: §5.5 plus the modal the invoking device shows. */
export type InteractionAnswer = InvokeResponse & { modal?: unknown; ephemeral?: (InvokeResponse["ephemeral"] & { message_id?: string | null }) | null };

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const nonce = () => b64url(crypto.getRandomValues(new Uint8Array(16)));

/** The `component.values` content object the invoker's device encrypts for the group (§5.10). */
export function componentValuesContent(messageId: string, customId: string, values: string[] | null, now = new Date()) {
  return { type: "component.values", message_id: messageId, custom_id: customId, values, nonce: nonce(), issued_at: now.toISOString() };
}

/** The `modal.values` content object (§5.10). */
export function modalValuesContent(interactionId: string, modalCustomId: string, values: Record<string, string>, now = new Date()) {
  return { type: "modal.values", interaction: interactionId, custom_id: modalCustomId, values, nonce: nonce(), issued_at: now.toISOString() };
}

/** The body of an invocation; in encrypted conversations the values travel sealed and the node sees only the id. */
export async function componentBody(mls: ContentEncryptor | null, conversation: string | null, m: Pick<Message, "id">, customId: string, values: string[] | null): Promise<ComponentInvokeBody> {
  if (!mls || !conversation) return { custom_id: customId, values, values_ciphertext: null, epoch: null };
  const sealed = await mls.encrypt(conversation, componentValuesContent(m.id, customId, values));
  return { custom_id: customId, values: null, values_ciphertext: sealed.content, epoch: sealed.epoch };
}

export async function modalBody(mls: ContentEncryptor | null, conversation: string | null, interactionId: string, modalCustomId: string, values: Record<string, string>): Promise<ModalSubmitBody> {
  if (!mls || !conversation) return { values, values_ciphertext: null, epoch: null };
  const sealed = await mls.encrypt(conversation, modalValuesContent(interactionId, modalCustomId, values));
  return { values: null, values_ciphertext: sealed.content, epoch: sealed.epoch };
}

/** `POST /conversations/{id}/messages/{message_id}/interactions`. */
export function invokeComponent(api: TavrnApi, conversationId: string, messageId: string, body: ComponentInvokeBody): Promise<InteractionAnswer> {
  return api.request<InteractionAnswer>("POST", `/conversations/${conversationId}/messages/${messageId}/interactions`, body);
}

/** `POST /interactions/{id}/submit`. */
export function submitModal(api: TavrnApi, interactionId: string, body: ModalSubmitBody): Promise<InteractionAnswer> {
  return api.request<InteractionAnswer>("POST", `/interactions/${encodeURIComponent(interactionId)}/submit`, body);
}

/** An open modal: the interaction it answers, who asked and where its answer belongs. */
export interface OpenModal {
  interactionId: string;
  modal: Modal;
  application: PaletteApplication;
  messageId: string | null;
}

export interface AnswerTarget {
  conversationId: string;
  application: PaletteApplication;
  /** The message whose component was used (null for commands): notices are shown under it. */
  messageId: string | null;
  addMessage: (m: Message) => void;
  updateMessage: (m: Message) => void;
  openModal: (open: OpenModal) => void;
}

/**
 * Shows the answer: a stored reply or an update arrives as a message (also over the WebSocket), an ephemeral reply,
 * "… is thinking" and an error become notices under the message (at the bottom without one), a modal opens.
 */
export function applyAnswer(res: InteractionAnswer, to: AnswerTarget): void {
  const notices = useInteractions.getState();
  const modal = modalOf(res.modal);
  if (res.outcome === "modal" || modal) {
    if (modal) to.openModal({ interactionId: res.interaction_id, modal, application: to.application, messageId: to.messageId });
    else notices.add({ interactionId: res.interaction_id, conversationId: to.conversationId, messageId: to.messageId, kind: "error", application: to.application, text: "" });
    return;
  }
  if (res.message) {
    if (res.outcome === "update") to.updateMessage(res.message);
    else to.addMessage(res.message);
    notices.resolve(res.interaction_id);
  } else if (res.ephemeral) {
    const r = res.ephemeral;
    notices.add({ interactionId: r.interaction_id, conversationId: to.conversationId, messageId: r.message_id ?? null, kind: "ephemeral", application: r.application, content: r.content, epoch: r.epoch, deviceId: r.device_id });
  } else if (res.outcome === "defer") {
    notices.add({ key: `${res.interaction_id}:thinking`, interactionId: res.interaction_id, conversationId: to.conversationId, messageId: to.messageId, kind: "thinking", application: to.application });
  } else if (res.outcome === "error") {
    notices.add({ interactionId: res.interaction_id, conversationId: to.conversationId, messageId: to.messageId, kind: "error", application: to.application, text: errorText(res.error) });
  }
}
