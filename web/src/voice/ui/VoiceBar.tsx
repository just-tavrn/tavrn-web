// SPDX-License-Identifier: Apache-2.0
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { useT } from "../../i18n";
import { apiFor } from "../../stores/nodes";
import { roomPath } from "../../components/NodeScope";
import { useShell } from "../../components/AppShell";
import { channelName } from "../../lib/names";
import { leaveVoice, toggleDeafen, toggleMute, whisperToAddress } from "../index";
import { isWatched, useVoice, useWatchedStreams, type Quality } from "../store";
import { useVoiceSettings } from "../settings";
import { HeadphonesIcon, HeadphonesOffIcon, LeaveIcon, MicIcon, MicOffIcon, SignalBars } from "./icons";
import { useAuth } from "../../stores/auth";
import { callTitle } from "../calls/actions";
import { CallOverlay, openCallView } from "../calls/CallUi";
import { QualityBadge } from "./QualityBadge";
import { useVoiceDeviceMenu } from "./VoiceDeviceMenu";
import type { ContextMenuTrigger } from "../../components/ContextMenu";

const BARS: Record<Quality, number> = { excellent: 3, good: 2, poor: 1, lost: 0, unknown: 0 };

/** Channel and room name of the own call (from the room detail of its node); for calls in DMs the name of the conversation. */
export function useCallNames(): { channel: string; room: string } {
  const t = useT();
  const target = useVoice((s) => s.target);
  const self = useAuth((s) => s.user?.address);
  const room = useQuery({
    queryKey: ["room", target?.roomId],
    queryFn: () => apiFor(target!.domain).rooms.get(target!.roomId),
    enabled: !!target && !target.call,
    staleTime: 60_000,
  });
  const conv = useQuery({
    queryKey: ["conversation", target?.channelId],
    queryFn: () => apiFor(target!.domain).conversations.get(target!.channelId),
    enabled: !!target?.call,
    staleTime: 60_000,
  });
  if (target?.call) return { channel: callTitle(conv.data, self), room: t("calls.call") };
  const channel = room.data?.channels.find((c) => c.id === target?.channelId);
  return { channel: channel ? channelName(channel) : "…", room: room.data?.name ?? "" };
}

/**
 * A round toggle button of the voice controls; `menu` adds a quick menu (right-click, long press); `compact` = 36 px (the
 * voice bar). `unavailable` names why the action cannot be used here (the native voice engine has no camera): the
 * button stays focusable and announces the reason instead of failing. `pulse` draws attention for a moment (the
 * microphone while talking muted, issue #125; a static ring with reduced motion).
 */
export function ControlButton({ label, active = false, danger = false, solid = false, onClick, children, testid, className = "", menu, compact = false, unavailable, pulse = false }: { label: string; active?: boolean; danger?: boolean; solid?: boolean; onClick: () => void; children: React.ReactNode; testid?: string; className?: string; menu?: ContextMenuTrigger["triggerProps"]; compact?: boolean; unavailable?: string; pulse?: boolean }) {
  const look = unavailable ? "cursor-not-allowed text-fg-2 opacity-60" : solid ? "bg-danger-solid text-white hover:bg-danger-solid-hover" : danger ? "text-danger hover:bg-danger/15" : active ? "bg-danger/15 text-danger hover:bg-danger/25" : "text-fg-1 hover:bg-bg-3 hover:text-fg-0";
  const name = unavailable ? `${label}: ${unavailable}` : label;
  return (
    <button
      type="button"
      aria-label={name}
      title={name}
      aria-pressed={unavailable ? undefined : active}
      aria-disabled={unavailable ? true : undefined}
      data-testid={testid}
      data-unavailable={unavailable ? true : undefined}
      data-pulse={pulse || undefined}
      onClick={unavailable ? undefined : onClick}
      {...menu}
      className={`inline-flex ${compact ? "min-h-9 min-w-9" : "min-h-10 min-w-10"} items-center justify-center rounded-md ${look} ${pulse ? "voice-muted-talk" : ""} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * The persistent voice bar at the bottom of the sidebar while connected (VOICE.md §9): channel and room,
 * connection state and quality, mute, deafen and leave, also while browsing text channels.
 */
export function VoiceBar() {
  const t = useT();
  const status = useVoice((s) => s.status);
  const target = useVoice((s) => s.target);
  const muted = useVoice((s) => s.muted);
  const whispering = useVoice((s) => s.whispering);
  const whisperTarget = useVoice((s) => s.whisperTarget);
  const canWhisper = useVoice((s) => s.whisperSupported && s.canSpeak && !s.muted && !s.deafened);
  const mutedTalk = useVoice((s) => s.mutedTalk);
  const deafened = useVoice((s) => s.deafened);
  const quality = useVoice((s) => s.quality);
  // Deafened while a watched stream with audio keeps playing (issue #20).
  const watched = useWatchedStreams();
  const media = useVoice((s) => s.media);
  const streamPlays = deafened && Object.entries(media).some(([id, m]) => m.screenAudio && isWatched(watched, id));
  const keepsStreams = useVoiceSettings((s) => s.settings.streamWhileDeafened);
  const names = useCallNames();
  const navigate = useNavigate();
  const { closeNav } = useShell();
  const micMenu = useVoiceDeviceMenu("input", closeNav);
  const outputMenu = useVoiceDeviceMenu("output", closeNav);
  // Incoming calls and the call view (portals, also while no call runs).
  const overlay = <CallOverlay />;
  if (status === "idle" || !target) return overlay;
  const color = status === "connected" ? "text-ok" : "text-warn";
  const level = status === "connected" ? BARS[quality] : 0;
  // Voice is never sent unencrypted (VOICE.md), so the padlock is always there; the text names the quality.
  const signal = t(status === "connected" ? `voice.signal.${quality}` : "voice.signal.connecting");
  return (
    <div className="relative border-t border-line bg-bg-0 px-1 py-1" data-testid="voice-bar" data-status={status} data-call={target.call || undefined}>
      {overlay}
      {/*
        One button over the whole bar opens the channel: the first line (signal with the padlock, a short status, the
        quality) leaves room for the controls laid over its right end, the channel and room get the full width below.
      */}
      <button
        type="button"
        className="block w-full min-w-0 rounded-md px-1 text-left hover:bg-bg-3/60"
        onClick={() => {
          closeNav();
          if (target.call) openCallView(navigate);
          else navigate(roomPath(target.domain, target.roomId, target.channelId));
        }}
        title={t("voice.bar.open")}
      >
        <span className={`flex h-9 min-w-0 items-center gap-[3px] whitespace-nowrap pr-[100px] text-xs font-semibold ${color}`} data-row="status">
          <span role="img" aria-label={signal} title={signal} className="inline-flex shrink-0" data-testid="voice-bar-signal" data-level={level}>
            <SignalBars level={level} locked />
          </span>
          {/* The section is the voice bar: "Connected" is enough on screen, screen readers hear the long form. */}
          <span className="shrink-0" aria-hidden="true" data-testid="voice-bar-status">
            {t(`voice.bar.status.${status}`)}
          </span>
          {status === "connected" && <QualityBadge compact />}
        </span>
        <span className="sr-only">{t(`voice.status.${status}`)}</span>
        <span className={`flex min-w-0 items-center text-[11px] text-fg-2 ${status === "reconnecting" ? "min-h-6 pr-20" : "min-h-5"}`} data-row="channel">
          <span className="min-w-0 truncate" data-testid="voice-bar-channel">
            {names.channel}
            {names.room && ` / ${names.room}`}
          </span>
        </span>
        {deafened && (
          <span className="block truncate pb-0.5 text-[11px] text-warn" data-testid="voice-bar-deafened">
            {streamPlays && keepsStreams ? t("voice.bar.deafened_stream") : t("voice.bar.deafened")}
          </span>
        )}
      </button>
      {whisperTarget && <button type="button" data-testid="whisper-selected-hold" disabled={!canWhisper || status !== "connected"}
        className="min-h-11 w-full touch-none rounded-md px-2 text-left text-xs text-accent [overflow-wrap:anywhere] hover:bg-bg-3 disabled:opacity-50"
        aria-label={t("voice.whisper.hold", { name: whisperTarget })}
        onTouchStart={(e) => e.stopPropagation()}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); whisperToAddress(whisperTarget, true); }}
        onPointerUp={() => whisperToAddress(whisperTarget, false)} onPointerCancel={() => whisperToAddress(whisperTarget, false)} onLostPointerCapture={() => whisperToAddress(whisperTarget, false)}
        onKeyDown={(e) => { if (!e.repeat && (e.key === " " || e.key === "Enter")) { e.preventDefault(); whisperToAddress(whisperTarget, true); } }}
        onKeyUp={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); whisperToAddress(whisperTarget, false); } }} onBlur={() => whisperToAddress(whisperTarget, false)}>
        {t("voice.whisper.hold", { name: whisperTarget })}
      </button>}
      {whispering.length > 0 && <p role="status" className="truncate px-2 text-xs text-accent" data-testid="whisper-bar">{t("voice.whisper.sending", { names: whispering.map((id) => id.split("/")[0]).join(", ") })}</p>}
      <div className="absolute right-1 top-1 flex items-center">
        <ControlButton label={muted ? t("voice.unmute") : t("voice.mute")} active={muted} pulse={mutedTalk} onClick={() => void toggleMute()} testid="voice-bar-mute" menu={micMenu.triggerProps} compact>
          {muted ? <MicOffIcon /> : <MicIcon />}
        </ControlButton>
        <ControlButton label={deafened ? t("voice.undeafen") : t("voice.deafen")} active={deafened} onClick={() => void toggleDeafen()} testid="voice-bar-deafen" menu={outputMenu.triggerProps} compact>
          {deafened ? <HeadphonesOffIcon /> : <HeadphonesIcon />}
        </ControlButton>
        <ControlButton label={t("voice.leave")} danger onClick={() => void leaveVoice()} testid="voice-bar-leave" compact>
          <LeaveIcon />
        </ControlButton>
      </div>
      {status === "reconnecting" && (
        <button type="button" className="absolute right-1 top-10 min-h-6 rounded-md px-2 text-xs font-medium text-warn hover:bg-bg-3" onClick={() => void leaveVoice()} data-testid="voice-bar-cancel" title={t("voice.bar.cancel_hint")}>
          {t("common.cancel")}
        </button>
      )}
      {micMenu.overlay}
      {outputMenu.overlay}
    </div>
  );
}
