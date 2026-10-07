// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n";

const KEY = "tavrn.threadPanelWidth";
export const MIN_WIDTH = 320;
export const DEFAULT_WIDTH = 420;

function storedWidth(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n >= MIN_WIDTH ? n : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/** The widest the panel may get: the channel keeps at least this much next to it. */
function maxWidth(): number {
  return Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.6));
}

/**
 * The thread panel's frame: full screen on phones, a side panel on tablets and desktops whose width the user drags
 * (or changes with the arrow keys on the handle); the width is remembered on this device.
 */
export function ResizablePanel({ children }: { children: ReactNode }) {
  const t = useT();
  const [width, setWidth] = useState(storedWidth);
  const drag = useRef<{ x: number; w: number } | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, String(width));
    } catch {
      /* no storage: the width is not remembered */
    }
  }, [width]);
  const clamp = (w: number) => Math.min(maxWidth(), Math.max(MIN_WIDTH, Math.round(w)));
  return (
    <section
      aria-label={t("threads.panel")}
      className="flex min-h-0 min-w-0 flex-1 flex-col border-line bg-bg-2 md:relative md:flex-none md:border-l md:[width:var(--thread-w)]"
      style={{ "--thread-w": `${width}px` } as React.CSSProperties}
      data-testid="thread-panel"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("threads.resize")}
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        tabIndex={0}
        className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize hover:bg-accent/30 focus:bg-accent/30 focus:outline-none md:block"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, w: width };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => drag.current && setWidth(clamp(drag.current.w + drag.current.x - e.clientX))}
        onPointerUp={() => (drag.current = null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setWidth((w) => clamp(w + 24));
          if (e.key === "ArrowRight") setWidth((w) => clamp(w - 24));
        }}
        data-testid="thread-resize"
      />
      {children}
    </section>
  );
}
