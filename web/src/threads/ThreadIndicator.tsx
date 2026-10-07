// SPDX-License-Identifier: Apache-2.0
import type { ThreadSummary, User } from "@tavrn/sdk";
import { useLocale, useT } from "../i18n";
import { UserAvatar } from "../components/Avatar";
import { relativeTime } from "./format";

/**
 * Under a message that started a thread (PROTOCOL.md §7e): "N replies · last reply 5 minutes ago" with the avatars of
 * the most recent writers; opens the thread.
 */
export function ThreadIndicator({ summary, usersById, onOpen }: { summary: ThreadSummary; usersById?: ReadonlyMap<string, User>; onOpen: () => void }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const users = (summary.participant_ids ?? []).map((id) => usersById?.get(id)).filter((u): u is User => !!u);
  const count = summary.message_count;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mt-1 flex min-h-9 max-w-full items-center gap-2 rounded-md border border-line bg-bg-1 px-2 text-xs text-fg-1 hover:border-accent hover:text-fg-0"
      data-testid="thread-indicator"
      data-thread-id={summary.id}
    >
      {users.length > 0 && (
        <span className="flex -space-x-1.5" aria-hidden="true">
          {users.map((u) => (
            <UserAvatar key={u.id} user={u} size={18} />
          ))}
        </span>
      )}
      <span className="font-medium text-accent">{count === 0 ? t("threads.no_replies") : t(count === 1 ? "threads.replies_one" : "threads.replies_many", { count })}</span>
      {count > 0 && <span className="truncate text-fg-2">· {t("threads.last_reply", { when: relativeTime(summary.last_message_at, locale) })}</span>}
      {summary.locked && <span className="text-fg-2">· {t("threads.locked")}</span>}
      {summary.archived_at && <span className="text-fg-2">· {t("threads.archived")}</span>}
    </button>
  );
}
