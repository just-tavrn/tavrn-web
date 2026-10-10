// SPDX-License-Identifier: Apache-2.0
import { useT } from "../i18n";
import { GroupOffIcon, LockIcon, NoEntryIcon, UnlockIcon } from "./icons";
import { acknowledgeKeyChange, useMlsUi } from "../stores/mls";
import { formatCount, useUnread } from "../stores/unread";
import type { AccessMarkKind } from "../lib/channelPermissions";

/**
 * Bots are always marked (design note 4.7). Webhook authors get the WEBHOOK badge (APPLICATIONS.md §1.5); every other
 * kind that is not `user` is shown like a bot.
 */
export function BotBadge({ kind }: { kind?: string | null } = {}) {
  const t = useT();
  if (kind === "webhook") return <WebhookBadge />;
  return (
    <span className="rounded bg-accent-soft px-1 text-[10px] font-semibold uppercase tracking-wide text-accent" title={t("badge.bot_hint")} data-testid="bot-badge">
      {t("badge.bot")}
    </span>
  );
}

/** Messages of an incoming webhook (APPLICATIONS.md §6.1). */
export function WebhookBadge() {
  const t = useT();
  return (
    <span className="rounded bg-accent-soft px-1 text-[10px] font-semibold uppercase tracking-wide text-accent" title={t("badge.webhook_hint")} data-testid="webhook-badge">
      {t("badge.webhook")}
    </span>
  );
}

/**
 * The encryption of a channel or conversation as an SVG lock (16 px in lists, 18 px in headers): named "Encrypted" or
 * "Unencrypted"; `title` can explain more in the tooltip. Plaintext uses the warning colour, but the open shackle and
 * the name carry the meaning, not the colour.
 */
export function LockMark({ open = false, size = 16, title, testId, className = "" }: { open?: boolean; size?: number; title?: string; testId?: string; className?: string }) {
  const t = useT();
  const label = open ? t("channel.unencrypted") : t("channel.lock");
  return (
    <span role="img" aria-label={label} title={title ?? label} className={`inline-flex shrink-0 ${open ? "text-warn" : "text-fg-1"} ${className}`} data-testid={testId}>
      {open ? <UnlockIcon size={size} /> : <LockIcon size={size} />}
    </span>
  );
}

/**
 * A webhook message sealed for the channel's members (APPLICATIONS.md §6.1a): a lock whose tooltip says who sealed it
 * (the node, when it did, saw the text once).
 */
export function SealedMark({ by }: { by: "sender" | "node" }) {
  const t = useT();
  const label = t(by === "node" ? "badge.sealed_node" : "badge.sealed_sender");
  return (
    <span role="img" aria-label={label} title={label} className="cursor-help text-xs" data-testid="sealed-mark" data-sealed-by={by}>
      🔒
    </span>
  );
}

/** An encrypted channel that admits bots in a room that keeps them out by default (design note 4.7, APPLICATIONS.md §3.5). */
export function BotsAllowedIcon() {
  const t = useT();
  return (
    <span title={t("apps.bots_allowed.icon")} aria-label={t("apps.bots_allowed.icon")} role="img" className="shrink-0 text-[10px]" data-testid="bots-allowed-icon">
      🤖
    </span>
  );
}

/** Marks a channel no bot can see or join ("no bots", APPLICATIONS.md §3.5). */
export function NoBotsIcon() {
  const t = useT();
  return (
    <span title={t("apps.no_bots.icon")} aria-label={t("apps.no_bots.icon")} role="img" className="shrink-0 text-[10px]" data-testid="no-bots-icon">
      🚫🤖
    </span>
  );
}

/**
 * "Security key changed" (ENCRYPTION.md §3.3): shown next to a user whose identity key differs from the
 * pinned one until the user acknowledges it with a click. A key rotated with a valid continuity statement (§9a)
 * gets a soft, dismissable "security key rotated" notice instead (one click, nothing to confirm).
 */
export function KeyChangedBadge({ address }: { address: string }) {
  const t = useT();
  const changed = useMlsUi((s) => !!s.changedKeys[address]);
  const rotated = useMlsUi((s) => !!s.rotatedKeys[address]);
  if (changed) {
    return (
      <button
        type="button"
        onClick={() => {
          if (confirm(t("badge.key_changed_confirm", { address }))) void acknowledgeKeyChange(address);
        }}
        className="rounded bg-warn/15 px-1 text-[10px] font-semibold text-warn hover:bg-warn/25"
        title={t("badge.key_changed_hint", { address })}
        data-testid="key-changed-badge"
      >
        ⚠ {t("badge.key_changed")}
      </button>
    );
  }
  if (!rotated) return null;
  return (
    <button
      type="button"
      onClick={() => void acknowledgeKeyChange(address)}
      className="rounded bg-accent-soft px-1 text-[10px] font-medium text-fg-1 hover:bg-bg-3"
      title={t("badge.key_rotated_hint", { address })}
      aria-label={`${t("badge.key_rotated")}: ${t("badge.key_rotated_dismiss")}`}
      data-testid="key-rotated-badge"
    >
      🔑 {t("badge.key_rotated")} <span aria-hidden="true">×</span>
    </button>
  );
}

/** Has the conversation unread messages (the sidebar shows its name in bold)? */
export function useHasUnread(conversationId: string): boolean {
  return useUnread((s) => (s.states[conversationId]?.unread ?? 0) > 0);
}

/** Unread count bubble and a separate mention bubble (design note 4.4), from the node's counts. */
export function UnreadBadges({ conversationId }: { conversationId: string }) {
  const t = useT();
  const info = useUnread((s) => s.states[conversationId]);
  if (!info || (info.unread === 0 && info.mentions === 0)) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {info.mentions > 0 && (
        <span role="img" className="min-w-5 rounded-full bg-danger-solid px-1.5 text-center text-xs font-semibold leading-5 text-white" aria-label={t("unread.mentions", { count: formatCount(info.mentions) })} data-testid="mention-count">
          @{formatCount(info.mentions)}
        </span>
      )}
      {info.unread > 0 && (
        <span role="img" className="min-w-5 rounded-full bg-accent px-1.5 text-center text-xs font-semibold leading-5 text-accent-text" aria-label={t("unread.count", { count: formatCount(info.unread) })} data-testid="unread-count">
          {formatCount(info.unread)}
        </span>
      )}
    </span>
  );
}

const ACCESS_LABEL: Record<AccessMarkKind, string> = {
  private: "channel.access.private",
  join_private: "channel.access.join_private",
  restricted_join: "channel.access.restricted_join",
  restricted_read: "channel.access.restricted_read",
};

/** The translation key of an access mark's text (also used where a parent's accessible name repeats it). */
export function accessMarkKey(kind: AccessMarkKind): string {
  return ACCESS_LABEL[kind];
}

/**
 * An access mark of a channel as a 16 px SVG, named and with the same text as tooltip. "Private" (a group with a
 * slash) is structural: `@everyone` may not view the channel, or may not join the voice channel. "Restricted" (no
 * entry) is per viewer: they see the channel but may not join or write. The lock stays the encryption mark. The glyph
 * uses `fg-2` (at least 4.5:1 on `bg-0`…`bg-3`, above the 3:1 icons need); the name carries the meaning, not the colour.
 */
export function AccessMark({ kind, size = 16 }: { kind: AccessMarkKind; size?: number }) {
  const t = useT();
  const label = t(ACCESS_LABEL[kind]);
  const isPrivate = kind === "private" || kind === "join_private";
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex shrink-0 text-fg-2" data-testid={isPrivate ? "channel-private" : "channel-restricted"} data-access={kind}>
      {isPrivate ? <GroupOffIcon size={size} /> : <NoEntryIcon size={size} />}
    </span>
  );
}
