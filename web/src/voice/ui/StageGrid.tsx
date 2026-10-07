// SPDX-License-Identifier: Apache-2.0
import { Children, isValidElement, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { stageLayout } from "./layout";

/** The content size of an element, kept current with a ResizeObserver (0 × 0 until measured). */
export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.width === el.clientWidth && s.height === el.clientHeight ? s : { width: el.clientWidth, height: el.clientHeight }));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

const GAP = 8;

/**
 * A grid of 16:9 stage tiles (participants, screen shares, ringing tiles) sized from the container and the
 * number of tiles (`stageLayout`): as large as possible, centered, never stretched into tall strips. Before
 * the first measurement (and without ResizeObserver) it falls back to an auto-fill grid of 16:9 cells.
 */
export function StageGrid({ children, minWidth = 0, className = "", testId }: { children: ReactNode; minWidth?: number; className?: string; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useElementSize(ref);
  const items = Children.toArray(children).filter(Boolean);
  const layout = stageLayout(items.length, size.width, size.height, { gap: GAP, minWidth });
  const measured = layout.width > 0;
  const style: CSSProperties = measured
    ? { gridTemplateColumns: `repeat(${layout.cols}, ${layout.width}px)`, gridAutoRows: `${layout.height}px`, gap: GAP, justifyContent: "center", alignContent: layout.scroll ? "start" : "center" }
    : { gridTemplateColumns: `repeat(auto-fill, minmax(${Math.max(minWidth, 160)}px, 1fr))`, gap: GAP, alignContent: "start" };
  return (
    <div ref={ref} className={`grid min-h-0 min-w-0 ${layout.scroll ? "overflow-y-auto" : "overflow-hidden"} ${className}`} style={style} data-testid={testId} data-cols={layout.cols} data-rows={layout.rows}>
      {items.map((child, i) => (
        <div key={isValidElement(child) && child.key !== null ? child.key : i} className="relative aspect-video min-h-0 min-w-0" data-testid="stage-cell">
          {child}
        </div>
      ))}
    </div>
  );
}
