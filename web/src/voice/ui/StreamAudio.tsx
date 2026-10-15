// SPDX-License-Identifier: Apache-2.0
/**
 * Stream audio on a screen share tile (issue #20): the stream's own volume (per streamer, kept like the voice
 * volume) behind a speaker button, and a badge while the user is deafened but the watched stream still plays.
 */
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useVoiceSettings } from "../settings";
import { useVoice } from "../store";
import { SpeakerIcon } from "./icons";
import { useDismiss } from "../../lib/dismiss";

/** A labelled range input showing its value (volumes, thresholds); it keeps the value while it is dragged. */
export function RangeSlider({ label, value, onChange, testid, min, max, step, unit }: { label: string; value: number; onChange: (v: number) => void; testid?: string; min: number; max: number; step: number; unit: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="block space-y-1 text-sm" data-testid={testid}>
      <span className="flex justify-between gap-2 text-fg-1">
        {label} <span className="tabular-nums text-fg-2">{`${v} ${unit}`}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        aria-label={label}
        aria-valuetext={`${v} ${unit}`}
        className="w-full"
        onChange={(e) => {
          const next = Number(e.target.value);
          setV(next);
          onChange(next);
        }}
      />
    </label>
  );
}

/** A 0–200 % volume slider bound to a per-user volume of the settings. */
export function VolumeSlider(props: { label: string; value: number; onChange: (v: number) => void; testid?: string }) {
  return <RangeSlider {...props} min={0} max={200} step={5} unit="%" />;
}

/** The speaker button of a stream tile with its volume popover, and the "still audible while deafened" badge. */
export function StreamAudioControls({ address, name }: { address: string; name: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const volume = useVoiceSettings((s) => s.settings.streamVolumes[address] ?? 100);
  const setVolume = useVoiceSettings((s) => s.setStreamVolume);
  const keepsPlaying = useVoiceSettings((s) => s.settings.streamWhileDeafened);
  const deafened = useVoice((s) => s.deafened);
  const wrapper = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useDismiss(open, () => setOpen(false), { inside: [wrapper], returnFocus: button });
  const audible = deafened && keepsPlaying;
  const label = t("voice.stream.volume", { name });
  return (
    <span ref={wrapper} className="relative flex items-center gap-1.5">
      {audible && (
        <span role="img" className="flex min-h-8 items-center gap-1 rounded-md bg-accent px-1.5 text-[11px] text-accent-text" aria-label={t("voice.stream.audible")} title={t("voice.stream.audible")} data-testid="stream-audible">
          <SpeakerIcon size={14} />
        </span>
      )}
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="min-h-8 min-w-8 rounded-md bg-black/60 text-fg-0"
        aria-label={label}
        aria-expanded={open}
        title={label}
        data-testid="stream-volume-button"
        data-volume={volume}
      >
        <SpeakerIcon size={16} className={`mx-auto ${volume === 0 ? "opacity-50" : ""}`} />
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-20 w-56 max-w-[80vw] rounded-md border border-line bg-bg-1 p-2 shadow-lg" data-testid="stream-volume-panel">
          <VolumeSlider label={t("voice.stream.volume_label")} value={volume} onChange={(v) => setVolume(address, v)} testid="stream-volume" />
        </div>
      )}
    </span>
  );
}
