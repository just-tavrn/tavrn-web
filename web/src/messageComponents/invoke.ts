// SPDX-License-Identifier: Apache-2.0
/**
 * Invoking components and submitting modals (tavrn-protocol/APPLICATIONS.md §5.10), and what the client does with
 * the node's answer: the answers of application commands (§5.7) plus `update` and `modal`.
 */
import type { ComponentInvokeRequest, ComponentInvokeResponse, InvokeResponse, Message, Modal, ModalSubmitRequest, PaletteApplication } from "@tavrn/sdk";
import { encryptComponentValues, encryptModalValues, type ContentEncryptor } from "@tavrn/e2ee";
import { useInteractions } from "../stores/interactions";
import { errorText, modalOf } from "./model";

/** The node's answer to a command, a component or a modal submit; ephemeral replies of components name their message. */
export type InteractionAnswer = (InvokeResponse | ComponentInvokeResponse) & {
  ephemeral?: (NonNullable<InvokeResponse["ephemeral"]> & { message_id?: string | null }) | null;
  modal?: unknown;
};

/** Where values are sealed: the conversation's MLS group in encrypted conversations, nothing otherwise. */
export interface Sealer {
  mls: ContentEncryptor | null;
  /** The qualified conversation id (ENCRYPTION.md §0.1). */
  conversation: string | null;
}

/**
 * The body of an invocation. In encrypted conversations the values travel sealed as `component.values` (also for a
 * button, so the bot can verify who clicked); the node sees only the component's id.
 */
export async function componentBody(s: Sealer, messageId: string, customId: string, values: string[] | null): Promise<ComponentInvokeRequest> {
  if (!s.mls || !s.conversation) return { custom_id: customId, values, values_ciphertext: null, epoch: null };
  const sealed = await encryptComponentValues(s.mls, s.conversation, messageId, customId, values);
  return { custom_id: customId, values: null, ...sealed };
}

/** The body of a modal submit; sealed as `modal.values` in encrypted conversations. */
export async function modalBody(s: Sealer, interactionId: string, modalCustomId: string, values: Record<string, string>): Promise<ModalSubmitRequest> {
  if (!s.mls || !s.conversation) return { values, values_ciphertext: null, epoch: null };
  const sealed = await encryptModalValues(s.mls, s.conversation, interactionId, modalCustomId, values);
  return { values: null, ...sealed };
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
  if (res.outcome === "modal" || (res.modal !== undefined && res.modal !== null)) {
    const modal = modalOf(res.modal);
    // A modal that breaks the rules (§5.10.3) never opens: the invoker sees that the action failed.
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
