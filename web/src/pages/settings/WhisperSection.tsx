// SPDX-License-Identifier: Apache-2.0
import { Button, Input } from "../../components/ui";
import { useState } from "react";
import { useT } from "../../i18n";
import { platform } from "../../platform";
import { useVoiceEngine } from "../../voice/engine";
import { useVoice } from "../../voice/store";
import { useVoiceSettings, whisperRoomKey } from "../../voice/settings";
import { clearHotkey } from "../../voice/hotkeys";
import { HotkeyRecorder } from "./HotkeyRecorder";
import { Section } from "./common";

export function WhisperSection() {
  const t = useT();
  const native = useVoiceEngine((s) => s.kind === "native");
  const target = useVoice((s) => s.target);
  const settings = useVoiceSettings((s) => s.settings);
  const [name, setName] = useState("");
  const key = target && !target.call ? whisperRoomKey(target.domain, target.roomId) : null;
  const groups = key ? settings.whisperGroups[key] ?? [] : [];
  const update = (next: typeof groups) => { if (key) useVoiceSettings.getState().update({ whisperGroups: { ...settings.whisperGroups, [key]: next } }); };
  return <Section title={t("voice.whisper.title")} description={t("voice.whisper.settings_help")}>
    {native && <div className="my-2 text-sm"><p>{t("voice.whisper.browser_only")}</p><Button type="button" onClick={() => void platform().openExternal(`${platform().webOrigin()}/`)}>{t("voice.whisper.open_browser")}</Button></div>}
    <HotkeyRecorder action="whisper_reply" label={t("voice.hotkeys.action.whisper_reply")} testid={{ key: "whisper-reply-key", change: "whisper-reply-change", remove: "whisper-reply-remove" }} />
    {!key && <p className="text-sm text-fg-2">{t("voice.whisper.join_room")}</p>}
    {groups.map((g) => <div key={g.id} role="group" aria-label={g.name} className="my-3 space-y-2 rounded-md border border-line p-3">
      <label className="block text-sm">{t("voice.whisper.group_name")}<Input className="ml-2" defaultValue={g.name} maxLength={64} onBlur={(e) => update(groups.map((x) => x.id === g.id ? { ...x, name: e.target.value.trim() || g.name } : x))} /></label>
      <label className="block text-sm">{t("voice.whisper.members")}<Input className="w-full" defaultValue={g.members.join(", ")} onBlur={(e) => update(groups.map((x) => x.id === g.id ? { ...x, members: e.target.value.split(",").map((a) => a.trim()).filter(Boolean) } : x))} /></label>
      <HotkeyRecorder action={`whisper:${g.id}`} label={g.name} testid={{ key: `whisper-${g.id}-key`, change: `whisper-${g.id}-change`, remove: `whisper-${g.id}-remove` }} />
      <Button type="button" aria-label={t("voice.whisper.remove_group_named", { name: g.name })} onClick={() => { void clearHotkey(`whisper:${g.id}`); update(groups.filter((x) => x.id !== g.id)); }}>{t("voice.whisper.remove_group")}</Button>
    </div>)}
    {key && groups.length < 32 && <form onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; update([...groups, { id: crypto.randomUUID(), name: name.trim(), members: [] }]); setName(""); }} className="mt-3 flex gap-2">
      <Input aria-label={t("voice.whisper.group_name")} maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
      <Button type="submit">{t("voice.whisper.add_group")}</Button>
    </form>}
  </Section>;
}
