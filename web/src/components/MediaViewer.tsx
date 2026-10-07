// SPDX-License-Identifier: Apache-2.0
/**
 * The media viewer (design note 4.11): images and videos of one message in a modal. Zoom (wheel, buttons,
 * double-click, pinch), pan by dragging while zoomed, previous/next with the arrow keys, buttons or a
 * swipe, a download icon and "open original"; Escape or a click on the backdrop closes it. The state is
 * the pure {@link viewerReducer} (unit-tested).
 */
import { useEffect, useReducer, useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { DownloadButton, mediaKind, useAttachmentUrl, type ViewAttachment } from "./AttachmentView";
import { isSvg } from "../lib/preview";
import { useFocusTrap } from "../lib/focusTrap";
import { platform } from "../platform";

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;

export interface ViewerState {
  index: number;
  count: number;
  zoom: number;
  x: number;
  y: number;
}

export type ViewerAction =
  | { type: "next" }
  | { type: "prev" }
  | { type: "goto"; index: number }
  | { type: "zoom"; factor: number }
  | { type: "set-zoom"; zoom: number }
  | { type: "toggle-zoom" }
  | { type: "pan"; dx: number; dy: number }
  | { type: "reset" };

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));

export function initialViewer(count: number, start: number): ViewerState {
  return { index: clamp(start, 0, Math.max(0, count - 1)), count, zoom: 1, x: 0, y: 0 };
}

export function viewerReducer(s: ViewerState, a: ViewerAction): ViewerState {
  const fresh = (index: number): ViewerState => ({ ...s, index: clamp(index, 0, Math.max(0, s.count - 1)), zoom: 1, x: 0, y: 0 });
  const zoomed = (zoom: number): ViewerState => {
    const z = clamp(Math.round(zoom * 100) / 100, MIN_ZOOM, MAX_ZOOM);
    // Back at 1×: centered again; otherwise the pan scales with the zoom.
    return z === 1 ? { ...s, zoom: 1, x: 0, y: 0 } : { ...s, zoom: z, x: (s.x * z) / s.zoom, y: (s.y * z) / s.zoom };
  };
  switch (a.type) {
    case "next":
      return s.index < s.count - 1 ? fresh(s.index + 1) : s;
    case "prev":
      return s.index > 0 ? fresh(s.index - 1) : s;
    case "goto":
      return fresh(a.index);
    case "zoom":
      return zoomed(s.zoom * a.factor);
    case "set-zoom":
      return zoomed(a.zoom);
    case "toggle-zoom":
      return zoomed(s.zoom > 1 ? 1 : 2);
    case "pan":
      return s.zoom > 1 ? { ...s, x: s.x + a.dx, y: s.y + a.dy } : s;
    case "reset":
      return { ...s, zoom: 1, x: 0, y: 0 };
  }
}

/** Horizontal swipe distance (px) that changes the item. */
const SWIPE = 60;

function Stage({ item, state, dispatch }: { item: ViewAttachment; state: ViewerState; dispatch: (a: ViewerAction) => void }) {
  const t = useT();
  const { url, failed } = useAttachmentUrl(item, true);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startX: number; startY: number; pinch: number | null; moved: boolean }>({ startX: 0, startY: 0, pinch: null, moved: false });
  if (failed) return <p className="text-sm text-fg-1">⚠ {t("attachment.decrypt_failed", { name: item.name })}</p>;
  if (!url) return <div role="status" className="h-48 w-72 max-w-[80vw] animate-pulse rounded-md bg-white/10" aria-label={t("attachment.loading", { name: item.name })} />;
  if (mediaKind(item.mime, item.name) === "file") return <p className="text-sm text-fg-1">{item.name}</p>;
  if (mediaKind(item.mime, item.name) === "video") return <video src={url} controls autoPlay playsInline className="max-h-[80dvh] max-w-[92vw] rounded-md" data-testid="viewer-video" />;
  const distance = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  return (
    <img
      src={url}
      alt={item.name}
      draggable={false}
      data-testid="viewer-image"
      data-zoom={state.zoom}
      className={`max-h-[80dvh] max-w-[92vw] touch-none select-none rounded-md ${state.zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"}`}
      style={{ transform: `translate(${state.x}px, ${state.y}px) scale(${state.zoom})`, transition: pointers.current.size ? "none" : "transform 120ms ease-out" }}
      onDoubleClick={() => dispatch({ type: "toggle-zoom" })}
      onWheel={(e) => dispatch({ type: "zoom", factor: e.deltaY < 0 ? 1.2 : 1 / 1.2 })}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        gesture.current = { startX: e.clientX, startY: e.clientY, pinch: pointers.current.size === 2 ? distance() : null, moved: false };
      }}
      onPointerMove={(e) => {
        const last = pointers.current.get(e.pointerId);
        if (!last) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.current.size === 2 && gesture.current.pinch) {
          const d = distance();
          if (d > 0) dispatch({ type: "zoom", factor: d / gesture.current.pinch });
          gesture.current.pinch = d;
          return;
        }
        if (state.zoom > 1) dispatch({ type: "pan", dx: e.clientX - last.x, dy: e.clientY - last.y });
        gesture.current.moved = true;
      }}
      onPointerUp={(e) => {
        pointers.current.delete(e.pointerId);
        // A horizontal swipe at 1× changes the item.
        if (state.zoom === 1 && pointers.current.size === 0 && gesture.current.pinch === null) {
          const dx = e.clientX - gesture.current.startX;
          if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(e.clientY - gesture.current.startY)) dispatch({ type: dx < 0 ? "next" : "prev" });
        }
        if (pointers.current.size < 2) gesture.current.pinch = null;
      }}
      onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
    />
  );
}

function OpenOriginal({ item }: { item: ViewAttachment }) {
  const t = useT();
  const { url } = useAttachmentUrl(item, true);
  // The desktop app opens no browser tabs of its own; the download icon saves the original there.
  if (platform().isDesktop) return null;
  return (
    <button type="button" disabled={!url} onClick={() => url && window.open(url, "_blank", "noopener")} className="min-h-9 min-w-9 rounded text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-40" aria-label={t("media.open_original")} title={t("media.open_original")} data-testid="viewer-original">
      ↗
    </button>
  );
}

export default function MediaViewer({ items, start, onClose }: { items: ViewAttachment[]; start: number; onClose: () => void }) {
  const t = useT();
  const [state, dispatch] = useReducer(viewerReducer, initialViewer(items.length, start));
  const close = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const item = items[state.index];
  const root = useRef<HTMLDivElement>(null);
  // Tab stays inside the viewer (focus and its return are handled below).
  useFocusTrap(root, !!item, { initial: () => close.current, restore: false });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === "ArrowRight") dispatch({ type: "next" });
      else if (e.key === "ArrowLeft") dispatch({ type: "prev" });
      else if (e.key === "+" || e.key === "=") dispatch({ type: "zoom", factor: 1.25 });
      else if (e.key === "-") dispatch({ type: "zoom", factor: 0.8 });
      else if (e.key === "0") dispatch({ type: "reset" });
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus({ preventScroll: true });
    };
  }, []);
  if (!item) return null;
  const tool = "min-h-9 min-w-9 rounded text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-40";
  return createPortal(
    <div ref={root} role="dialog" aria-modal="true" aria-label={t("media.viewer", { name: item.name })} className="fixed inset-0 z-[80] flex flex-col bg-black/90 text-white" data-testid="media-viewer" data-index={state.index}>
      <div className="flex shrink-0 items-center gap-1 px-3 py-2" style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}>
        <p className="min-w-0 flex-1 truncate text-sm" title={item.name}>
          {item.name}
          {items.length > 1 && <span className="ml-2 text-white/60" data-testid="viewer-counter">{t("media.counter", { index: state.index + 1, count: items.length })}</span>}
        </p>
        {mediaKind(item.mime, item.name) === "image" && (
          <>
            <button type="button" className={tool} onClick={() => dispatch({ type: "zoom", factor: 0.8 })} disabled={state.zoom <= MIN_ZOOM} aria-label={t("media.zoom_out")} title={t("media.zoom_out")}>
              −
            </button>
            <span className="w-12 text-center text-xs tabular-nums text-white/70" data-testid="viewer-zoom">{Math.round(state.zoom * 100)} %</span>
            <button type="button" className={tool} onClick={() => dispatch({ type: "zoom", factor: 1.25 })} disabled={state.zoom >= MAX_ZOOM} aria-label={t("media.zoom_in")} title={t("media.zoom_in")}>
              +
            </button>
          </>
        )}
        <DownloadButton a={item} className="!text-white/80 hover:!bg-white/10 hover:!text-white" />
        {/* SVG is download-only: never opened as a document (design note 4.12). */}
        {!isSvg(item.mime, item.name) && <OpenOriginal item={item} />}
        <button ref={close} type="button" className={tool} onClick={onClose} aria-label={t("common.close")} title={t("common.close")} data-testid="viewer-close">
          ✕
        </button>
      </div>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        onClick={(e) => {
          // A click on the backdrop (not on the media or the arrows) closes.
          if (e.target === e.currentTarget) onClose();
        }}
        data-testid="viewer-backdrop"
      >
        <Stage key={item.id} item={item} state={state} dispatch={dispatch} />
        {items.length > 1 && (
          <>
            <button type="button" className="absolute left-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-xl hover:bg-black/70 disabled:opacity-30" onClick={() => dispatch({ type: "prev" })} disabled={state.index === 0} aria-label={t("media.previous")} data-testid="viewer-prev">
              ‹
            </button>
            <button type="button" className="absolute right-2 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-xl hover:bg-black/70 disabled:opacity-30" onClick={() => dispatch({ type: "next" })} disabled={state.index === items.length - 1} aria-label={t("media.next")} data-testid="viewer-next">
              ›
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
