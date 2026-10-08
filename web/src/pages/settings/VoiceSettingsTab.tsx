// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useT } from "../../i18n";
import { publicApi } from "../../lib/api";
import { Button, Field } from "../../components/ui";
import { toastError } from "../../stores/toasts";
import { Section, Select } from "./common";
import { gateThreshold, limitResolution, resolutionSize, useVoiceSettings, type BackgroundMode, type BackgroundQuality, type NoiseSuppression, type Resolution, type VoiceSettings } from "../../voice/settings";
import type { BackgroundHandle } from "../../voice/background";
import { levelToUnit } from "../../voice/gate";
import { useVoice } from "../../voice/store";
import type { MicPipeline } from "../../voice/audio";
import { LOOPBACK_MAX_MS, Loopback, type LoopbackState, type LoopbackStopReason } from "../../voice/loopback";
import { CUES, RING_LOOP, previewCue, startRingtone } from "../../voice/cues";
import { ConnectionTestPanel } from "../../voice/ui/ConnectionTestPanel";
import { platform } from "../../platform";
import { MoreHotkeysSection } from "./MoreHotkeysSection";
import { HotkeyRecorder } from "./HotkeyRecorder";
import { useMediaDevices } from "../../voice/devices";

function DeviceSelect({ label, kind, devices, value, onChange, onFocus, testid }: { label: string; kind: MediaDeviceKind; devices: MediaDeviceInfo[]; value: string; onChange: (id: string) => void; onFocus?: () => void; testid: string }) {
  const t = useT();
  return (
    <Field label={label}>
      <Select value={value} onChange={(e) => onChange(e.target.value)} onFocus={onFocus} onPointerDown={onFocus} data-testid={testid}>
        <option value="">{t("voice.settings.default_device")}</option>
        {devices
          .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== "default")
          .map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `${label} ${i + 1}`}
            </option>
          ))}
      </Select>
    </Field>
  );
}

function Slider({ label, value, min, max, step = 1, unit, onChange, testid }: { label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (v: number) => void; testid?: string }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="flex justify-between text-fg-1">
        {label}
        <span className="tabular-nums text-fg-2">
          {value} {unit}
        </span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full" aria-label={label} aria-valuetext={`${value} ${unit}`} data-testid={testid} />
    </label>
  );
}

function Check({ label, checked, onChange, hint, testid }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string; testid?: string }) {
  return (
    <label className="flex min-h-9 items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1 h-4 w-4" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testid} />
      <span>
        {label}
        {hint && <span className="block text-xs text-fg-2">{hint}</span>}
      </span>
    </label>
  );
}

/** `m:ss` of a duration. */
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Live microphone check: the same pipeline as in a call (noise suppression, gate), a level meter with the
 * voice activation threshold and the "transmitting" light, "hear yourself" (the processed microphone played
 * back live, `loopback.ts`) and a five-second test recording.
 */
function MicCheck({ settings, onPermission }: { settings: VoiceSettings; onPermission: () => void }) {
  const t = useT();
  const [pipeline, setPipeline] = useState<MicPipeline | null>(null);
  const [level, setLevel] = useState(-Infinity);
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [playback, setPlayback] = useState<string | null>(null);
  const [loopState, setLoopState] = useState<LoopbackState | null>(null);
  const inVoice = useVoice((s) => s.status !== "idle");
  const audio = useRef<HTMLAudioElement>(null);
  const live = useRef<MicPipeline | null>(null);
  const loop = useRef<Loopback | null>(null);

  const stop = useCallback(async (reason: LoopbackStopReason = "user") => {
    loop.current?.stop(reason);
    const p = live.current;
    live.current = null;
    setPipeline(null);
    setLevel(-Infinity);
    setOpen(false);
    await p?.close();
  }, []);
  // Leaving the settings ends the microphone check and the loopback.
  useEffect(() => () => void stop("unmount"), [stop]);
  useEffect(() => {
    void pipeline?.apply(settings).catch(toastError);
  }, [pipeline, settings]);
  useEffect(() => loop.current?.setVolume(settings.outputVolume / 100), [settings.outputVolume]);
  useEffect(() => void loop.current?.setOutputDevice(settings.outputDeviceId), [settings.outputDeviceId]);
  useEffect(() => () => void (playback && URL.revokeObjectURL(playback)), [playback]);

  const start = async (): Promise<MicPipeline | null> => {
    try {
      const { MicPipeline } = await import("../../voice/audio");
      const p = await MicPipeline.create(settings, (r) => {
        setLevel(r.level);
        setOpen(r.open);
      });
      live.current = p;
      setPipeline(p);
      onPermission();
      return p;
    } catch (e) {
      toastError(e);
      return null;
    }
  };

  const hearYourself = async () => {
    const p = live.current ?? (await start());
    if (!p) return;
    loop.current ??= new Loopback(setLoopState);
    try {
      await loop.current.start(p.track, { outputDeviceId: settings.outputDeviceId, volume: settings.outputVolume / 100 });
    } catch (e) {
      toastError(e);
    }
  };

  const record = async () => {
    const p = live.current;
    if (!p || typeof MediaRecorder === "undefined") return;
    const rec = new MediaRecorder(new MediaStream([p.track]));
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = () => {
      setRecording(false);
      setPlayback(URL.createObjectURL(new Blob(chunks, { type: rec.mimeType })));
    };
    setRecording(true);
    rec.start();
    setTimeout(() => rec.state === "recording" && rec.stop(), 5000);
  };

  useEffect(() => {
    const el = audio.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (el && playback) void el.setSinkId?.(settings.outputDeviceId).catch(() => undefined);
  }, [playback, settings.outputDeviceId]);

  const threshold = gateThreshold(settings);
  return (
    <div className="space-y-2" data-testid="mic-check">
      <div className="flex flex-wrap items-center gap-2">
        {pipeline ? (
          <Button variant="ghost" onClick={() => void stop("user")} data-testid="mic-check-stop">
            {t("voice.settings.mic_stop")}
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => void start()} data-testid="mic-check-start">
            {t("voice.settings.mic_start")}
          </Button>
        )}
        {loopState?.running ? (
          <Button variant="ghost" onClick={() => loop.current?.stop("user")} data-testid="mic-loopback-stop">
            {t("voice.settings.loopback_stop")}
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => void hearYourself()} disabled={inVoice} data-testid="mic-loopback">
            {t("voice.settings.loopback")}
          </Button>
        )}
        {loopState?.running && (
          <span role="timer" className="tabular-nums text-xs text-fg-1" aria-label={t("voice.settings.loopback_timer")} data-testid="loopback-timer">
            {clock(loopState.elapsedMs)} / {clock(LOOPBACK_MAX_MS)}
          </span>
        )}
        {pipeline && (
          <Button variant="ghost" onClick={() => void record()} disabled={recording} data-testid="mic-record">
            {recording ? t("voice.settings.recording") : t("voice.settings.record")}
          </Button>
        )}
        <span className={`flex items-center gap-1.5 text-xs ${open && pipeline ? "text-ok" : "text-fg-2"}`} data-testid="vad-indicator" data-open={(open && !!pipeline) || undefined}>
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${open && pipeline ? "bg-ok" : "bg-bg-3"}`} />
          {t("voice.settings.transmitting")}
        </span>
      </div>
      <div className="relative h-3 overflow-hidden rounded-full bg-bg-0" role="meter" aria-label={t("voice.settings.mic_level")} aria-valuemin={-100} aria-valuemax={0} aria-valuenow={Number.isFinite(level) ? Math.round(level) : -100} aria-valuetext={`${Number.isFinite(level) ? Math.round(level) : -100} dB`} data-testid="mic-meter" data-level={Number.isFinite(level) ? Math.round(level) : -100}>
        <div className="h-full rounded-full bg-accent transition-[width] duration-100" style={{ width: `${levelToUnit(level) * 100}%` }} />
        {threshold !== null && <div className="absolute inset-y-0 w-0.5 bg-warn" style={{ left: `${levelToUnit(threshold) * 100}%` }} title={t("voice.settings.threshold")} />}
      </div>
      <p className="text-xs text-fg-2">{t("voice.settings.loopback_hint")}</p>
      {inVoice && (
        <p className="text-xs text-fg-2" data-testid="loopback-busy">
          {t("voice.settings.loopback_busy")}
        </p>
      )}
      {loopState?.running && loopState.feedback && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn/10 p-2 text-xs text-fg-1" data-testid="loopback-feedback">
          <span className="min-w-0 flex-1">{t("voice.settings.loopback_feedback")}</span>
          <Button variant="ghost" onClick={() => loop.current?.resume()} data-testid="loopback-resume">
            {t("voice.settings.loopback_resume")}
          </Button>
        </div>
      )}
      {!loopState?.running && (loopState?.stopped === "timeout" || loopState?.stopped === "voice") && (
        <p role="status" className="text-xs text-fg-2" data-testid="loopback-stopped" data-reason={loopState.stopped}>
          {t(`voice.settings.loopback_stopped_${loopState.stopped}`)}
        </p>
      )}
      {playback && <audio ref={audio} src={playback} controls className="w-full" data-testid="mic-playback" />}
    </div>
  );
}

/** One second of a 440 Hz tone on the chosen output device. */
async function testTone(outputDeviceId: string, volume: number) {
  const ctx = new AudioContext() as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  try {
    if (outputDeviceId) await ctx.setSinkId?.(outputDeviceId).catch(() => undefined);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.2 * volume, ctx.currentTime + 0.05);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1);
    osc.frequency.value = 440;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 1);
    await new Promise((r) => setTimeout(r, 1100));
  } finally {
    await ctx.close();
  }
}

/** Downscales an image to at most 1280 px and returns a JPEG data URL (kept per device). */
async function backgroundDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** Camera preview with the resolution, mirror and background effect of the settings. */
function CameraPreview({ settings, max }: { settings: VoiceSettings; max: { max_resolution: string; max_fps: number } }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = `${settings.cameraDeviceId}|${settings.cameraResolution}|${settings.cameraFps}|${settings.background}|${settings.backgroundImage?.length ?? 0}|${settings.backgroundQuality}`;
  // The blur strength changes live, without restarting the camera.
  const effect = useRef<BackgroundHandle | null>(null);
  useEffect(() => {
    void effect.current?.setBlur(settings.blurStrength).catch(() => undefined);
  }, [settings.blurStrength]);
  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let cleanup: (() => void) | null = null;
    void (async () => {
      try {
        const { createLocalVideoTrack } = await import("livekit-client");
        const size = resolutionSize(limitResolution(settings.cameraResolution, max.max_resolution));
        const track = await createLocalVideoTrack({ ...(settings.cameraDeviceId ? { deviceId: settings.cameraDeviceId } : {}), resolution: { ...size, frameRate: Math.min(settings.cameraFps, max.max_fps) } });
        if (stopped) return track.stop();
        let bg: BackgroundHandle | null = null;
        if (settings.background !== "none") {
          const { applyBackground } = await import("../../voice/background");
          bg = await applyBackground(track, useVoiceSettings.getState().settings, (slow) => {
            void bg?.stop();
            effect.current = null;
            useVoice.setState({ backgroundAutoOff: slow });
          }).catch((e: unknown) => {
            setError(e instanceof Error ? e.message : String(e));
            return null;
          });
        }
        effect.current = bg;
        if (video.current) track.attach(video.current);
        cleanup = () => {
          effect.current = null;
          void bg?.stop();
          track.stop();
        };
        if (stopped) cleanup();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setOn(false);
      }
    })();
    return () => {
      stopped = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, key]);
  return (
    <div className="space-y-2">
      <div className="relative aspect-video w-full max-w-md overflow-hidden rounded-lg bg-bg-0">
        {on ? <video ref={video} autoPlay playsInline muted className="h-full w-full object-cover" style={settings.mirror ? { transform: "scaleX(-1)" } : undefined} data-testid="camera-preview" /> : <p className="flex h-full items-center justify-center text-xs text-fg-2">{t("voice.settings.camera_off")}</p>}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <Button variant="ghost" onClick={() => setOn((v) => !v)} data-testid="camera-preview-toggle">
        {on ? t("voice.settings.preview_stop") : t("voice.settings.preview_start")}
      </Button>
    </div>
  );
}

const STATIC_IMAGES = ["image/png", "image/jpeg", "image/webp"];

/**
 * Voice & video settings (design note 4.9): devices with a level meter, test recording and test tone, input
 * processing, voice activation or push-to-talk, camera with preview and background effects, per-user
 * volumes. Kept per device and applied live to a running call.
 */
export function VoiceSettingsTab() {
  const t = useT();
  const settings = useVoiceSettings((s) => s.settings);
  const update = useVoiceSettings((s) => s.update);
  const setUserVolume = useVoiceSettings((s) => s.setUserVolume);
  const setStreamVolume = useVoiceSettings((s) => s.setStreamVolume);
  const autoOff = useVoice((s) => s.backgroundAutoOff);
  const [refresh, setRefresh] = useState(0);
  // The desktop app's window holds the microphone permission: the device names come without a prompt.
  const media = useMediaDevices({ autoUnlock: platform().isDesktop, refresh });
  const unlockDevices = media.needsPermission ? () => void media.unlock() : undefined;
  const [bgNote, setBgNote] = useState<string | null>(null);
  const node = useQuery({ queryKey: ["node", "origin"], queryFn: () => publicApi.node.info(), staleTime: 10 * 60_000 });
  const camera = node.data?.voice?.camera ?? { enabled: true, max_resolution: "720p", max_fps: 30 };
  const sinkSupported = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
  const cameraResolutions = (["360p", "720p", "1080p"] as Resolution[]).filter((r) => limitResolution(r, camera.max_resolution) === r);
  const fpsChoices = [15, 24, 30, 60].filter((f) => f <= camera.max_fps);

  const levels: { id: NoiseSuppression; label: string; hint: string }[] = [
    { id: "off", label: t("voice.settings.ns_off"), hint: t("voice.settings.ns_off_hint") },
    { id: "browser", label: t("voice.settings.ns_browser"), hint: t("voice.settings.ns_browser_hint") },
    { id: "rnnoise", label: t("voice.settings.ns_rnnoise"), hint: t("voice.settings.ns_rnnoise_hint") },
  ];
  const backgrounds: { id: BackgroundMode; label: string }[] = [
    { id: "none", label: t("voice.settings.bg_none") },
    { id: "blur", label: t("voice.settings.bg_blur") },
    { id: "image", label: t("voice.settings.bg_image") },
  ];

  return (
    <div className="space-y-4" data-testid="voice-settings">
      <Section title={t("voice.settings.devices")} description={t("voice.settings.devices_hint")}>
        <div className="grid gap-3 md:grid-cols-2">
          <DeviceSelect label={t("voice.settings.microphone")} kind="audioinput" devices={media.devices} value={settings.inputDeviceId} onChange={(id) => update({ inputDeviceId: id })} onFocus={unlockDevices} testid="mic-select" />
          {sinkSupported ? (
            <DeviceSelect label={t("voice.settings.speaker")} kind="audiooutput" devices={media.devices} value={settings.outputDeviceId} onChange={(id) => update({ outputDeviceId: id })} onFocus={unlockDevices} testid="speaker-select" />
          ) : (
            <p className="text-xs text-fg-2">{t("voice.settings.speaker_system")}</p>
          )}
        </div>
        {media.needsPermission && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-fg-2" data-testid="devices-hidden">
            <span className="min-w-0 flex-1 basis-48">{t("voice.settings.devices_hidden")}</span>
            <Button variant="ghost" onClick={() => void media.unlock()} data-testid="devices-unlock">
              {t("voice.settings.devices_show")}
            </Button>
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <Slider label={t("voice.settings.input_volume")} value={settings.inputVolume} min={0} max={200} step={5} unit="%" onChange={(v) => update({ inputVolume: v })} />
          <Slider label={t("voice.settings.output_volume")} value={settings.outputVolume} min={0} max={200} step={5} unit="%" onChange={(v) => update({ outputVolume: v })} />
        </div>
        <MicCheck settings={settings} onPermission={() => setRefresh((r) => r + 1)} />
        <Button variant="ghost" onClick={() => void testTone(settings.outputDeviceId, settings.outputVolume / 100).catch(toastError)} data-testid="speaker-test">
          {t("voice.settings.test_tone")}
        </Button>
      </Section>

      <Section title={t("voice.test.title")} description={t("voice.test.description")}>
        <ConnectionTestPanel />
      </Section>

      <Section title={t("voice.settings.processing")}>
        <Check label={t("voice.settings.auto_gain")} checked={settings.autoGain} onChange={(v) => update({ autoGain: v })} />
        <Check label={t("voice.settings.echo")} checked={settings.echoCancellation} onChange={(v) => update({ echoCancellation: v })} />
        <fieldset className="space-y-1">
          <legend className="text-sm text-fg-1">{t("voice.settings.noise_suppression")}</legend>
          {levels.map((l) => (
            <label key={l.id} className="flex min-h-9 items-start gap-2 text-sm">
              <input type="radio" name="ns" className="mt-1 h-4 w-4" checked={settings.noiseSuppression === l.id} onChange={() => update({ noiseSuppression: l.id })} data-testid={`ns-${l.id}`} />
              <span>
                {l.label}
                <span className="block text-xs text-fg-2">{l.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Check label={t("voice.settings.noise_gate")} hint={t("voice.settings.noise_gate_hint")} checked={settings.noiseGate} onChange={(v) => update({ noiseGate: v })} testid="noise-gate" />
        {settings.noiseGate && <Slider label={t("voice.settings.gate_threshold")} value={settings.gateThreshold} min={-100} max={0} unit="dB" onChange={(v) => update({ gateThreshold: v })} />}
      </Section>

      <Section title={t("voice.settings.input_mode")}>
        <div className="flex flex-wrap gap-4">
          <label className="flex min-h-9 items-center gap-2 text-sm">
            <input type="radio" name="mode" className="h-4 w-4" checked={settings.inputMode === "vad"} onChange={() => update({ inputMode: "vad" })} data-testid="mode-vad" />
            {t("voice.settings.vad")}
          </label>
          <label className="flex min-h-9 items-center gap-2 text-sm">
            <input type="radio" name="mode" className="h-4 w-4" checked={settings.inputMode === "ptt"} onChange={() => update({ inputMode: "ptt" })} data-testid="mode-ptt" />
            {t("voice.settings.ptt")}
          </label>
        </div>
        {settings.inputMode === "vad" ? (
          <Slider label={t("voice.settings.threshold")} value={settings.vadThreshold} min={-100} max={0} unit="dB" onChange={(v) => update({ vadThreshold: v })} testid="vad-threshold" />
        ) : (
          <div className="space-y-3" data-testid="ptt-settings">
            <HotkeyRecorder action="push_to_talk" label={t("voice.settings.ptt_key")} removable={false} testid={{ key: "ptt-key", change: "ptt-capture" }} />
            <Slider label={t("voice.settings.ptt_release")} value={settings.pttReleaseMs} min={0} max={2000} step={50} unit="ms" onChange={(v) => update({ pttReleaseMs: v })} />
            <p className="text-xs text-fg-2">{t("voice.settings.ptt_hint")}</p>
          </div>
        )}
      </Section>

      <Section title={t("voice.settings.priority")} description={t("voice.settings.priority_hint")}>
        <div data-testid="priority-settings">
          <HotkeyRecorder action="priority" label={t("voice.settings.priority_key")} testid={{ key: "priority-key", change: "priority-capture", remove: "priority-clear" }} />
        </div>
      </Section>

      <MoreHotkeysSection />

      <Section title={t("voice.settings.video")} description={camera.enabled ? t("voice.settings.video_hint", { resolution: camera.max_resolution, fps: camera.max_fps }) : t("voice.settings.camera_disabled")}>
        <div className="grid gap-3 md:grid-cols-3">
          <DeviceSelect label={t("voice.settings.camera")} kind="videoinput" devices={media.devices} value={settings.cameraDeviceId} onChange={(id) => update({ cameraDeviceId: id })} testid="camera-select" />
          <Field label={t("voice.settings.resolution")}>
            <Select value={limitResolution(settings.cameraResolution, camera.max_resolution)} onChange={(e) => update({ cameraResolution: e.target.value as Resolution })}>
              {cameraResolutions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("voice.settings.fps")}>
            <Select value={Math.min(settings.cameraFps, camera.max_fps)} onChange={(e) => update({ cameraFps: Number(e.target.value) })}>
              {fpsChoices.map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Check label={t("voice.settings.mirror")} checked={settings.mirror} onChange={(v) => update({ mirror: v })} />
        <fieldset className="space-y-1">
          <legend className="text-sm text-fg-1">{t("voice.settings.background")}</legend>
          <div className="flex flex-wrap gap-4">
            {backgrounds.map((b) => (
              <label key={b.id} className="flex min-h-9 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="bg"
                  className="h-4 w-4"
                  checked={settings.background === b.id}
                  disabled={b.id === "image" && !settings.backgroundImage}
                  onChange={() => {
                    useVoice.setState({ backgroundAutoOff: null });
                    update({ background: b.id });
                  }}
                  data-testid={`bg-${b.id}`}
                />
                {b.label}
              </label>
            ))}
          </div>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"
            aria-label={t("voice.settings.bg_upload")}
            data-testid="bg-upload"
            className="block w-full text-sm text-fg-1 file:mr-2 file:rounded-md file:border-0 file:bg-bg-3 file:px-3 file:py-2 file:text-fg-0"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              // Animated backgrounds (GIF, short videos) need the node's media pipeline (phase 4C).
              if (!STATIC_IMAGES.includes(file.type)) {
                setBgNote(t("voice.settings.bg_animated_soon"));
                return;
              }
              setBgNote(null);
              try {
                update({ backgroundImage: await backgroundDataUrl(file), background: "image" });
              } catch (err) {
                toastError(err);
              }
            }}
          />
          {bgNote && (
            <p className="text-xs text-warn" data-testid="bg-note">
              {bgNote}
            </p>
          )}
          {settings.background === "blur" && (
            <Slider label={t("voice.settings.blur_strength")} value={settings.blurStrength} min={0} max={100} step={5} unit="%" onChange={(v) => update({ blurStrength: v })} testid="blur-strength" />
          )}
          {settings.background !== "none" && (
            <Field label={t("voice.settings.bg_quality")}>
              <Select value={settings.backgroundQuality} onChange={(e) => update({ backgroundQuality: e.target.value as BackgroundQuality })} data-testid="bg-quality">
                {(["fast", "balanced", "high"] as const).map((q) => (
                  <option key={q} value={q}>
                    {t(`voice.settings.bg_quality_${q}`)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {settings.background !== "none" && <p className="text-xs text-fg-2">{t(`voice.settings.bg_quality_${settings.backgroundQuality}_hint`)}</p>}
          <p className="text-xs text-fg-2">{t("voice.settings.bg_performance")}</p>
          <p className="text-xs text-fg-2" data-testid="bg-limits">
            {t("voice.settings.bg_limits")}
          </p>
          {autoOff && (
            <div role="status" className="space-y-2 rounded-md border border-warn/40 bg-warn/10 p-2 text-xs text-fg-1" data-testid="bg-auto-off">
              <p>{t("voice.settings.background_auto_off", { ms: autoOff.averageMs, budget: autoOff.budgetMs, fps: autoOff.fps })}</p>
              <div className="flex flex-wrap gap-2">
                {settings.backgroundQuality !== "fast" && (
                  <Button variant="ghost" onClick={() => {
                    useVoice.setState({ backgroundAutoOff: null });
                    update({ backgroundQuality: "fast" });
                  }} data-testid="bg-auto-off-fast">
                    {t("voice.settings.bg_retry_fast")}
                  </Button>
                )}
                <Button variant="ghost" onClick={() => useVoice.setState({ backgroundAutoOff: null })}>
                  {t("common.close")}
                </Button>
              </div>
            </div>
          )}
        </fieldset>
        {camera.enabled && <CameraPreview settings={settings} max={camera} />}
      </Section>

      <Section title={t("voice.settings.cues")} description={t("voice.settings.cues_hint")}>
        <Check label={t("voice.settings.cues_off")} checked={settings.cuesOff} onChange={(v) => update({ cuesOff: v })} testid="cues-off" />
        <Slider label={t("voice.settings.cue_volume")} value={settings.cueVolume} min={0} max={100} step={5} unit="%" onChange={(v) => update({ cueVolume: v })} testid="cue-volume" />
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <Slider label={t("voice.settings.ring_volume")} value={settings.ringVolume} min={0} max={100} step={5} unit="%" onChange={(v) => update({ ringVolume: v })} testid="ring-volume" />
          </div>
          <Button variant="ghost" onClick={() => {
            const stop = startRingtone("direct");
            setTimeout(stop, 2 * RING_LOOP * 1000);
          }} data-testid="ring-preview">
            ▶ {t("voice.settings.ring_preview")}
          </Button>
        </div>
        <ul className="grid gap-1 sm:grid-cols-2" data-testid="cue-list">
          {CUES.map((cue) => (
            <li key={cue} className="flex min-h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={!settings.cuesOff && !settings.cuesDisabled.includes(cue)}
                disabled={settings.cuesOff}
                onChange={(e) => update({ cuesDisabled: e.target.checked ? settings.cuesDisabled.filter((c) => c !== cue) : [...settings.cuesDisabled, cue] })}
                aria-label={t(`voice.cue.${cue}`)}
                data-testid={`cue-${cue}`}
              />
              <span className="min-w-0 flex-1 truncate">{t(`voice.cue.${cue}`)}</span>
              <button type="button" className="min-h-8 min-w-8 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0" onClick={() => previewCue(cue)} aria-label={t("voice.settings.cue_preview", { name: t(`voice.cue.${cue}`) })} title={t("voice.settings.cue_preview", { name: t(`voice.cue.${cue}`) })}>
                ▶
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t("voice.settings.user_volumes")} description={t("voice.settings.user_volumes_hint")}>
        <Check label={t("voice.settings.stream_while_deafened")} hint={t("voice.settings.stream_while_deafened_hint")} checked={settings.streamWhileDeafened} onChange={(v) => update({ streamWhileDeafened: v })} testid="stream-while-deafened" />
        {Object.keys(settings.userVolumes).length === 0 && Object.keys(settings.streamVolumes).length === 0 ? (
          <p className="text-sm text-fg-2">{t("voice.settings.user_volumes_none")}</p>
        ) : (
          <ul className="divide-y divide-line" data-testid="volume-list">
            {Object.entries(settings.userVolumes).map(([address, volume]) => (
              <li key={`v-${address}`} className="flex min-h-10 items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">{address}</span>
                <span className="tabular-nums text-fg-2">{t("voice.settings.voice_volume_entry", { volume })}</span>
                <Button variant="ghost" onClick={() => setUserVolume(address, 100)}>
                  {t("voice.settings.reset")}
                </Button>
              </li>
            ))}
            {Object.entries(settings.streamVolumes).map(([address, volume]) => (
              <li key={`s-${address}`} className="flex min-h-10 items-center gap-3 text-sm" data-testid="stream-volume-entry">
                <span className="min-w-0 flex-1 truncate">{address}</span>
                <span className="tabular-nums text-fg-2">{t("voice.settings.stream_volume_entry", { volume })}</span>
                <Button variant="ghost" onClick={() => setStreamVolume(address, 100)}>
                  {t("voice.settings.reset")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
