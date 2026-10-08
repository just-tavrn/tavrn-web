// SPDX-License-Identifier: Apache-2.0
import { useT } from "../../i18n";
import { useVoice } from "../store";
import { isMusic, presetOf, trafficMbPerHour } from "../quality";

/**
 * The quality of the current call (VOICE.md §4a) as a small label of the voice panel: the preset name (or the
 * bitrate of a custom value), the Opus bitrate in the tooltip, for music mode also stereo and the traffic.
 */
export function QualityBadge() {
  const t = useT();
  const kbps = useVoice((s) => s.limits?.audio_bitrate_kbps);
  if (!kbps) return null;
  const preset = presetOf(kbps);
  const name = preset === "custom" ? t("voice.quality.kbps", { kbps }) : t(`voice.quality.preset.${preset}`);
  const title = isMusic(kbps) ? t("voice.quality.badge_music", { name, kbps, mb: trafficMbPerHour(kbps) }) : t("voice.quality.badge", { name, kbps });
  return (
    <span className="shrink-0 rounded border border-line px-1 text-[10px] font-medium leading-4 text-fg-2" title={title} aria-label={title} data-testid="voice-quality" data-kbps={kbps}>
      {name}
    </span>
  );
}
