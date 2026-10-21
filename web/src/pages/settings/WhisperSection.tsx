// SPDX-License-Identifier: Apache-2.0
import { Button, Input } from "../../components/ui";
import { useState } from "react";
import { useT } from "../../i18n";
import { platform } from "../../platform";
import { useVoiceEngine } from "../../voice/engine";
import type { Member } from "@tavrn/sdk";
import { WhisperMembers } from "./WhisperMembers";
import { useVoiceSettings, whisperRoomKey } from "../../voice/settings";
import { clearHotkey } from "../../voice/hotkeys";
import { HotkeyRecorder } from "./HotkeyRecorder";
import { Section } from "./common";

/** At most this many groups per room (the hotkey table and the member menu stay manageable). */
export const MAX_WHISPER_GROUPS = 32;

/**
 * Personal whisper groups of one room (VOICE.md §4c), saved on this device: name, members from the room member list
 * and a hold shortcut per group. Editable without a voice connection; the reply shortcut lives in the user settings.
 */
export function WhisperSection({ domain, roomId, members, self }: { domain: string; roomId: string; members: Member[]; self?: string }) {
  const t = useT();
  const native = useVoiceEngine((s) => s.kind === "native");
  const settings = useVoiceSettings((s) => s.settings);
  const [name, setName] = useState("");
  const key = whisperRoomKey(domain, roomId);
  const groups = settings.whisperGroups[key] ?? [];
  const update = (next: typeof groups) => { if (key) useVoiceSettings.getState().update({ whisperGroups: { ...settings.whisperGroups, [key]: next } }); };
  return <Section title={t("voice.whisper.title")} description={t("voice.whisper.settings_help")}>
    <p className="text-xs text-fg-2">{t("voice.whisper.settings_reply_hint")}</p>
    {native && <div className="my-2 space-y-2 rounded-md border border-warn/40 bg-warn/10 p-3 text-sm"><p>{t("voice.whisper.browser_only")}</p><Button type="button" onClick={() => void platform().openExternal(`${platform().webOrigin()}/`)}>{t("voice.whisper.open_browser")}</Button></div>}
    {groups.length === 0 && <p className="text-sm text-fg-2" data-testid="whisper-groups-empty">{t("voice.whisper.empty")}</p>}
    {groups.map((g) => <div key={g.id} role="group" aria-label={g.name} className="space-y-3 rounded-md border border-line p-3" data-testid="whisper-group">
      <label className="block text-sm">
        <span className="text-fg-1">{t("voice.whisper.group_name")}</span>
        <Input className="mt-1" defaultValue={g.name} maxLength={64} onBlur={(e) => update(groups.map((x) => x.id === g.id ? { ...x, name: e.target.value.trim() || g.name } : x))} />
      </label>
      <WhisperMembers members={members} selected={g.members} domain={domain} self={self} onChange={(addresses) => update(groups.map((x) => x.id === g.id ? { ...x, members: addresses } : x))} />
      <HotkeyRecorder action={`whisper:${g.id}`} label={t("voice.whisper.hotkey")} testid={{ key: `whisper-${g.id}-key`, change: `whisper-${g.id}-change`, remove: `whisper-${g.id}-remove` }} />
      <div className="flex justify-end">
        <Button type="button" variant="ghost" aria-label={t("voice.whisper.remove_group_named", { name: g.name })} onClick={() => { void clearHotkey(`whisper:${g.id}`); update(groups.filter((x) => x.id !== g.id)); }}>{t("voice.whisper.remove_group")}</Button>
      </div>
    </div>)}
    {groups.length < MAX_WHISPER_GROUPS && <form onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; update([...groups, { id: crypto.randomUUID(), name: name.trim(), members: [] }]); setName(""); }} className="flex flex-wrap gap-2">
      <Input className="min-w-0 flex-1" aria-label={t("voice.whisper.group_name")} placeholder={t("voice.whisper.group_name_placeholder")} maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
      <Button type="submit" disabled={!name.trim()}>{t("voice.whisper.add_group")}</Button>
    </form>}
  </Section>;
}
