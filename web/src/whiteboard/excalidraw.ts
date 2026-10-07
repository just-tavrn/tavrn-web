// SPDX-License-Identifier: Apache-2.0
/**
 * Lazy loading of Excalidraw (`@excalidraw/excalidraw`, MIT): the module and its stylesheet are fetched only
 * when a board is shown or exported, never with the app shell. Its fonts are served by this node under
 * `/assets/excalidraw/fonts/` (copied by the Vite plugin in `vite.config.ts`): no CDN, and the CSP keeps
 * `font-src 'self'`.
 */
import type { Scene } from "./controller";

type ExcalidrawModule = typeof import("@excalidraw/excalidraw");

let loading: Promise<ExcalidrawModule> | null = null;

/** Where Excalidraw finds its fonts. */
export const ASSET_PATH = "/assets/excalidraw/";

export function loadExcalidraw(): Promise<ExcalidrawModule> {
  if (!loading) {
    (window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = `${location.origin}${ASSET_PATH}`;
    // The stylesheet comes with the canvas chunk (WhiteboardCanvas.tsx); exports need none.
    loading = import("@excalidraw/excalidraw").catch((e: unknown) => {
        loading = null;
        throw e;
      });
  }
  return loading;
}

/** Scene → the arguments of Excalidraw's export functions. */
function exportArgs(scene: Scene) {
  return {
    elements: scene.elements as never,
    files: Object.fromEntries(scene.files.map((f) => [f.id, f])) as never,
    appState: { viewBackgroundColor: scene.background, exportBackground: true, exportWithDarkMode: false },
  };
}

export async function exportPng(scene: Scene): Promise<Blob> {
  const { exportToBlob } = await loadExcalidraw();
  return exportToBlob({ ...exportArgs(scene), mimeType: "image/png", exportPadding: 16 });
}

export async function exportSvg(scene: Scene): Promise<Blob> {
  const { exportToSvg } = await loadExcalidraw();
  const svg = await exportToSvg({ ...exportArgs(scene), exportPadding: 16 });
  return new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Waits for an idle moment of the main thread (thumbnails never compete with drawing). */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 1_000 });
    else setTimeout(resolve, 0);
  });
}

/**
 * A small WebP image of the board for stage tiles (a data URL below the thumbnail limit), or null for an
 * empty board. Rendered when the main thread is idle, smaller again if the first try is too large.
 */
export async function renderThumbnail(scene: Scene): Promise<string | null> {
  if (scene.elements.length === 0) return null;
  const { exportToBlob } = await loadExcalidraw();
  await idle();
  for (const [size, quality] of [[320, 0.7], [200, 0.5]] as const) {
    const blob = await exportToBlob({ ...exportArgs(scene), mimeType: "image/webp", quality, maxWidthOrHeight: size, exportPadding: 8 });
    const url = await blobToDataUrl(blob);
    if (url.length <= 60_000 && url.startsWith("data:image/webp")) return url;
  }
  return null;
}
