// SPDX-License-Identifier: Apache-2.0
import { useEffect, useId, useState } from "react";
import type { Member } from "@tavrn/sdk";
import { Button, Input } from "../../components/ui";
import { directMentionCandidates, matchMentions } from "../../composer/mentions";
import { MentionOption, optionId, SuggestionList } from "../../composer/MentionSuggest";
import { memberName } from "../../lib/memberGroups";
import { useT } from "../../i18n";

/** Room members only; reuse the composer's matching, identity labels and accessible suggestion rows. */
export function WhisperMembers({ members, selected, domain, self, onChange }: { members: Member[]; selected: string[]; domain: string; self?: string; onChange: (addresses: string[]) => void }) {
  const t = useT();
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const candidates = directMentionCandidates({ people: members.filter((m) => !m.user.deleted && m.user.address !== self).map((m) => ({ ...m.user, display_name: memberName(m) })), domain, self });
  const items = matchMentions(candidates.filter((c) => !selected.includes(c.key)), query).map((c) => ({ key: c.key, insert: c.key, data: c }));
  const index = Math.min(active, Math.max(0, items.length - 1));
  useEffect(() => { if (open) document.getElementById(optionId(id, index))?.scrollIntoView?.({ block: "nearest" }); }, [id, index, open, query]);
  const pick = (address: string) => { onChange([...selected, address]); setQuery(""); setActive(0); };
  return <div className="space-y-2">
    <span className="block text-sm text-fg-1">{t("voice.whisper.members")}{selected.length > 0 && <span className="text-fg-2"> · {selected.length}</span>}</span>
    {selected.length === 0 && <p className="text-xs text-fg-2">{t("voice.whisper.members_empty")}</p>}
    {selected.length > 0 && <ul className="flex flex-wrap gap-2" aria-label={t("voice.whisper.members")}>
      {selected.map((address) => <li key={address} className="flex max-w-full items-center gap-1 rounded-md bg-bg-3 pl-2 text-sm">
        <span className="min-w-0 break-all">{candidates.find((c) => c.key === address)?.name ?? address}<span className="block text-xs text-fg-2">{address}</span></span>
        <Button type="button" variant="ghost" className="min-h-11 min-w-11" aria-label={t("voice.whisper.remove_member", { name: address })} onClick={() => onChange(selected.filter((a) => a !== address))}>×</Button>
      </li>)}
    </ul>}
    <label htmlFor={`${id}-input`} className="block text-sm text-fg-1">{t("voice.whisper.add_member")}</label>
    <Input id={`${id}-input`} role="combobox" aria-label={t("voice.whisper.add_member")} aria-autocomplete="list" aria-expanded={open && items.length > 0} aria-controls={open && items.length ? id : undefined} aria-activedescendant={open && items.length ? optionId(id, index) : undefined} value={query} placeholder={t("voice.whisper.add_member_placeholder")} className="w-full min-h-11" autoComplete="off"
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true); }}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); setActive((index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length)); }
        if (e.key === "Enter") { e.preventDefault(); if (open && items[index]) pick(items[index].key); }
      }} />
    {/* Suggestions open below the field (the composer's list opens above its field, hence its bottom margin). */}
    {open && items.length > 0 && <div className="-mb-2"><SuggestionList id={id} label={t("voice.whisper.suggestions")} provider="whisper-members" items={items} selected={index} onPick={(item) => pick(item.key)} onHover={setActive} render={(item) => <MentionOption item={item.data} />} /></div>}
    {open && !items.length && <p role="status" className="text-xs text-fg-2">{t(query ? "voice.whisper.no_members" : "voice.whisper.no_more_members")}</p>}
  </div>;
}
