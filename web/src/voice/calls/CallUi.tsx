// SPDX-License-Identifier: Apache-2.0
/**
 * Calls in DMs and group DMs (design note 4.11, VOICE.md §11): the "Call" button of the conversation header,
 * the incoming-call banner with the ringtone, and the call view (tiles, controls) that reuses the voice
 * stage's tiles. The banner and the view are portals on `document.body`, so they show on every page and on
 * phones (where the sidebar is off-screen); the view can be minimized to the voice bar.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";
import type { Conversation, User, VoiceParticipant } from "@tavrn/sdk";
import { useT } from "../../i18n";
import { conversationPath, useNode } from "../../components/NodeScope";
import { Button } from "../../components/ui";
import { useAuth } from "../../stores/auth";
import { apiFor, connectNode, isHome } from "../../stores/nodes";
import { splitIdentity } from "@tavrn/e2ee";
import { cueEngine, startRingtone } from "../cues";
import { leaveVoice, stopScreenShare, toggleCamera, toggleDeafen, toggleMute } from "../index";
import { participantsOf, useVoicePresence } from "../presence";
import { useVoice } from "../store";
import { AvatarTile } from "../ui/AvatarTile";
import { ControlButton } from "../ui/VoiceBar";
import { ScreenShareDialog } from "../ui/VoiceControls";
import { ParticipantTile, useIsPhone, type Tile } from "../ui/VoiceStage";
import { ScreenTile, StreamingIndicator } from "../ui/ScreenTile";
import { HeadphonesIcon, HeadphonesOffIcon, MicIcon, MicOffIcon, MinimizeIcon, PhoneIcon, PhoneOffIcon, ScreenIcon, VideoIcon } from "../ui/icons";
import { StageGrid } from "../ui/StageGrid";
import { answerCall, applyCall, callTitle, declineCall, ringNotice, startCall } from "./actions";
import { callNoticeWanted, closeCallNotice, showCallNotice } from "./notify";
import { pushSupported, readyRegistration } from "../../lib/push";
import { usePush } from "../../stores/push";
import { useNotifications } from "../../stores/notifications";
import { callKey, expireRings, useCalls, type Ring } from "./state";
import { LockMark } from "../../components/Badges";
import { ViaNode } from "../../components/ViaNode";

/** The conversation of a call (members, name) from its node; shared cache with the DM page. */
function useConversation(domain: string, conversationId: string, enabled = true) {
  return useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: async () => {
      if (!isHome(domain)) await connectNode(domain);
      return apiFor(domain).conversations.get(conversationId);
    },
    enabled: enabled && !!conversationId,
    staleTime: 60_000,
    retry: 1,
  });
}

const nameOf = (c: Conversation | undefined, address: string) => c?.members.find((m) => m.address === address)?.display_name || address.split("@")[0] || address;

/** "Call" in the header of a DM or group DM: starts a call, joins a running one, or shows the own call. */
export function CallButton({ conversation }: { conversation: Conversation }) {
  const t = useT();
  const { api, domain } = useNode();
  const key = callKey(domain, conversation.id);
  const call = useCalls((s) => s.calls[key]);
  const mine = useVoice((s) => !!s.target?.call && s.target.domain === domain && s.target.channelId === conversation.id && s.status !== "idle");
  // The running call when the page opens; then `call.update` events keep it current.
  useQuery({
    queryKey: ["call", domain, conversation.id],
    queryFn: async () => {
      const c = await api.calls.get(conversation.id);
      applyCall(domain, c);
      return c;
    },
    staleTime: 30_000,
    retry: false,
  });
  if (mine) {
    return (
      <Button variant="ghost" className="ml-auto min-h-9 text-ok" onClick={() => useCalls.setState({ expanded: true })} data-testid="call-open">
        <PhoneIcon size={16} /> <span className="hidden sm:inline">{t("calls.in_call")}</span>
      </Button>
    );
  }
  const running = !!call?.active;
  return (
    <Button
      variant="ghost"
      className={`ml-auto min-h-9 ${running ? "text-ok" : ""}`}
      onClick={() => void startCall(domain, conversation.id)}
      aria-label={running ? t("calls.join_count", { count: call!.participants.length }) : t("calls.start")}
      title={running ? t("calls.join_count", { count: call!.participants.length }) : t("calls.start")}
      data-testid="call-start"
      data-running={running || undefined}
    >
      <PhoneIcon size={16} /> <span className="hidden sm:inline">{running ? t("calls.join_count", { count: call!.participants.length }) : t("calls.start")}</span>
    </Button>
  );
}

/** One incoming call: who calls, accept and decline; `soundBlocked`: the browser keeps the ringtone silent. */
function IncomingCall({ ring, soundBlocked }: { ring: Ring; soundBlocked: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const conv = useConversation(ring.domain, ring.conversationId);
  const self = useAuth((s) => s.user?.address);
  const caller = nameOf(conv.data, ring.from);
  const [busy, setBusy] = useState(false);
  return (
    <div role="alertdialog" aria-label={t("calls.incoming")} className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border border-line bg-bg-1 p-3 shadow-2xl" data-testid="call-incoming" data-conversation={ring.conversationId} data-group={ring.group || undefined}>
      <span className="rounded-full motion-safe:animate-pulse">
        <AvatarTile user={conv.data?.members.find((m) => m.address === ring.from) ?? null} name={caller} address={ring.from} size={44} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-fg-0">{ring.group ? t("calls.incoming_group", { name: callTitle(conv.data, self) }) : t("calls.incoming_from", { name: caller })}</p>
        <p className="truncate text-xs text-fg-2">
          {ring.group ? t("calls.started_by", { name: caller }) : ring.from}
          {ring.via && (
            <>
              {" "}
              <ViaNode node={ring.via} />
            </>
          )}
        </p>
        {soundBlocked && (
          <p className="text-xs text-fg-1" data-testid="call-sound-blocked">
            {t("calls.sound_blocked")}
          </p>
        )}
      </div>
      <button
        type="button"
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full bg-danger-solid text-white hover:bg-danger-solid-hover disabled:opacity-50"
        aria-label={t("calls.decline")}
        title={t("calls.decline")}
        disabled={busy}
        onClick={() => void declineCall(ring.domain, ring.conversationId)}
        data-testid="call-decline"
      >
        <PhoneOffIcon size={20} />
      </button>
      <button
        type="button"
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full bg-ok text-bg-0 hover:opacity-90 disabled:opacity-50"
        aria-label={t("calls.accept")}
        title={t("calls.accept")}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          navigate(conversationPath(ring.domain, ring.conversationId));
          void answerCall(ring.domain, ring.conversationId).finally(() => setBusy(false));
        }}
        data-testid="call-accept"
      >
        <PhoneIcon size={20} />
      </button>
    </div>
  );
}

/** The incoming calls and their ringtone (direct calls ring louder than group calls). */
function IncomingCalls() {
  const rings = useCalls(useShallow((s) => Object.values(s.ringing)));
  const group = rings.length > 0 && rings.every((r) => r.group);
  const ringing = rings.length > 0;
  const [soundBlocked, setSoundBlocked] = useState(false);
  // Signed in: the next tap unlocks the sound, so a later call can ring without one (mobile autoplay policies).
  useEffect(() => cueEngine.arm(), []);
  useEffect(() => {
    if (!ringing) return;
    const stop = startRingtone(group ? "group" : "direct", undefined, undefined, { onAudible: (a) => setSoundBlocked(!a) });
    const timer = setInterval(() => useCalls.getState().set((s) => expireRings(s, Date.now())), 5_000);
    return () => {
      stop();
      clearInterval(timer);
      setSoundBlocked(false);
    };
  }, [ringing, group]);
  useCallNotices(rings, soundBlocked);
  if (!ringing) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 p-3 pt-[max(0.75rem,var(--safe-top))]" data-testid="call-incoming-list">
      {rings.map((r) => (
        <IncomingCall key={callKey(r.domain, r.conversationId)} ring={r} soundBlocked={soundBlocked} />
      ))}
    </div>
  );
}

/**
 * Browsers: a system notification for rings that cannot be heard (tab hidden, or sound blocked until the user touches
 * the page), through the service worker (`notify.ts`); closed when the ring ends. The desktop app notifies natively.
 */
function useCallNotices(rings: Ring[], soundBlocked: boolean) {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.visibilityState === "hidden");
  useEffect(() => {
    const on = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  const pushOn = usePush((s) => s.status === "on");
  const browserOn = useNotifications((s) => s.settings.global.browser);
  const enabled = pushOn || browserOn;
  const keys = rings.map((r) => callKey(r.domain, r.conversationId)).join(",");
  const current = useRef(rings);
  current.current = rings;
  useEffect(() => {
    if (!keys || !pushSupported()) return;
    const permission = "Notification" in window ? Notification.permission : "unsupported";
    if (!callNoticeWanted({ hidden, soundBlocked, permission, enabled })) return;
    let cancelled = false;
    void readyRegistration(3_000).then((reg) => {
      if (cancelled) return;
      for (const r of current.current) void showCallNotice(reg, ringNotice(r));
    });
    return () => {
      cancelled = true;
    };
  }, [keys, hidden, soundBlocked, enabled]);
  // Rings that ended (answered here or elsewhere, declined, over): their notification goes too, also one of a push.
  const before = useRef<string[]>([]);
  useEffect(() => {
    const now = keys ? keys.split(",") : [];
    const gone = before.current.filter((k) => !now.includes(k));
    before.current = now;
    if (!gone.length || !pushSupported()) return;
    void readyRegistration(3_000).then((reg) => gone.forEach((k) => void closeCallNotice(reg, k)));
  }, [keys]);
}

function useDuration(since: string | null | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (!since) return "";
  const secs = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const m = Math.floor(secs / 60);
  return `${m}:${String(secs % 60).padStart(2, "0")}`;
}

/** Tiles of the call: the node's participants, plus devices LiveKit already connected (own included). */
function useCallTiles(domain: string, conversationId: string, conv: Conversation | undefined): Tile[] {
  const participants = useVoicePresence((s) => participantsOf(s, domain, conversationId));
  const identity = useVoice((s) => s.identity);
  const media = useVoice((s) => s.media);
  const self = useVoice(useShallow((s) => ({ muted: s.muted, deafened: s.deafened, serverMuted: s.serverMuted, camera: s.camera, screen: s.screen })));
  return useMemo(() => {
    const user = (address: string): User | null => conv?.members.find((m) => m.address === address) ?? null;
    const out: Tile[] = [];
    const seen = new Set<string>();
    const add = (id: string, address: string, p: VoiceParticipant | null) => {
      const isSelf = id === identity;
      const m = media[id];
      out.push({
        identity: id,
        address,
        name: nameOf(conv, address),
        self: isSelf,
        camera: m?.camera ?? false,
        flags: isSelf
          ? { muted: self.muted, deafened: self.deafened, server_muted: false, streaming: self.screen, camera: self.camera }
          : p
            ? p
            : { muted: m?.micMuted ?? false, deafened: false, server_muted: false, streaming: m?.screen ?? false, camera: m?.camera ?? false },
        connection: isSelf ? "connected" : (p?.connection ?? "connected"),
        participant: p,
        user: user(address),
      });
    };
    for (const p of participants) {
      seen.add(p.identity);
      add(p.identity, p.user, p);
    }
    for (const id of Object.keys(media)) if (!seen.has(id)) add(id, splitIdentity(id).address, null);
    return out;
  }, [participants, media, identity, self.muted, self.deafened, self.camera, self.screen, conv]);
}

/** The own call: tiles and controls; full screen on phones, a large panel on desktop; minimizable. */
function ActiveCall() {
  const t = useT();
  const target = useVoice((s) => (s.target?.call ? s.target : null));
  const status = useVoice((s) => s.status);
  const expanded = useCalls((s) => s.expanded);
  const self = useAuth((s) => s.user?.address);
  const domain = target?.domain ?? "";
  const conversationId = target?.channelId ?? "";
  const conv = useConversation(domain, conversationId, !!target);
  const call = useCalls((s) => (target ? s.calls[callKey(domain, conversationId)] : undefined));
  const tiles = useCallTiles(domain, conversationId, conv.data);
  const media = useVoice((s) => s.media);
  const focus = useVoice((s) => s.focus);
  const limits = useVoice((s) => s.limits);
  const muted = useVoice((s) => s.muted);
  const deafened = useVoice((s) => s.deafened);
  const camera = useVoice((s) => s.camera);
  const screen = useVoice((s) => s.screen);
  const selfPreview = useVoice((s) => s.selfPreview);
  const phone = useIsPhone();
  const [screenOpen, setScreenOpen] = useState(false);
  const answered = (call?.participants.length ?? 0) > 1;
  const duration = useDuration(answered ? call?.participants[1]?.joined_at : null);
  if (!target || status === "idle") return null;
  const title = callTitle(conv.data, self);
  const minimize = () => useCalls.setState({ expanded: false });
  if (!expanded) {
    // Phones: the voice bar sits in the hidden sidebar, so a small pill brings the call back.
    return phone ? (
      <button type="button" className="fixed bottom-[max(1rem,var(--safe-bottom))] right-4 z-50 flex min-h-11 items-center gap-2 rounded-full bg-ok px-4 text-sm font-medium text-bg-0 shadow-xl" onClick={() => useCalls.setState({ expanded: true })} data-testid="call-pill">
        <PhoneIcon size={16} /> {duration || t("calls.in_call")}
      </button>
    ) : null;
  }
  // Streams are joined (a placeholder until then); the own share only while its preview is shown.
  const screens = tiles.filter((x) => media[x.identity]?.screen && (!x.self || selfPreview));
  const focused = focus ? screens.find((x) => x.identity === focus) : undefined;
  const toggleFocus = (id: string) => useVoice.setState((s) => ({ focus: s.focus === id ? null : id }));
  const ringing = call?.ringing ?? [];
  return (
    <section
      aria-label={t("calls.view", { name: title })}
      className="fixed inset-0 z-50 flex flex-col bg-bg-0 md:inset-auto md:bottom-4 md:right-4 md:h-[min(600px,calc(100vh-2rem))] md:w-[min(760px,calc(100vw-2rem))] md:overflow-hidden md:rounded-xl md:border md:border-line md:shadow-2xl"
      data-testid="call-view"
      data-status={status}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 pt-[var(--safe-top)]">
        <PhoneIcon size={16} className="text-ok" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" data-testid="call-title">
          {title}
        </h2>
        <LockMark size={18} title={t("voice.encrypted")} />
        <span className="text-xs tabular-nums text-fg-2" data-testid="call-status">
          {status === "reconnecting" ? t("voice.status.reconnecting") : answered ? duration : ringing.length ? t("calls.ringing") : status === "joining" ? t("voice.status.joining") : t("calls.waiting")}
        </span>
        <ControlButton label={t("calls.minimize")} onClick={minimize} testid="call-minimize">
          <MinimizeIcon size={18} />
        </ControlButton>
      </header>
      {call?.group && (
        <p className="border-b border-line px-3 py-1 text-xs text-fg-2" data-testid="call-who">
          {t("calls.in_call_list", { names: tiles.map((x) => x.name).join(", ") })}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        <StreamingIndicator />
        {focused && (
          <StageGrid className="flex-[3]" testId="call-focus">
            <ScreenTile key={focused.identity} tile={focused} focused onFocus={() => toggleFocus(focused.identity)} />
          </StageGrid>
        )}
        {/* 16:9 tiles sized from the panel and the number of tiles (layout.ts), like the voice stage. */}
        <StageGrid className={focused ? "h-[clamp(96px,24%,200px)] shrink-0" : "flex-1"} minWidth={focused ? 120 : 150} testId="call-grid">
          {screens
            .filter((x) => x !== focused)
            .map((x) => (
              <ScreenTile key={`s-${x.identity}`} tile={x} focused={false} onFocus={() => toggleFocus(x.identity)} />
            ))}
          {tiles.map((x) => (
            <ParticipantTile key={x.identity} tile={x} />
          ))}
          {ringing.map((address) => (
            <div key={`r-${address}`} className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line text-xs text-fg-2" data-testid="call-ringing-tile">
              <span className="rounded-full motion-safe:animate-pulse">
                <AvatarTile user={conv.data?.members.find((m) => m.address === address) ?? null} name={nameOf(conv.data, address)} address={address} size={56} stage />
              </span>
              {t("calls.ringing_for", { name: nameOf(conv.data, address) })}
            </div>
          ))}
        </StageGrid>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-1 border-t border-line bg-bg-1 px-2 py-2 pb-[max(0.5rem,var(--safe-bottom))] md:gap-2" data-testid="call-controls">
        <ControlButton label={muted ? t("voice.unmute") : t("voice.mute")} active={muted} onClick={() => void toggleMute()} testid="voice-mute" className="min-h-11 min-w-11">
          {muted ? <MicOffIcon size={20} /> : <MicIcon size={20} />}
        </ControlButton>
        <ControlButton label={deafened ? t("voice.undeafen") : t("voice.deafen")} active={deafened} onClick={() => void toggleDeafen()} testid="voice-deafen" className="min-h-11 min-w-11">
          {deafened ? <HeadphonesOffIcon size={20} /> : <HeadphonesIcon size={20} />}
        </ControlButton>
        {limits?.camera.enabled && (
          <ControlButton label={camera ? t("voice.camera_off") : t("voice.camera_on")} active={camera} onClick={() => void toggleCamera()} testid="voice-camera" className="min-h-11 min-w-11">
            <VideoIcon size={20} />
          </ControlButton>
        )}
        {limits?.screenshare.enabled && (
          <ControlButton label={screen ? t("voice.screen_off") : t("voice.screen_on")} active={screen} onClick={() => (screen ? void stopScreenShare() : setScreenOpen(true))} testid="voice-screen" className="min-h-11 min-w-11">
            <ScreenIcon size={20} />
          </ControlButton>
        )}
        <ControlButton label={t("calls.leave")} solid onClick={() => void leaveVoice()} testid="call-leave" className="min-h-11 min-w-11">
          <PhoneOffIcon size={20} />
        </ControlButton>
      </div>
      {limits && <ScreenShareDialog open={screenOpen} onClose={() => setScreenOpen(false)} maxResolution={limits.screenshare.max_resolution} maxFps={limits.screenshare.max_fps} />}
    </section>
  );
}

/** Incoming calls and the own call, on top of everything (mounted once, next to the voice bar). */
export function CallOverlay() {
  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      <ActiveCall />
      <IncomingCalls />
    </>,
    document.body,
  );
}

/** Opens the own call's view (from the voice bar). */
export function openCallView(navigate: (path: string) => void): void {
  const target = useVoice.getState().target;
  if (!target?.call) return;
  useCalls.setState({ expanded: true });
  navigate(conversationPath(target.domain, target.channelId));
}
