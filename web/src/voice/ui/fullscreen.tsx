// SPDX-License-Identifier: Apache-2.0
/**
 * Real fullscreen for the voice stage (polish round 2): screen shares, camera tiles, the whiteboard and the
 * whole stage can go fullscreen through the Fullscreen API (`F` toggles, Escape leaves); inside, a controls
 * overlay (mute, deafen, leave, exit) appears on mouse movement or a tap. On touch devices a video wider than
 * tall turns the screen to landscape (Screen Orientation API, where it exists; refusals are ignored) until
 * fullscreen ends; the fullscreen element follows every rotation (`orientation`, 100dvw × 100dvh, contained).
 * iOS Safari only knows fullscreen for a `<video>`: there the element's video goes fullscreen natively.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useVoice } from "../store";
import { leaveVoice, toggleDeafen, toggleMute } from "../index";
import { ControlButton } from "./VoiceBar";
import { ExitFullscreenIcon, FullscreenIcon, HeadphonesIcon, HeadphonesOffIcon, LeaveIcon, MicIcon, MicOffIcon, ScreenOffIcon } from "./icons";

type FsDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type IosVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };
type LockableOrientation = ScreenOrientation & { lock?: (o: string) => Promise<void>; unlock?: () => void };

export type Orientation = "landscape" | "portrait";

const orientationApi = (): LockableOrientation | undefined => (typeof window === "undefined" ? undefined : ((window.screen?.orientation as LockableOrientation | undefined) ?? undefined));

/** A touch device (phones, tablets): their screen turns for a wide stream. */
const touchDevice = () => typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

/** The video of a fullscreen element is wider than tall (a screen share or a landscape camera). */
function wideVideo(el: HTMLElement): boolean {
  const video = el instanceof HTMLVideoElement ? el : el.querySelector("video");
  return !!video && video.videoWidth > video.videoHeight;
}

/** The orientation lock this client asked for (released when fullscreen ends). */
let locked = false;

function unlockOrientation() {
  if (!locked) return;
  locked = false;
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
  try {
    orientationApi()?.unlock?.();
  } catch {
    /* not locked or not supported */
  }
}

/** Fullscreen ended some other way (the system's back gesture, the browser's Escape): release the lock. */
function onFullscreenChange() {
  if (!fullscreenElement()) unlockOrientation();
}

/** Turns a touch device to landscape for a wide video; iOS Safari has no lock, a browser may refuse: ignored. */
function lockLandscapeFor(el: HTMLElement) {
  const api = orientationApi();
  if (!api?.lock || !touchDevice() || !wideVideo(el)) return;
  locked = true;
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  try {
    void api.lock("landscape").catch(() => undefined);
  } catch {
    /* not supported */
  }
}

/** The element currently in fullscreen (null: none). */
export function fullscreenElement(): Element | null {
  const d = document as FsDocument;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

/** Puts `el` into fullscreen; resolves with whether that worked. */
export async function enterFullscreen(el: HTMLElement): Promise<boolean> {
  const target = el as FsElement;
  try {
    if (typeof target.requestFullscreen === "function") await target.requestFullscreen({ navigationUI: "hide" });
    else if (typeof target.webkitRequestFullscreen === "function") await target.webkitRequestFullscreen();
    else {
      const video = el.querySelector("video") as IosVideo | null;
      if (!video?.webkitEnterFullscreen) return false;
      video.webkitEnterFullscreen();
      return true;
    }
  } catch {
    return false;
  }
  lockLandscapeFor(el);
  return true;
}

export async function exitFullscreen(): Promise<void> {
  const d = document as FsDocument;
  unlockOrientation();
  if (!fullscreenElement()) return;
  try {
    if (typeof d.exitFullscreen === "function") await d.exitFullscreen();
    else await d.webkitExitFullscreen?.();
  } catch {
    /* already left */
  }
}

/** Leaves fullscreen when `el` is in it, enters it otherwise. */
export async function toggleFullscreen(el: HTMLElement): Promise<void> {
  if (fullscreenElement() === el) await exitFullscreen();
  else await enterFullscreen(el);
}

const viewportOrientation = (): Orientation => (typeof window !== "undefined" && window.innerWidth > window.innerHeight ? "landscape" : "portrait");

/**
 * A fullscreen-capable element: the ref to put on it, whether it is in fullscreen, the toggle, and the viewport's
 * orientation while in fullscreen (followed on every rotation and resize, for the layout of the fullscreen view).
 */
export function useFullscreen<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [active, setActive] = useState(false);
  const [orientation, setOrientation] = useState<Orientation>(viewportOrientation);
  useEffect(() => {
    if (!active) return;
    const on = () => setOrientation(viewportOrientation());
    on();
    window.addEventListener("resize", on);
    window.addEventListener("orientationchange", on);
    const api = orientationApi();
    api?.addEventListener?.("change", on);
    return () => {
      window.removeEventListener("resize", on);
      window.removeEventListener("orientationchange", on);
      api?.removeEventListener?.("change", on);
    };
  }, [active]);
  useEffect(() => {
    const on = () => setActive(!!ref.current && fullscreenElement() === ref.current);
    document.addEventListener("fullscreenchange", on);
    document.addEventListener("webkitfullscreenchange", on);
    return () => {
      document.removeEventListener("fullscreenchange", on);
      document.removeEventListener("webkitfullscreenchange", on);
    };
  }, []);
  const toggle = useCallback(() => {
    if (ref.current) void toggleFullscreen(ref.current);
  }, []);
  return { ref, active, toggle, orientation };
}

/** Typing somewhere (or drawing on the whiteboard, which has its own `F` shortcut): no stage shortcut. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true;
  return !!target.closest(".excalidraw, [role=dialog], [role=menu]");
}

/**
 * `F` toggles fullscreen of what `pick` returns (the focused stream first), Escape leaves fullscreen (the
 * browser does that too; this covers embedders that swallow it).
 */
export function useFullscreenShortcut(pick: () => HTMLElement | null) {
  const latest = useRef(pick);
  latest.current = pick;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      if (e.key === "Escape") {
        if (fullscreenElement()) void exitFullscreen();
        return;
      }
      if (e.key !== "f" && e.key !== "F") return;
      if (fullscreenElement()) {
        e.preventDefault();
        void exitFullscreen();
        return;
      }
      const el = latest.current();
      if (!el) return;
      e.preventDefault();
      void enterFullscreen(el);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

const overlayButton = "min-h-8 min-w-8 rounded-md bg-black/60 text-fg-0 hover:bg-black/80";

/** The button on a tile that toggles its fullscreen. */
export function FullscreenButton({ active, onToggle, className = "", testId = "fullscreen-toggle" }: { active: boolean; onToggle: () => void; className?: string; testId?: string }) {
  const t = useT();
  const label = active ? t("voice.fullscreen_exit") : t("voice.fullscreen");
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={`${overlayButton} ${className}`}
      aria-label={label}
      title={`${label} (F)`}
      aria-pressed={active}
      data-testid={testId}
    >
      {active ? <ExitFullscreenIcon size={16} className="mx-auto" /> : <FullscreenIcon size={16} className="mx-auto" />}
    </button>
  );
}

/** How long the controls stay after the last movement or tap. */
export const CONTROLS_HIDE_MS = 2500;

/**
 * The controls inside a fullscreen element: mute, deafen and leave of the call plus "exit fullscreen", and on a
 * joined stream "leave stream" (`onLeaveStream`). They show on mouse movement or a tap on the fullscreen element
 * and fade out after a moment; keyboard focus keeps them visible.
 */
export function FullscreenControls({ onExit, onLeaveStream }: { onExit: () => void; onLeaveStream?: () => void }) {
  const t = useT();
  const muted = useVoice((s) => s.muted);
  const deafened = useVoice((s) => s.deafened);
  const inCall = useVoice((s) => s.status !== "idle");
  const [shown, setShown] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = ref.current?.parentElement;
    if (!frame) return;
    let timer = setTimeout(() => setShown(false), CONTROLS_HIDE_MS);
    const show = () => {
      setShown(true);
      clearTimeout(timer);
      timer = setTimeout(() => setShown(false), CONTROLS_HIDE_MS);
    };
    frame.addEventListener("pointermove", show);
    frame.addEventListener("pointerdown", show);
    return () => {
      clearTimeout(timer);
      frame.removeEventListener("pointermove", show);
      frame.removeEventListener("pointerdown", show);
    };
  }, []);
  return (
    <div
      ref={ref}
      className={`absolute inset-x-0 bottom-0 z-20 flex justify-center bg-gradient-to-t from-black/70 to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-8 transition-opacity duration-200 focus-within:pointer-events-auto focus-within:opacity-100 ${shown ? "opacity-100" : "pointer-events-none opacity-0"}`}
      data-testid="fullscreen-controls"
      data-shown={shown || undefined}
    >
      <div className="flex items-center gap-2 rounded-xl bg-bg-1/90 p-1.5 shadow-lg">
        {inCall && (
          <>
            <ControlButton label={muted ? t("voice.unmute") : t("voice.mute")} active={muted} onClick={() => void toggleMute()} testid="fullscreen-mute" className="min-h-11 min-w-11">
              {muted ? <MicOffIcon size={20} /> : <MicIcon size={20} />}
            </ControlButton>
            <ControlButton label={deafened ? t("voice.undeafen") : t("voice.deafen")} active={deafened} onClick={() => void toggleDeafen()} testid="fullscreen-deafen" className="min-h-11 min-w-11">
              {deafened ? <HeadphonesOffIcon size={20} /> : <HeadphonesIcon size={20} />}
            </ControlButton>
          </>
        )}
        <ControlButton label={t("voice.fullscreen_exit")} onClick={onExit} testid="fullscreen-exit" className="min-h-11 min-w-11">
          <ExitFullscreenIcon size={20} />
        </ControlButton>
        {onLeaveStream && (
          <ControlButton
            label={t("voice.stream.leave")}
            onClick={() => {
              void exitFullscreen();
              onLeaveStream();
            }}
            testid="fullscreen-stream-leave"
            className="min-h-11 min-w-11"
          >
            <ScreenOffIcon size={20} />
          </ControlButton>
        )}
        {inCall && (
          <ControlButton
            label={t("voice.leave")}
            solid
            onClick={() => {
              void exitFullscreen();
              void leaveVoice();
            }}
            testid="fullscreen-leave"
            className="min-h-11 min-w-11"
          >
            <LeaveIcon size={20} />
          </ControlButton>
        )}
      </div>
    </div>
  );
}
