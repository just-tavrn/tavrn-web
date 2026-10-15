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
  /** Shows a message of this conversation (the one whose component an answer belongs to). */
  jump?: (messageId: string) => void;
  /** For the notices under a message (encrypted ephemeral replies are decrypted with the group's keys). */
  qualified: string;
  encrypted: boolean;
  mls: MlsManager | null;
}

export const ComponentsContext = createContext<ComponentsEnv | null>(null);
export const useComponentsEnv = () => useContext(ComponentsContext);

/**
 * Messages whose components the node refused for good: `expired` (`410 component.expired`) or `gone` (`404
 * component.not_found`: the message's application was removed). Their controls stay visible but disabled, with the
 * reason. Memory only, keyed by conversation and message id.
 */
export type Unusable = "expired" | "gone";

interface UnusableState {
  state: Record<string, Unusable>;
  mark: (conversationId: string, messageId: string, why: Unusable) => void;
}

export const useUnusableComponents = create<UnusableState>((set) => ({
  state: {},
  mark: (conversationId, messageId, why) => set((s) => ({ state: { ...s.state, [`${conversationId}:${messageId}`]: why } })),
}));
