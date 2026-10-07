// SPDX-License-Identifier: Apache-2.0
/**
 * The Excalidraw canvas of a board. This module is the lazy chunk: it imports Excalidraw statically and is
 * itself only loaded through `React.lazy` when a board is shown. It mirrors the controller (which decides
 * what is accepted) and reports local changes, the pointer and the API for the background tools.
 */
import { useEffect, useRef, useState } from "react";
import { CaptureUpdateAction, Excalidraw, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { ASSET_PATH } from "./excalidraw";
import { ordered, type WbElement, type WbFile } from "./sync";
import type { CanvasView, WhiteboardController } from "./controller";
import { t } from "../i18n";

if (typeof window !== "undefined") {
  (window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = `${location.origin}${ASSET_PATH}`;
}

/** Stable colors per participant for remote cursors (muted, readable on light and dark canvases). */
const CURSOR_COLORS = ["#4e9f97", "#8b6fb8", "#c9824a", "#5a86c4", "#b85c7a", "#6f9d4f"];

function colorOf(id: string): { background: string; stroke: string } {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const color = CURSOR_COLORS[h % CURSOR_COLORS.length]!;
  return { background: color, stroke: color };
}

export interface WhiteboardCanvasProps {
  controller: WhiteboardController;
  editable: boolean;
  langCode: string;
  /** Display name of a participant address (cursor labels). */
  nameOf: (address: string) => string;
  onApi?: (api: ExcalidrawImperativeAPI | null) => void;
}

export default function WhiteboardCanvas({ controller, editable, langCode, nameOf, onApi }: WhiteboardCanvasProps) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  // Names may change (member list loaded later) without re-attaching the view.
  const names = useRef(nameOf);
  names.current = nameOf;

  useEffect(() => {
    onApi?.(api);
    return () => onApi?.(null);
  }, [api, onApi]);

  useEffect(() => {
    if (!api) return;
    const view: CanvasView = {
      apply: (elements, { replace }) => {
        // The controller decided what is accepted: replace by id and keep the z-order of the indices.
        const restored = restoreElements(elements as never, null) as unknown as WbElement[];
        const byId = new Map<string, WbElement>(replace ? [] : (api.getSceneElementsIncludingDeleted() as unknown as WbElement[]).map((e) => [e.id, e]));
        for (const e of restored) byId.set(e.id, e);
        api.updateScene({ elements: ordered(byId.values(), { withDeleted: true }) as never, captureUpdate: CaptureUpdateAction.NEVER });
      },
      addFiles: (files: WbFile[]) => {
        if (files.length) api.addFiles(files as never);
      },
      setBackground: (color) => api.updateScene({ appState: { viewBackgroundColor: color }, captureUpdate: CaptureUpdateAction.NEVER }),
      setCursors: (cursors) => {
        const collaborators = new Map(cursors.map((c) => [c.id, { id: c.id, username: names.current(c.user), color: colorOf(c.id), pointer: { x: c.x, y: c.y, tool: "pointer" as const } }]));
        api.updateScene({ collaborators: collaborators as never });
      },
    };
    return controller.attach(view);
  }, [api, controller]);

  // Excalidraw's menu button has an icon only (WCAG 4.1.2): name it, also after Excalidraw re-renders it.
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const label = () => {
      for (const b of el.querySelectorAll<HTMLElement>(".main-menu-trigger:not([aria-label])")) b.setAttribute("aria-label", t("a11y.canvas_menu"));
    };
    label();
    const observer = new MutationObserver(label);
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={wrapper} className="absolute inset-0" data-testid="whiteboard-canvas" data-editable={editable}>
      <Excalidraw
        excalidrawAPI={setApi}
        theme="dark"
        langCode={langCode}
        viewModeEnabled={!editable}
        isCollaborating
        aiEnabled={false}
        validateEmbeddable={false}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false, clearCanvas: editable, changeViewBackgroundColor: false } }}
        onChange={(elements, appState, files) => {
          // Zoom and scroll position as attributes (no re-render): the view is per device, tests read it.
          const el = wrapper.current;
          if (el) {
            el.dataset.zoom = appState.zoom.value.toFixed(2);
            el.dataset.scroll = `${Math.round(appState.scrollX)},${Math.round(appState.scrollY)}`;
          }
          controller.localChange(elements as unknown as WbElement[], appState.viewBackgroundColor, Object.values(files) as unknown as WbFile[]);
        }}
        onPointerUpdate={({ pointer }) => controller.pointer(pointer.x, pointer.y)}
      />
    </div>
  );
}
