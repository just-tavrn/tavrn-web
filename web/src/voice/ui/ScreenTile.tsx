// SPDX-License-Identifier: Apache-2.0
/**
 * Stream tiles (screen shares, docs/CLIENT.md "Streams are joined"). Screen shares are opt-in: a participant's share
 * is a placeholder with their name, the LIVE badge and "Join stream" until this viewer joins it (the button, a
 * double-click on the tile, or a double-click / Enter on the streamer in the voice member list); joined, it shows
 * the video with the stream's own volume, picture-in-picture, focus, fullscreen and "Leave stream". The sharer gets
 * no permanent self view: a preview tile they can hide, and the "You are streaming" indicator with Stop and the
 * preview toggle.
 */
import { useCallback, useEffect, useRef } from "react";
import { useT } from "../../i18n";
import { Button } from "../../components/ui";
import { EyeOffIcon } from "../../components/icons";
import { useVoice, watchStream } from "../store";
import { joinStream, leaveStream, stopScreenShare } from "../index";
import { ScreenBadge } from "./common";
import { ExpandIcon, PipIcon, ScreenIcon, ScreenOffIcon } from "./icons";
import { FullscreenButton, FullscreenControls, exitFullscreen, fullscreenElement, useFullscreen } from "./fullscreen";
import { StreamAudioControls } from "./StreamAudio";
import { VideoView } from "./VideoView";
import type { Tile } from "./VoiceStage";

const overlayButton = "inline-flex min-h-8 min-w-8 items-center justify-center rounded-md bg-black/60 text-fg-0 hover:bg-black/80";

/** The red LIVE badge of a running stream. */
export function LiveBadge() {
  const t = useT();
  return (
    <span className="rounded bg-danger-solid px-1.5 text-[10px] font-bold uppercase leading-5 text-white" data-testid="stream-live">
      {t("voice.live")}
    </span>
  );
}

/** The own preview is shown (the sharer may hide it). */
const setSelfPreview = (selfPreview: boolean) => useVoice.setState({ selfPreview });

/**
 * A screen share on the stage: a placeholder until joined, then the stream (watched while shown: its audio stays
 * audible while deafened, issue #20); the own share as a preview that can be hidden.
 */
export function ScreenTile({ tile, focused, onFocus }: { tile: Tile; focused: boolean; onFocus: () => void }) {
  const joined = useVoice((s) => tile.self || !!s.streams[tile.identity]);
  if (!joined) return <StreamPlaceholder tile={tile} />;
  return <StreamView tile={tile} focused={focused} onFocus={onFocus} />;
}

function StreamPlaceholder({ tile }: { tile: Tile }) {
  const t = useT();
  const join = () => joinStream(tile.identity);
  return (
    <div
      className="relative flex h-full w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border-2 border-line bg-bg-2 p-3"
      data-testid="screen-tile"
      data-user={tile.address}
      data-identity={tile.identity}
      data-state="available"
      onDoubleClick={join}
    >
      <div className="absolute inset-x-1.5 top-1.5 flex min-w-0 items-center gap-1.5">
        <LiveBadge />
        <span className="truncate text-xs text-fg-0" style={tile.color ? { color: tile.color } : undefined}>
          {tile.name}
        </span>
      </div>
      <ScreenIcon size={28} className="text-fg-2" aria-hidden="true" />
      <Button onClick={join} aria-label={t("voice.stream.join_named", { name: tile.name })} data-testid="stream-join">
        {t("voice.stream.join")}
      </Button>
    </div>
  );
}

function StreamView({ tile, focused, onFocus }: { tile: Tile; focused: boolean; onFocus: () => void }) {
  const t = useT();
  const video = useRef<HTMLVideoElement | null>(null);
  const fs = useFullscreen<HTMLDivElement>();
  const screenAudio = useVoice((s) => !!s.media[tile.identity]?.screenAudio);
  const hasVideo = useVoice((s) => !!s.media[tile.identity]?.screenVideo);
  useEffect(() => (tile.self ? undefined : watchStream(tile.identity)), [tile.identity, tile.self]);
  const onVideo = useCallback((el: HTMLVideoElement | null) => {
    video.current = el;
  }, []);
  const leave = () => {
    if (fs.ref.current && fullscreenElement() === fs.ref.current) void exitFullscreen();
    leaveStream(tile.identity);
  };
  const pip = async () => {
    const el = video.current;
    if (!el) return;
    try {
      if (document.pictureInPictureElement === el) await document.exitPictureInPicture();
      else await el.requestPictureInPicture();
    } catch {
      /* not supported or not allowed */
    }
  };
  return (
    <div
      ref={fs.ref}
      className="relative h-full w-full overflow-hidden rounded-xl border-2 border-line bg-black [&:fullscreen]:h-dvh [&:fullscreen]:w-dvw [&:fullscreen]:rounded-none [&:fullscreen]:border-0"
      data-testid="screen-tile"
      data-user={tile.address}
      data-identity={tile.identity}
      data-state={tile.self ? "preview" : "watching"}
      data-focused={focused || undefined}
      data-audio={(screenAudio && !tile.self) || undefined}
      data-orientation={fs.active ? fs.orientation : undefined}
    >
      <VideoView identity={tile.identity} source="screen" fit="contain" onVideo={onVideo} />
      {!hasVideo && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-fg-1" role="status" data-testid="stream-connecting">
          {t("voice.stream.connecting")}
        </p>
      )}
      <div className="absolute inset-x-1.5 top-1.5 flex items-center gap-1.5">
        {tile.self ? <ScreenBadge /> : <LiveBadge />}
        <span className="truncate rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-fg-0">{tile.self ? t("voice.stream.your_preview") : tile.name}</span>
        <span className="flex-1" />
        {screenAudio && !tile.self && <StreamAudioControls address={tile.address} name={tile.name} />}
        {hasVideo && "pictureInPictureEnabled" in document && document.pictureInPictureEnabled && (
          <button type="button" onClick={() => void pip()} className={overlayButton} aria-label={t("voice.pip")} title={t("voice.pip")}>
            <PipIcon size={16} />
          </button>
        )}
        {hasVideo && <FullscreenButton active={fs.active} onToggle={fs.toggle} testId="screen-fullscreen" />}
        {hasVideo && !fs.active && (
          <button type="button" onClick={onFocus} className={overlayButton} aria-label={focused ? t("voice.unfocus") : t("voice.focus")} title={focused ? t("voice.unfocus") : t("voice.focus")} data-testid="screen-focus">
            <ExpandIcon size={16} />
          </button>
        )}
        {tile.self ? (
          <button type="button" onClick={() => setSelfPreview(false)} className={overlayButton} aria-label={t("voice.stream.preview_hide")} title={t("voice.stream.preview_hide")} data-testid="stream-preview-hide">
            <EyeOffIcon size={16} />
          </button>
        ) : (
          !fs.active && (
            <button type="button" onClick={leave} className={overlayButton} aria-label={t("voice.stream.leave_named", { name: tile.name })} title={t("voice.stream.leave")} data-testid="stream-leave">
              <ScreenOffIcon size={16} />
            </button>
          )
        )}
      </div>
      {fs.active && <FullscreenControls onExit={fs.toggle} onLeaveStream={tile.self ? undefined : leave} />}
    </div>
  );
}

/**
 * The sharer's indicator while their screen share runs: "You are streaming", the preview toggle (the preview tile
 * can be hidden and reopened here) and Stop. The Android app's share (VOICE.md §4b) has no preview (the sharer looks
 * at the shared screen itself): the indicator shows while it is live, with Stop.
 */
export function StreamingIndicator() {
  const t = useT();
  const own = useVoice((s) => s.screen);
  const native = useVoice((s) => !s.screen && s.nativeScreen === "live");
  const preview = useVoice((s) => s.selfPreview);
  if (!own && !native) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-line bg-bg-1 px-2 py-1 text-xs" data-testid="streaming-indicator" data-native={native || undefined}>
      <LiveBadge />
      <span className="font-medium text-fg-0">{t("voice.stream.you")}</span>
      <span className="flex-1" />
      {own && (
        <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={() => setSelfPreview(!preview)} data-testid="stream-preview-toggle">
          {preview ? t("voice.stream.preview_hide") : t("voice.stream.preview_show")}
        </Button>
      )}
      <Button variant="danger" className="min-h-8 px-2 text-xs" onClick={() => void stopScreenShare()} aria-label={t("voice.screen_off")} data-testid="stream-stop">
        {t("voice.stream.stop")}
      </Button>
    </div>
  );
}
