// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useNavigate } from "react-router";
import { Permission, hasPermission, type Channel, type RoomDetail } from "@tavrn/sdk";
import { useT } from "../../i18n";
import { Button, Dialog } from "../../components/ui";
import { useVoiceSettings } from "../settings";
import { useVoice } from "../store";
import { useVoiceEngine } from "../engine";
import { leaveVoice, playSound, pushToTalk, startScreenShare, stopScreenShare, toggleCamera, toggleDeafen, toggleMute } from "../index";
import { useSoundboard } from "../useVoiceRealtime";
import { useNode } from "../../components/NodeScope";
import { InlineEmoji } from "../../components/InlineEmoji";
import { useExternalSounds, type ExternalSound } from "../../lib/sounds";
import { ControlButton } from "./VoiceBar";
import { PriorityButton } from "./PriorityButton";
import { useVoiceDeviceMenu } from "./VoiceDeviceMenu";
import { AudioRouteButton } from "./AudioRouteButton";
import { WhiteboardControl } from "../../whiteboard/WhiteboardStage";
import { beforeScreenShare } from "../../whiteboard/stage";
import { platform } from "../../platform";
import { GearIcon, HeadphonesIcon, HeadphonesOffIcon, LeaveIcon, MicIcon, MicOffIcon, ScreenIcon, SoundboardIcon, VideoIcon } from "./icons";

const SCREEN_RESOLUTIONS = ["720p", "1080p", "1440p", "4k"];
const FRAME_RATES = [5, 15, 30, 60];

/**
 * Screen share options before the browser's own source picker (screen, window or tab). In the Android app the whole
 * screen is shared after Android's own consent dialog (VOICE.md §4b); the sound of other apps is off by default there
 * and needs Android 10 or newer.
 */
export function ScreenShareDialog({ open, onClose, maxResolution, maxFps }: { open: boolean; onClose: () => void; maxResolution: string; maxFps: number }) {
  const t = useT();
  const android = platform().android?.screenShare;
  const allowed = SCREEN_RESOLUTIONS.slice(0, Math.max(1, SCREEN_RESOLUTIONS.indexOf(maxResolution) + 1));
  const rates = FRAME_RATES.filter((f) => f <= maxFps);
  const [resolution, setResolution] = useState(allowed.includes("1080p") ? "1080p" : allowed.at(-1)!);
  const [fps, setFps] = useState(rates.includes(30) ? 30 : (rates.at(-1) ?? maxFps));
  const [audio, setAudio] = useState(!android);
  const audioAvailable = !android || android.audio;
  return (
    <Dialog title={t("voice.screen.title")} open={open} onClose={onClose}>
      <div className="space-y-3 text-sm" data-testid="screen-share-dialog" data-native={android ? "android" : undefined}>
        <p className="text-xs text-fg-2">{t(android ? "voice.screen.hint_android" : "voice.screen.hint")}</p>
        <label className="block space-y-1">
          <span className="text-fg-1">{t("voice.screen.resolution")}</span>
          <select value={resolution} onChange={(e) => setResolution(e.target.value)} className="min-h-10 w-full rounded-md border border-line-strong bg-bg-0 px-3" aria-label={t("voice.screen.resolution")}>
            {allowed.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-fg-1">{t("voice.screen.fps")}</span>
          <select value={fps} onChange={(e) => setFps(Number(e.target.value))} className="min-h-10 w-full rounded-md border border-line-strong bg-bg-0 px-3" aria-label={t("voice.screen.fps")}>
            {(rates.length ? rates : [maxFps]).map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-h-9 items-center gap-2">
          <input type="checkbox" checked={audio && audioAvailable} disabled={!audioAvailable} onChange={(e) => setAudio(e.target.checked)} className="h-4 w-4" aria-describedby={audioAvailable ? undefined : "screen-audio-unavailable"} data-testid="screen-share-audio" />
          {t(android ? "voice.screen.audio_android" : "voice.screen.audio")}
        </label>
        {!audioAvailable && (
          <p id="screen-audio-unavailable" className="text-xs text-fg-2">
            {t("voice.screen.audio_android_unavailable")}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            data-testid="screen-share-start"
            onClick={() => {
              onClose();
              void startScreenShare({ audio: audio && audioAvailable, resolution, fps });
            }}
          >
            {t(android ? "voice.screen.start_android" : "voice.screen.start")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The room's clips, the personal ones and those of the other rooms (design note 4.13); a click plays one into the
 * own microphone track (VOICE.md §8). Clips that are not the room's need `use_external_sounds`: without it they
 * are greyed out with the reason as tooltip.
 */
function SoundboardDialog({ open, onClose, roomId, disabled, external }: { open: boolean; onClose: () => void; roomId: string; disabled: boolean; external: boolean }) {
  const t = useT();
  const { domain } = useNode();
  const sounds = useSoundboard(roomId, open);
  const others = useExternalSounds(roomId, open);
  const denied = t("voice.soundboard.external_denied");
  const groups: { title: string; items: ExternalSound[] }[] = [];
  if (others.personal.length) groups.push({ title: t("voice.soundboard.personal"), items: others.personal });
  const byRoom = new Map<string, ExternalSound[]>();
  for (const s of others.other) byRoom.set(`${s.roomName ?? "?"}\u0000${s.roomId}`, [...(byRoom.get(`${s.roomName ?? "?"}\u0000${s.roomId}`) ?? []), s]);
  for (const [key, items] of byRoom) groups.push({ title: key.split("\u0000")[0]!, items });
  return (
    <Dialog title={t("voice.soundboard.title")} open={open} onClose={onClose}>
      <div className="max-h-[70vh] space-y-3 overflow-y-auto" data-testid="soundboard-panel">
        {disabled && <p className="text-xs text-warn">{t("voice.soundboard.muted")}</p>}
        {sounds.data?.length === 0 && <p className="text-sm text-fg-2">{t("voice.soundboard.empty")}</p>}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {sounds.data?.map((s) => (
            <Button key={s.id} variant="ghost" className="justify-start border border-line" disabled={disabled} onClick={() => void playSound(s)} data-testid="soundboard-clip">
              {s.emoji ? <InlineEmoji value={s.emoji} node={domain} size={18} /> : "▶"} <span className="truncate">{s.name}</span>
            </Button>
          ))}
        </div>
        {groups.map((g) => (
          <section key={g.title} aria-label={g.title} data-testid="soundboard-group">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-2">{g.title}</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {g.items.map((s) => (
                <Button
                  key={`${s.source}:${s.id}`}
                  variant="ghost"
                  className={`justify-start border border-line ${external ? "" : "cursor-not-allowed opacity-40 grayscale"}`}
                  disabled={disabled}
                  aria-disabled={!external || undefined}
                  title={external ? s.name : denied}
                  onClick={() => external && void playSound({ id: s.id, node: s.node, emoji: s.emoji })}
                  data-testid="soundboard-external-clip"
                >
                  {s.emoji ? <InlineEmoji value={s.emoji} node={domain} owner={s.node} size={18} /> : "▶"} <span className="truncate">{s.name}</span>
                </Button>
              ))}
            </div>
          </section>
        ))}
        {!external && groups.length > 0 && <p className="text-xs text-fg-2" data-testid="soundboard-external-note">{denied}</p>}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Call controls (VOICE.md §9): mute, deafen, the audio output (Android app), camera and screen share (only when
 * `limits` allow them), soundboard (with `use_soundboard` and `speak`), settings and leave; push-to-talk as a hold
 * button when that mode is on. The microphone, headphones and camera buttons have quick menus (long press,
 * right-click). A bottom bar on phones.
 */
export function VoiceControls({ room, channel, perms }: { room: RoomDetail; channel: Channel; perms: bigint }) {
  const t = useT();
  const navigate = useNavigate();
  const muted = useVoice((s) => s.muted);
  const mutedTalk = useVoice((s) => s.mutedTalk);
  const deafened = useVoice((s) => s.deafened);
  const camera = useVoice((s) => s.camera);
  // The webview's own share, or the Android app's through the shell (starting counts: a second tap stops it).
  const screen = useVoice((s) => s.screen || s.nativeScreen !== null);
  const limits = useVoice((s) => s.limits);
  const canSpeak = useVoice((s) => s.canSpeak);
  const transmitting = useVoice((s) => s.transmitting);
  const ptt = useVoiceSettings((s) => s.settings.inputMode === "ptt");
  const micMenu = useVoiceDeviceMenu("input");
  const outputMenu = useVoiceDeviceMenu("output");
  const cameraMenu = useVoiceDeviceMenu("camera");
  const [screenOpen, setScreenOpen] = useState(false);
  const [soundsOpen, setSoundsOpen] = useState(false);
  const soundboard = hasPermission(perms, Permission.USE_SOUNDBOARD) && hasPermission(perms, Permission.SPEAK);
  // The native voice engine (desktop app on Linux, or the Windows setting) is audio only in this version.
  const nativeOnly = useVoiceEngine((s) => s.kind === "native") ? t("voice.native.unavailable") : undefined;
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-1 border-t border-line bg-bg-1 px-2 py-2 pb-[max(0.5rem,var(--safe-bottom))] md:gap-2" data-testid="voice-controls">
      <ControlButton label={muted ? t("voice.unmute") : t("voice.mute")} active={muted} pulse={mutedTalk} onClick={() => void toggleMute()} testid="voice-mute" className="min-h-11 min-w-11" menu={micMenu.triggerProps}>
        {muted ? <MicOffIcon size={20} /> : <MicIcon size={20} />}
      </ControlButton>
      <ControlButton label={deafened ? t("voice.undeafen") : t("voice.deafen")} active={deafened} onClick={() => void toggleDeafen()} testid="voice-deafen" className="min-h-11 min-w-11" menu={outputMenu.triggerProps}>
        {deafened ? <HeadphonesOffIcon size={20} /> : <HeadphonesIcon size={20} />}
      </ControlButton>
      <AudioRouteButton className="min-h-11 min-w-11" />
      {limits?.camera.enabled && (
        <ControlButton label={camera ? t("voice.camera_off") : t("voice.camera_on")} active={camera} onClick={() => void toggleCamera()} testid="voice-camera" className="min-h-11 min-w-11" unavailable={nativeOnly} menu={nativeOnly ? undefined : cameraMenu.triggerProps}>
          <VideoIcon size={20} />
        </ControlButton>
      )}
      {limits?.screenshare.enabled && (
        <ControlButton label={screen ? t("voice.screen_off") : t("voice.screen_on")} active={screen} onClick={() => (screen ? void stopScreenShare() : void beforeScreenShare().then((ok) => ok && setScreenOpen(true)))} testid="voice-screen" className="min-h-11 min-w-11" unavailable={nativeOnly}>
          <ScreenIcon size={20} />
        </ControlButton>
      )}
      <WhiteboardControl channelId={channel.id} canOpen={hasPermission(perms, Permission.CONNECT)} className="min-h-11 min-w-11" />
      {soundboard && (
        <ControlButton label={t("voice.soundboard.title")} onClick={() => setSoundsOpen(true)} testid="voice-soundboard" className="min-h-11 min-w-11" unavailable={nativeOnly}>
          <SoundboardIcon size={20} />
        </ControlButton>
      )}
      {!nativeOnly && <PriorityButton perms={perms} />}
      {ptt && canSpeak && (
        <button
          type="button"
          className={`min-h-11 select-none rounded-md px-3 text-sm font-medium ${transmitting ? "bg-accent text-accent-text" : "bg-bg-3 text-fg-1"}`}
          onPointerDown={() => pushToTalk(true)}
          onPointerUp={() => pushToTalk(false)}
          onPointerLeave={() => pushToTalk(false)}
          onContextMenu={(e) => e.preventDefault()}
          data-testid="voice-ptt"
        >
          {t("voice.ptt_hold")}
        </button>
      )}
      <ControlButton label={t("voice.settings_link")} onClick={() => navigate("/settings/voice")} className="min-h-11 min-w-11">
        <GearIcon size={20} />
      </ControlButton>
      <ControlButton label={t("voice.leave")} solid onClick={() => void leaveVoice()} testid="voice-leave" className="min-h-11 min-w-11">
        <LeaveIcon size={20} />
      </ControlButton>
      {micMenu.overlay}
      {outputMenu.overlay}
      {cameraMenu.overlay}
      {limits && <ScreenShareDialog open={screenOpen} onClose={() => setScreenOpen(false)} maxResolution={limits.screenshare.max_resolution} maxFps={limits.screenshare.max_fps} />}
      {soundsOpen && <SoundboardDialog open onClose={() => setSoundsOpen(false)} roomId={room.id} disabled={muted || !canSpeak} external={hasPermission(perms, Permission.USE_EXTERNAL_SOUNDS)} />}
    </div>
  );
}
