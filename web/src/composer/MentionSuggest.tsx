// SPDX-License-Identifier: Apache-2.0
/**
 * The suggestion list of the composer's autocomplete (docs/CLIENT.md "The composer"): an ARIA listbox controlled by
 * the text box (combobox pattern: the text box keeps the focus, `aria-activedescendant` names the selected option).
 * It sits above the input, so on phones it stays above the on-screen keyboard; rows are 44 px high. Options are
 * picked with the mouse or touch without taking the focus from the text box.
 */
import type { ReactNode } from "react";
import { useT } from "../i18n";
import { MediaAvatar, UserAvatar } from "../components/Avatar";
import { BotBadge } from "../components/Badges";
import type { Suggestion } from "./autocomplete";
import type { MentionCandidate } from "./mentions";
import type { ChannelCandidate } from "./channels";
import { AnnouncementIcon, FolderIcon, ForumIcon, HashIcon, SparkleIcon } from "../components/icons";
import { SpeakerIcon } from "../voice/ui/icons";

/** The id of option `index` of the list `id` (the text box's `aria-activedescendant`). */
export const optionId = (id: string, index: number) => `${id}-opt-${index}`;

export function SuggestionList<T>({
  id,
  label,
  provider,
  items,
  selected,
  onPick,
  onHover,
  render,
}: {
  id: string;
  label: string;
  provider: string;
  items: Suggestion<T>[];
  selected: number;
  onPick: (item: Suggestion<T>) => void;
  onHover: (index: number) => void;
  render: (item: Suggestion<T>) => ReactNode;
}) {
  return (
    <ul id={id} role="listbox" aria-label={label} className="mb-2 max-h-[min(22rem,40vh)] overflow-y-auto rounded-lg border border-line bg-bg-1 py-1 shadow-lg" data-testid={`suggest-${provider}`}>
      {items.map((item, i) => (
        <li
          key={item.key}
          id={optionId(id, i)}
          role="option"
          aria-selected={i === selected}
          data-testid="suggest-option"
          data-key={item.key}
          // Picking keeps the focus (and the on-screen keyboard) in the text box.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item);
          }}
          onMouseEnter={() => onHover(i)}
          className={`flex min-h-11 cursor-pointer items-center gap-2 px-3 py-1 text-sm ${i === selected ? "bg-accent-soft text-fg-0" : "text-fg-1"}`}
        >
          {render(item)}
        </li>
      ))}
    </ul>
  );
}

/** One row of the mention list: avatar, name, the address part that identifies it, BOT badge, "you". */
export function MentionOption({ item }: { item: MentionCandidate }) {
  const t = useT();
  if (item.kind === "user") {
    return (
      <>
        {item.avatar ? <UserAvatar user={item.avatar} size={24} /> : <MediaAvatar name={item.name} size={24} />}
        <span className="min-w-0 truncate font-medium text-fg-0">{item.name}</span>
        <span className="suggest-meta min-w-0 truncate text-xs" data-testid="suggest-handle">
          @{item.username}
          {item.remote ? `@${item.remote}` : ""}
        </span>
        {item.bot && <BotBadge />}
        {item.self && <span className="suggest-meta ml-auto shrink-0 text-xs">{t("composer.mention.you")}</span>}
      </>
    );
  }
  return (
    <>
      <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-3 text-xs font-semibold text-fg-1" style={item.color ? { boxShadow: `inset 0 0 0 2px ${item.color}` } : undefined}>
        @
      </span>
      <span className="min-w-0 truncate font-medium text-fg-0">{item.kind === "role" ? `@${item.name}` : item.name}</span>
      <span className="suggest-meta ml-auto shrink-0 text-xs">{item.kind === "role" ? t("composer.mention.role") : t("composer.mention.everyone_hint")}</span>
    </>
  );
}

/** One row of the channel list: the kind icon (as in the channel list), the name and its category. */
export function ChannelOption({ item }: { item: ChannelCandidate }) {
  const Icon = item.kind === "voice" ? SpeakerIcon : item.kind === "announcement" ? AnnouncementIcon : item.kind === "forum" ? ForumIcon : item.kind === "files" ? FolderIcon : item.kind === "system" ? SparkleIcon : HashIcon;
  return (
    <>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center text-fg-2">
        <Icon size={18} data-testid="channel-kind-icon" data-icon={item.kind} />
      </span>
      <span className="min-w-0 truncate font-medium text-fg-0">{item.name}</span>
      {item.category && <span className="suggest-meta ml-auto min-w-0 shrink truncate text-xs" data-testid="suggest-category">{item.category}</span>}
    </>
  );
}
