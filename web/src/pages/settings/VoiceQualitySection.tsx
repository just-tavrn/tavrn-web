// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Channel, RoomDetail } from "@tavrn/sdk";
import { useNode } from "../../components/NodeScope";
import { useT } from "../../i18n";
import { toastError, useToasts } from "../../stores/toasts";
import { Button, Input } from "../../components/ui";
import { Section } from "./common";
import { DEFAULT_KBPS, MAX_KBPS, MIN_KBPS, clampCustom, isMusic, presetChoices, presetOf, trafficMbPerHour, type PresetId } from "../../voice/quality";
import { withChannel, type RoomPatch } from "../../lib/roomCache";

type Choice = PresetId | "custom";

/**
 * Quality of a voice channel (VOICE.md §4a): presets for `bitrate_kbps` from Saver to Music plus a custom value.
 * Presets above the node's cap (`node.voice.max_bitrate_kbps`) are shown as limited and cannot be chosen; the
 * node refuses them anyway. Needs `manage_channels`.
 */
export function VoiceQualitySection({ channel, room, canManage, onChanged }: { channel: Channel; room: RoomDetail; canManage: boolean; onChanged: (patch?: RoomPatch) => Promise<void> }) {
  const { api, home, domain } = useNode();
  const t = useT();
  const nodeInfo = useQuery({ queryKey: home ? ["node"] : ["node", domain], queryFn: () => api.node.info(), staleTime: 10 * 60_000 });
  const cap = nodeInfo.data?.voice?.max_bitrate_kbps ?? null;
  const stored = channel.bitrate_kbps || DEFAULT_KBPS;
  const [choice, setChoice] = useState<Choice>(presetOf(stored));
  const [custom, setCustom] = useState(stored);
  const [busy, setBusy] = useState(false);
  const choices = presetChoices(cap);
  const kbps = choice === "custom" ? clampCustom(custom, cap) : choices.find((c) => c.id === choice)!.kbps;
  const music = isMusic(kbps);

  const save = async () => {
    setBusy(true);
    try {
      await onChanged(withChannel(await api.channels.update(room.id, channel.id, { bitrate_kbps: kbps })));
      useToasts.getState().push({ kind: "info", title: t("channels.saved") });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const option = (id: Choice, label: string, detail: string, disabled: boolean, note?: string) => (
    <label key={id} className={`flex min-h-12 items-start gap-2 rounded-md border px-3 py-2 text-sm ${choice === id ? "border-accent bg-bg-3/60" : "border-line"} ${disabled ? "opacity-60" : "cursor-pointer hover:bg-bg-3/40"}`}>
      <input type="radio" name={`quality-${channel.id}`} className="mt-1 h-4 w-4 accent-accent" checked={choice === id} disabled={disabled} onChange={() => setChoice(id)} data-testid={`quality-preset-${id}`} />
      <span className="min-w-0">
        <span className="font-medium text-fg-0">{label}</span>
        <span className="block text-xs text-fg-2">{detail}</span>
        {note && <span className="block text-xs text-warn">{note}</span>}
      </span>
    </label>
  );

  return (
    <Section title={t("voice.quality.title")} description={t("voice.quality.hint")}>
      <fieldset className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label={t("voice.quality.title")}>
        {choices.map((c) =>
          option(c.id, `${t(`voice.quality.preset.${c.id}`)} · ${t("voice.quality.kbps", { kbps: c.kbps })}`, t(`voice.quality.desc.${c.id}`), !canManage || busy || c.limited, c.limited && cap !== null ? t("voice.quality.limited", { max: cap }) : undefined),
        )}
        {option("custom", t("voice.quality.preset.custom"), t("voice.quality.desc.custom"), !canManage || busy)}
      </fieldset>
      {choice === "custom" && (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          {t("voice.quality.custom_label")}
          <Input type="number" className="w-28" min={MIN_KBPS} max={cap ?? MAX_KBPS} value={custom} onChange={(e) => setCustom(Number(e.target.value))} disabled={!canManage || busy} data-testid="quality-custom-kbps" />
        </label>
      )}
      {cap !== null && stored > cap && <p className="text-xs text-warn">{t("voice.quality.capped", { max: cap })}</p>}
      <p className="text-xs text-fg-2" data-testid="quality-traffic">
        {t(music ? "voice.quality.traffic_music" : "voice.quality.traffic", { mb: trafficMbPerHour(kbps) })}
      </p>
      {music && <p className="text-xs text-fg-2">{t("voice.quality.music_note")}</p>}
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => void save()} disabled={busy || kbps === stored} data-testid="voice-quality-save">
            {t("voice.quality.save")}
          </Button>
        </div>
      )}
    </Section>
  );
}
