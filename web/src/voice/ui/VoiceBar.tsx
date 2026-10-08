// SPDX-License-Identifier: Apache-2.0
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { useT } from "../../i18n";
import { apiFor } from "../../stores/nodes";
import { roomPath } from "../../components/NodeScope";
import { useShell } from "../../components/AppShell";
import { channelName } from "../../lib/names";
import { leaveVoice, toggleDeafen, toggleMute } from "../index";
import { isWatched, useVoice, useWatchedStreams, type Quality } from "../store";
import { useVoiceSettings } from "../settings";
import { HeadphonesIcon, HeadphonesOffIcon, LeaveIcon, MicIcon, MicOffIcon, SignalBars } from "./icons";
import { useAuth } from "../../stores/auth";
import { callTitle } from "../calls/actions";
import { CallOverlay, openCallView } from "../calls/CallUi";

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

/** A round toggle button of the voice controls. */
export function ControlButton({ label, active = false, danger = false, solid = false, onClick, children, testid, className = "" }: { label: string; active?: boolean; danger?: boolean; solid?: boolean; onClick: () => void; children: React.ReactNode; testid?: string; className?: string }) {
  const look = solid ? "bg-danger-solid text-white hover:bg-danger-solid-hover" : danger ? "text-danger hover:bg-danger/15" : active ? "bg-danger/15 text-danger hover:bg-danger/25" : "text-fg-1 hover:bg-bg-3 hover:text-fg-0";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      data-testid={testid}
      onClick={onClick}
      className={`inline-flex min-h-10 min-w-10 items-center justify-center rounded-md ${look} ${className}`}
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
  // Incoming calls and the call view (portals, also while no call runs).
  const overlay = <CallOverlay />;
  if (status === "idle" || !target) return overlay;
  const color = status === "connected" ? "text-ok" : "text-warn";
  return (
    <div className="border-t border-line bg-bg-0 px-2 py-1.5" data-testid="voice-bar" data-status={status} data-call={target.call || undefined}>
      {overlay}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 rounded-md px-1 py-0.5 text-left hover:bg-bg-3/60"
          onClick={() => {
            closeNav();
            if (target.call) openCallView(navigate);
            else navigate(roomPath(target.domain, target.roomId, target.channelId));
          }}
          title={t("voice.bar.open")}
        >
          <span className={`flex items-center gap-1.5 text-xs font-semibold ${color}`}>
            <SignalBars level={status === "connected" ? BARS[quality] : 0} />
            <span data-testid="voice-bar-status">{t(`voice.status.${status}`)}</span>
            <span role="img" className="text-[10px]" aria-label={t("voice.encrypted")} title={t("voice.encrypted")}>
              🔒
            </span>
          </span>
          <span className="block truncate text-[11px] text-fg-2" data-testid="voice-bar-channel">
            {names.channel}
            {names.room && ` / ${names.room}`}
          </span>
          {deafened && (
            <span className="block truncate text-[11px] text-warn" data-testid="voice-bar-deafened">
              {streamPlays && keepsStreams ? t("voice.bar.deafened_stream") : t("voice.bar.deafened")}
            </span>
          )}
        </button>
        {status === "reconnecting" && (
          <button type="button" className="min-h-10 rounded-md px-2 text-xs font-medium text-warn hover:bg-bg-3" onClick={() => void leaveVoice()} data-testid="voice-bar-cancel" title={t("voice.bar.cancel_hint")}>
            {t("common.cancel")}
          </button>
        )}
        <ControlButton label={muted ? t("voice.unmute") : t("voice.mute")} active={muted} onClick={() => void toggleMute()} testid="voice-bar-mute">
          {muted ? <MicOffIcon /> : <MicIcon />}
        </ControlButton>
        <ControlButton label={deafened ? t("voice.undeafen") : t("voice.deafen")} active={deafened} onClick={() => void toggleDeafen()} testid="voice-bar-deafen">
          {deafened ? <HeadphonesOffIcon /> : <HeadphonesIcon />}
        </ControlButton>
        <ControlButton label={t("voice.leave")} danger onClick={() => void leaveVoice()} testid="voice-bar-leave">
          <LeaveIcon />
        </ControlButton>
      </div>
    </div>
  );
}
