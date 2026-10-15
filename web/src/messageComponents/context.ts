// SPDX-License-Identifier: Apache-2.0
/**
 * What message components in the message list can reach (tavrn-protocol/APPLICATIONS.md §5.10): the invocation of
 * the conversation (sealed in encrypted conversations) and what the notices under a message need to decrypt
 * ephemeral replies. Provided by the conversation view; without it (search results, pins) components render
 * read-only.
 */
import { createContext, useContext } from "react";
import type { Message } from "@tavrn/sdk";
import type { MlsManager } from "@tavrn/e2ee";
import { create } from "zustand";

export interface ComponentsEnv {
  conversationId: string;
  /** The user holds `use_components` here (DMs: every member). */
  canUse: boolean;
  /**
   * Invokes a component of a bot's message; resolves once the node answered (the answer is shown by the view: a
   * message, a notice under the message, an update or a modal). API errors reject.
   */
  invoke: (m: Message, customId: string, values: string[] | null) => Promise<void>;
  /** For the notices under a message (encrypted ephemeral replies are decrypted with the group's keys). */
  qualified: string;
  encrypted: boolean;
  mls: MlsManager | null;
}

export const ComponentsContext = createContext<ComponentsEnv | null>(null);
export const useComponentsEnv = () => useContext(ComponentsContext);

/**
 * Messages whose components the node called expired (`410 component.expired`): their controls stay visible but
 * disabled. Memory only, keyed by conversation and message id.
 */
interface ExpiredState {
  expired: Record<string, true>;
  mark: (conversationId: string, messageId: string) => void;
}

export const useExpiredComponents = create<ExpiredState>((set) => ({
  expired: {},
  mark: (conversationId, messageId) => set((s) => ({ expired: { ...s.expired, [`${conversationId}:${messageId}`]: true } })),
}));
