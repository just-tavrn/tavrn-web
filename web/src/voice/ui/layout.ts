// SPDX-License-Identifier: Apache-2.0
/**
 * Layout math of the voice stage (design note 4.5 item 4, polish round 2): every tile is 16:9, and the grid
 * takes its columns and rows from the container size and the number of tiles so the tiles are as large as
 * possible. Landscape containers (desktop) only use layouts with at least as many columns as rows (two people
 * side by side, 3–4 as 2×2, 5–6 as 3×2, 7–9 as 3×3), portrait containers (phones) at least as many rows as
 * columns (two people stacked). When even the best layout makes tiles smaller than `minWidth`, the grid keeps
 * that width and scrolls instead.
 */

export const TILE_ASPECT = 16 / 9;

export interface StageLayout {
  cols: number;
  rows: number;
  /** Tile size in CSS pixels (whole pixels). */
  width: number;
  height: number;
  /** The tiles do not fit: the grid scrolls vertically. */
  scroll: boolean;
}

export interface StageLayoutOptions {
  /** Gap between tiles (px). */
  gap?: number;
  /** Width / height of a tile. */
  aspect?: number;
  /** Below this tile width the grid scrolls instead of shrinking the tiles further. */
  minWidth?: number;
}

/** Columns, rows and tile size for `count` tiles in a `width` × `height` container. */
export function stageLayout(count: number, width: number, height: number, opts: StageLayoutOptions = {}): StageLayout {
  const gap = opts.gap ?? 8;
  const aspect = opts.aspect ?? TILE_ASPECT;
  if (count <= 0 || width <= 0 || height <= 0) return { cols: 1, rows: count > 0 ? count : 0, width: 0, height: 0, scroll: false };
  const landscape = width >= height;
  let best: { cols: number; rows: number; width: number } | null = null;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    // A layout with an empty last row (e.g. 2 columns for 1 tile) is never better than fewer columns.
    if ((cols - 1) * rows >= count && cols > 1) continue;
    if (count > 1 && (landscape ? cols < rows : rows < cols)) continue;
    const w = Math.min((width - gap * (cols - 1)) / cols, ((height - gap * (rows - 1)) / rows) * aspect);
    if (w <= 0) continue;
    // Equal sizes: the layout with fewer columns (more natural reading order).
    if (!best || w > best.width + 0.5) best = { cols, rows, width: w };
  }
  const minWidth = Math.min(opts.minWidth ?? 0, width);
  if (!best || best.width < minWidth) {
    const cols = Math.max(1, Math.min(count, Math.floor((width + gap) / (minWidth + gap))));
    const w = Math.floor((width - gap * (cols - 1)) / cols);
    const rows = Math.ceil(count / cols);
    const h = Math.floor(w / aspect);
    return { cols, rows, width: w, height: h, scroll: rows * h + (rows - 1) * gap > height };
  }
  const w = Math.floor(best.width);
  return { cols: best.cols, rows: best.rows, width: w, height: Math.floor(w / aspect), scroll: false };
}
