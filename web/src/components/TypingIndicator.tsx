// SPDX-License-Identifier: Apache-2.0
import { useT } from "../i18n";
import { useTyping } from "../stores/typing";

/**
 * "Someone is typing" under a conversation. Subscribes to the number of other people typing only, so typing events
 * and the periodic cleanup render this line and nothing else of the conversation.
 */
export function TypingIndicator({ conversationId, selfId }: { conversationId: string; selfId: string | undefined }) {
  const t = useT();
  const count = useTyping((s) => {
    const users = s.byChannel[conversationId];
    if (!users) return 0;
    let n = 0;
    for (const id in users) if (id !== selfId) n++;
    return n;
  });
  return (
    <div className="h-5 px-4 text-xs text-fg-2" aria-live="polite" data-testid="typing-indicator">
      {count === 1 && t("messages.typing_one")}
      {count > 1 && t("messages.typing_many", { count })}
    </div>
  );
}
