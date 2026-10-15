// SPDX-License-Identifier: Apache-2.0
/**
 * The whiteboard of one conversation, full screen: open / join / leave / close, the owner's tools
 * (who can edit, scenes, background) and for everyone "Save as image" and "Share to channel". The canvas
 * (Excalidraw) is a lazy chunk loaded only here.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { SceneInfo } from "@tavrn/sdk";
import { useLocale, useT } from "../i18n";
import { api as homeApi } from "../lib/api";
import { withBackupKey } from "../stores/mls";
import { describeError, toastError, useToasts } from "../stores/toasts";
import { confirmDialog } from "../components/Confirm";
import { Button, Dialog, ErrorText, Input } from "../components/ui";
import { loadDraft, useBoardContent, useWhiteboardController, type BoardContext } from "./store";
import { exportPng, exportSvg, loadExcalidraw } from "./excalidraw";
import { openBoard } from "./stage";
import { newSceneId, sceneLibrary, SceneError } from "./scenes";
import { shareImage, type ShareTarget } from "./share";
import { stamp, type WbElement } from "./sync";
import type { WhiteboardController } from "./controller";
import { TIMING } from "./protocol";
import { saveFile } from "../platform/saveFile";

const WhiteboardCanvas = lazy(() => import("./WhiteboardCanvas"));

export interface Member {
  address: string;
  name: string;
}

export interface WhiteboardSessionProps {
  ctx: BoardContext;
  /** Channel or conversation name. */
  title: string;
  /** Where "Back" leads (the channel or conversation). */
  backTo: string;
  /** May open a board here (use_whiteboard, voice: also connect). */
  canOpen: boolean;
  /** May close someone else's board (manage_channels). */
  canModerate: boolean;
  /** Encryption is ready (or not needed); `notReady` explains why not. */
  ready: boolean;
  notReady?: ReactNode;
  /** Members of the conversation (names for cursors and the grant list). */
  members: Member[];
  shareTargets: ShareTarget[];
  /** `fullscreen` (the route) or `embedded` (fills its parent, e.g. a stage tile). */
  layout?: "fullscreen" | "embedded";
  /** Replaces the "Back" link (stage tiles: focus, maximize, popout). */
  headerStart?: ReactNode;
}


function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("image"));
    img.src = dataUrl;
  });
}

/** A fingerprint of the scene (element states and background): autosave only after real changes. */
function sceneStamp(c: WhiteboardController): string {
  return [...c.elements.values()].map((e) => `${e.id}:${stamp(e)}`).sort().join(",") + `|${c.background}`;
}

const library = sceneLibrary(homeApi, withBackupKey);

export function WhiteboardSession(p: WhiteboardSessionProps) {
  const t = useT();
  const c = useWhiteboardController(p.ctx);
  // The element counts and the texts below follow the board coalesced (strokes and cursors alone do not re-render).
  useBoardContent(c);
  const locale = useLocale((s) => s.locale);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<null | "permissions" | "scenes" | "background" | "export" | "share">(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const [current, setCurrent] = useState<{ id: string; name: string } | null>(null);
  const savedStamp = useRef<string | null>(null);
  const role = c.role;
  const owner = c.session?.owner;
  const nameOf = useCallback((address: string) => p.members.find((m) => m.address === address)?.name ?? address.split("@")[0] ?? address, [p.members]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  // Leaving the last board view leaves the session (viewers); the owner's board keeps running until closed.
  // Decided a moment later, so a remount (another layout, React's development double mount) keeps it.
  useEffect(() => {
    c.views++;
    return () => {
      c.views--;
      setTimeout(() => c.views === 0 && c.leave(), 0);
    };
  }, [c]);

  // The owner's device after a reload: the board continues from the local draft.
  useEffect(() => {
    if (role !== "owner" || c.elements.size > 0) return;
    let stale = false;
    void loadDraft(p.ctx.domain, p.ctx.conversationId).then((draft) => {
      if (!stale && draft && c.elements.size === 0) c.replaceScene(draft);
    });
    return () => {
      stale = true;
    };
  }, [role, c, p.ctx.domain, p.ctx.conversationId]);

  // Autosave of the current library scene every 30 s when it changed.
  useEffect(() => {
    if (role !== "owner" || !current) return;
    const timer = setInterval(() => {
      const s = sceneStamp(c);
      if (s === savedStamp.current) return;
      savedStamp.current = s;
      void library.save(current.id, c.scene(), { thumbnail: c.thumbnailUrl }).catch(() => (savedStamp.current = null));
    }, TIMING.autosaveMs);
    return () => clearInterval(timer);
  }, [role, current, c]);

  const open = () =>
    run(async () => {
      await openBoard(c, p.ctx);
    });
  const close = async () => {
    if (!(await confirmDialog({ title: t("whiteboard.close"), text: t("whiteboard.close_confirm"), confirmLabel: t("whiteboard.close"), danger: true }))) return;
    void run(async () => {
      await c.close();
      setCurrent(null);
    });
  };

  const header = (
    <header className="flex h-12 shrink-0 select-none items-center gap-2 border-b border-line bg-bg-1 px-2 sm:px-3">
      {p.headerStart ?? (
        <Link to={p.backTo} className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md text-fg-1 hover:bg-bg-3 hover:text-fg-0" aria-label={t("whiteboard.back")}>
          ←
        </Link>
      )}
      <span aria-hidden="true">🖍</span>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-semibold" data-testid="whiteboard-title">
          {t("whiteboard.title")} · {p.title}
        </h1>
        {c.session && (
          <p className="truncate text-xs text-fg-2" data-testid="whiteboard-role">
            {role === "owner" ? t("whiteboard.you_present") : t("whiteboard.presented_by", { name: nameOf(owner ?? "") })}
            {" · "}
            {role === "owner" ? (c.session.open_for_all ? t("whiteboard.open_hint") : c.session.grants.length ? t("whiteboard.granted_hint", { count: c.session.grants.length }) : t("whiteboard.locked_hint")) : role === "editor" ? t("whiteboard.can_edit") : t("whiteboard.view_only")}
            {role === "owner" && c.participants.size > 0 && ` · ${t("whiteboard.watching", { count: c.participants.size })}`}
          </p>
        )}
      </div>
      {c.joined && <Toolbar c={c} busy={busy} canModerate={p.canModerate} menuOpen={menuOpen} setMenuOpen={setMenuOpen} onPanel={setPanel} onLeave={() => c.leave()} onClose={close} />}
    </header>
  );

  let body: ReactNode;
  if (!p.ready) {
    body = <Centered>{p.notReady}</Centered>;
  } else if (c.ended && !c.session) {
    body = (
      <Centered>
        <p className="text-sm text-fg-1" data-testid="whiteboard-ended">
          {t("whiteboard.closed")}
        </p>
        <Link to={p.backTo} className="text-sm font-medium text-accent hover:underline">
          {t("whiteboard.back")}
        </Link>
      </Centered>
    );
  } else if (!c.session) {
    body = (
      <Centered>
        <p className="text-sm text-fg-1">{t("whiteboard.none")}</p>
        <p className="max-w-sm text-xs text-fg-2">{t("whiteboard.none_hint")}</p>
        {p.canOpen ? (
          <Button disabled={busy} onClick={() => void open()}>
            {t("whiteboard.open")}
          </Button>
        ) : (
          <p className="text-xs text-fg-2">{t("whiteboard.open_forbidden")}</p>
        )}
      </Centered>
    );
  } else if (!c.joined) {
    body = (
      <Centered>
        {c.thumbnailUrl && <img src={c.thumbnailUrl} alt="" className="max-h-40 rounded-md border border-line" data-testid="whiteboard-preview" />}
        <p className="text-sm text-fg-1">{t("whiteboard.presenting", { name: nameOf(owner ?? "") })}</p>
        <Button onClick={() => c.join()}>{t("whiteboard.join")}</Button>
        {c.ownedElsewhere && (
          <Button variant="ghost" disabled={busy} onClick={() => void run(() => c.takeOver())}>
            {t("whiteboard.take_over")}
          </Button>
        )}
        {p.canModerate && role !== "owner" && (
          <Button variant="ghost" disabled={busy} onClick={() => void close()}>
            {t("whiteboard.close")}
          </Button>
        )}
      </Centered>
    );
  } else {
    const visible = [...c.elements.values()].filter((e) => !e.isDeleted);
    body = (
      <div className="relative min-h-0 flex-1" data-testid="whiteboard-board" data-role={role ?? ""} data-elements={visible.length} data-images={visible.filter((e) => e.type === "image").length} data-background={c.background}>
        {/* The texts of the board for screen readers (the canvas itself is not accessible). */}
        <ul className="sr-only" aria-label={t("whiteboard.texts")} data-testid="whiteboard-texts">
          {visible.filter((e) => e.type === "text" && typeof e.text === "string").map((e) => (
            <li key={e.id}>{String(e.text)}</li>
          ))}
        </ul>
        {role !== "owner" && !c.synced && <p className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-md bg-bg-2 px-3 py-1 text-xs text-fg-2">{t("whiteboard.syncing")}</p>}
        <Suspense fallback={<Centered>{t("whiteboard.loading")}</Centered>}>
          <WhiteboardCanvas controller={c} editable={role === "owner" || role === "editor"} langCode={locale === "de" ? "de-DE" : "en"} nameOf={nameOf} onApi={setExcalidraw} />
        </Suspense>
      </div>
    );
  }

  // The full page keeps the header and the canvas's toolbars out of the system bars and notches (the Android app
  // draws edge to edge, docs/ANDROID.md "System bars"), like the other full-screen views.
  const frame = p.layout === "embedded" ? "relative h-full w-full" : "fixed inset-0 z-40 pt-[var(--safe-top)] pr-[var(--safe-right)] pb-[var(--safe-bottom)] pl-[var(--safe-left)]";
  return (
    <div className={`${frame} flex flex-col bg-bg-0`} data-testid="whiteboard">
      {header}
      {body}
      {panel === "permissions" && <PermissionsPanel c={c} members={p.members} nameOf={nameOf} onClose={() => setPanel(null)} />}
      {panel === "scenes" && <ScenesPanel c={c} current={current} onCurrent={(s) => { setCurrent(s); savedStamp.current = s ? sceneStamp(c) : null; }} onClose={() => setPanel(null)} />}
      {panel === "background" && <BackgroundPanel c={c} excalidraw={excalidraw} onClose={() => setPanel(null)} />}
      {panel === "export" && <ExportPanel c={c} title={p.title} onClose={() => setPanel(null)} />}
      {panel === "share" && <SharePanel c={c} targets={p.shareTargets} onClose={() => setPanel(null)} />}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">{children}</div>;
}

/** The board's actions: inline on wider screens, collapsed into a menu on phones. */
function Toolbar(p: {
  c: WhiteboardController;
  busy: boolean;
  canModerate: boolean;
  menuOpen: boolean;
  setMenuOpen: (v: boolean) => void;
  onPanel: (panel: "permissions" | "scenes" | "background" | "export" | "share") => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const owner = p.c.role === "owner";
  const actions: Array<{ key: string; label: string; onClick: () => void; danger?: boolean }> = [];
  if (owner) {
    actions.push({ key: "permissions", label: t("whiteboard.permissions"), onClick: () => p.onPanel("permissions") });
    actions.push({ key: "scenes", label: t("whiteboard.scenes"), onClick: () => p.onPanel("scenes") });
    actions.push({ key: "background", label: t("whiteboard.background"), onClick: () => p.onPanel("background") });
  }
  actions.push({ key: "export", label: t("whiteboard.save_image"), onClick: () => p.onPanel("export") });
  actions.push({ key: "share", label: t("whiteboard.share"), onClick: () => p.onPanel("share") });
  if (!owner) actions.push({ key: "leave", label: t("whiteboard.leave"), onClick: p.onLeave });
  if (owner || p.canModerate) actions.push({ key: "close", label: t("whiteboard.close"), onClick: p.onClose, danger: true });
  return (
    <>
      <div className="hidden items-center gap-1 lg:flex">
        {actions.map((a) => (
          <Button key={a.key} variant={a.danger ? "danger" : "ghost"} className="min-h-9 px-2 text-xs" disabled={p.busy} onClick={a.onClick}>
            {a.label}
          </Button>
        ))}
      </div>
      <div className="relative lg:hidden">
        <button type="button" aria-label={t("whiteboard.menu")} aria-expanded={p.menuOpen} onClick={() => p.setMenuOpen(!p.menuOpen)} className="min-h-10 min-w-10 rounded-md text-lg text-fg-1 hover:bg-bg-3">
          ⋯
        </button>
        {p.menuOpen && (
          <div role="menu" className="absolute right-0 top-11 z-50 w-56 select-none rounded-md border border-line bg-bg-1 p-1 shadow-xl">
            {actions.map((a) => (
              <button
                key={a.key}
                type="button"
                role="menuitem"
                disabled={p.busy}
                onClick={() => {
                  p.setMenuOpen(false);
                  a.onClick();
                }}
                className={`block min-h-10 w-full rounded px-3 text-left text-sm hover:bg-bg-3 ${a.danger ? "text-danger" : "text-fg-0"}`}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function PermissionsPanel({ c, members, nameOf, onClose }: { c: WhiteboardController; members: Member[]; nameOf: (a: string) => string; onClose: () => void }) {
  const t = useT();
  const s = c.session;
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const me = s.owner;
  // Participants who joined, plus everyone already granted.
  const candidates = [...new Set([...[...c.participants.values()].map((x) => x.user), ...s.grants])].filter((a) => a !== me).sort();
  const apply = async (open_for_all: boolean, grants: string[]) => {
    setBusy(true);
    try {
      await c.setPermissions({ open_for_all, grants });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("whiteboard.permissions")} open onClose={onClose}>
      <div className="space-y-4">
        <div className="flex gap-2">
          <Button variant={s.open_for_all ? "primary" : "ghost"} aria-pressed={s.open_for_all} disabled={busy} onClick={() => void apply(true, s.grants)}>
            {t("whiteboard.open_for_all")}
          </Button>
          <Button variant={!s.open_for_all ? "primary" : "ghost"} aria-pressed={!s.open_for_all} disabled={busy} onClick={() => void apply(false, s.grants)}>
            {t("whiteboard.lock")}
          </Button>
        </div>
        <p className="text-xs text-fg-2">{s.open_for_all ? t("whiteboard.open_hint") : t("whiteboard.locked_hint")}</p>
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-2">{t("whiteboard.participants")}</p>
          {candidates.length === 0 && <p className="text-sm text-fg-2">{t("whiteboard.no_participants")}</p>}
          <ul className="space-y-1">
            {candidates.map((a) => {
              const granted = s.grants.includes(a);
              return (
                <li key={a}>
                  <label className="flex min-h-10 items-center gap-2 text-sm">
                    <input type="checkbox" checked={granted || s.open_for_all} disabled={busy || s.open_for_all} onChange={() => void apply(s.open_for_all, granted ? s.grants.filter((g) => g !== a) : [...s.grants, a])} aria-label={t("whiteboard.grant_label", { name: nameOf(a) })} />
                    <span className="min-w-0 flex-1 truncate">{nameOf(a)}</span>
                    <span className="truncate text-xs text-fg-2">{a}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
        {members.length > 0 && <p className="text-xs text-fg-2">{t("whiteboard.participants_hint")}</p>}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function sceneErrorText(t: (k: string) => string, e: unknown): string {
  return e instanceof SceneError ? t(`whiteboard.error.${e.code}`) : describeError(e);
}

function ScenesPanel({ c, current, onCurrent, onClose }: { c: WhiteboardController; current: { id: string; name: string } | null; onCurrent: (s: { id: string; name: string } | null) => void; onClose: () => void }) {
  const t = useT();
  const [list, setList] = useState<{ items: SceneInfo[]; max: number } | null>(null);
  const [name, setName] = useState(current?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The scene being renamed in its row (inline, instead of the page-blocking `window.prompt`). */
  const [renaming, setRenaming] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const r = await library.list();
      setList({ items: r.items, max: r.max_scenes });
    } catch (e) {
      setError(sceneErrorText(t, e));
    }
  }, [t]);
  useEffect(() => void reload(), [reload]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(sceneErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  const save = (asNew: boolean) =>
    act(async () => {
      const n = name.trim() || t("whiteboard.untitled");
      const id = !asNew && current ? current.id : newSceneId();
      await library.save(id, c.scene(), { name: n, thumbnail: c.thumbnailUrl });
      onCurrent({ id, name: n });
      useToasts.getState().push({ kind: "info", title: t("whiteboard.scene_saved") });
    });
  return (
    <Dialog title={t("whiteboard.scenes")} open onClose={onClose}>
      <div className="space-y-3">
        <ErrorText>{error}</ErrorText>
        {current && <p className="text-xs text-fg-2">{t("whiteboard.current_scene", { name: current.name })}</p>}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input aria-label={t("whiteboard.scene_name")} placeholder={t("whiteboard.scene_name")} value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
          <Button disabled={busy} onClick={() => void save(false)}>
            {t("whiteboard.save_scene")}
          </Button>
        </div>
        {current && (
          <Button variant="ghost" disabled={busy} onClick={() => void save(true)}>
            {t("whiteboard.save_as_new")}
          </Button>
        )}
        {list && <p className="text-xs text-fg-2">{t("whiteboard.scene_count", { count: list.items.length, max: list.max })}</p>}
        {list?.items.length === 0 && <p className="text-sm text-fg-2">{t("whiteboard.no_scenes")}</p>}
        <ul className="max-h-72 space-y-1 overflow-y-auto" data-testid="scene-list">
          {list?.items.map((s) => (
            <li key={s.id} className="flex items-center gap-1 rounded-md border border-line px-2 py-1" data-testid="scene">
              {renaming === s.id ? (
                <SceneRename
                  name={s.name}
                  busy={busy}
                  onCancel={() => setRenaming(null)}
                  onSave={(next) => {
                    setRenaming(null);
                    void act(async () => {
                      await library.rename(s.id, next);
                      if (current?.id === s.id) onCurrent({ id: s.id, name: next });
                    });
                  }}
                />
              ) : (
                <>
              <span className="min-w-0 flex-1 truncate text-sm">{s.name}</span>
              <Button
                variant="ghost"
                className="min-h-8 px-2 text-xs"
                disabled={busy}
                onClick={async () => {
                  if (!(await confirmDialog({ text: t("whiteboard.load_confirm", { name: s.name }), confirmLabel: t("whiteboard.load"), danger: true }))) return;
                  void act(async () => {
                    const scene = await library.load(s.id);
                    c.replaceScene(scene);
                    onCurrent({ id: s.id, name: s.name });
                    setName(s.name);
                    onClose();
                  });
                }}
              >
                {t("whiteboard.load")}
              </Button>
              <Button
                variant="ghost"
                className="min-h-8 px-2 text-xs"
                disabled={busy}
                onClick={() => setRenaming(s.id)}
                aria-label={t("whiteboard.rename_named", { name: s.name })}
                data-testid="scene-rename"
              >
                {t("whiteboard.rename")}
              </Button>
              <Button
                variant="ghost"
                className="min-h-8 px-2 text-xs text-danger"
                disabled={busy}
                onClick={async () => {
                  if (!(await confirmDialog({ text: t("whiteboard.delete_confirm", { name: s.name }), confirmLabel: t("whiteboard.delete"), danger: true }))) return;
                  void act(async () => {
                    await library.remove(s.id);
                    if (current?.id === s.id) onCurrent(null);
                  });
                }}
              >
                {t("whiteboard.delete")}
              </Button>
                </>
              )}
            </li>
          ))}
        </ul>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Renaming a scene in its row of the library: a field with the current name (selected), Save (or Enter) with a
 * name of 1 to 64 characters, Cancel (or Escape) keeps the old one.
 */
export function SceneRename({ name, busy, onSave, onCancel }: { name: string; busy: boolean; onSave: (name: string) => void; onCancel: () => void }) {
  const t = useT();
  const [value, setValue] = useState(name);
  const next = value.trim();
  const valid = next.length > 0 && next.length <= 64;
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) onSave(next);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // The library dialog stays open: only the rename is cancelled.
        e.stopPropagation();
        onCancel();
      }}
      data-testid="scene-rename-form"
    >
      <Input aria-label={t("whiteboard.scene_name")} value={value} maxLength={64} autoFocus onFocus={(e) => e.currentTarget.select()} onChange={(e) => setValue(e.target.value)} className="min-w-0 flex-1" />
      <Button type="submit" className="min-h-8 px-2 text-xs" disabled={busy || !valid}>
        {t("common.save")}
      </Button>
      <Button type="button" variant="ghost" className="min-h-8 px-2 text-xs" onClick={onCancel}>
        {t("common.cancel")}
      </Button>
    </form>
  );
}

const BACKGROUND_MARK = "tavrnBackground";

function isBackground(e: { customData?: Record<string, unknown> } | WbElement): boolean {
  return !!(e.customData as Record<string, unknown> | undefined)?.[BACKGROUND_MARK];
}

function BackgroundPanel({ c, excalidraw, onClose }: { c: WhiteboardController; excalidraw: ExcalidrawImperativeAPI | null; onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const hasImage = [...c.elements.values()].some((e) => isBackground(e) && !e.isDeleted);
  const setColor = (color: string) => excalidraw?.updateScene({ appState: { viewBackgroundColor: color } });

  const removeImage = async () => {
    if (!excalidraw) return;
    const { newElementWith, CaptureUpdateAction } = await loadExcalidraw();
    const next = excalidraw.getSceneElementsIncludingDeleted().map((e) => (isBackground(e as never) && !e.isDeleted ? newElementWith(e, { isDeleted: true }) : e));
    excalidraw.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  };

  const setImage = async (f: File) => {
    if (!excalidraw) return;
    setBusy(true);
    setError(null);
    try {
      // Through the media pipeline of the home node: format checked, metadata removed, fit into 1280 px.
      const converted = await homeApi.whiteboards.convertBackground(f);
      const dataURL = await blobToDataUrl(converted);
      const mimeType = converted.type || "image/webp";
      const { width, height } = await imageSize(dataURL);
      const { convertToExcalidrawElements, newElementWith, CaptureUpdateAction } = await loadExcalidraw();
      const fileId = `bg-${newSceneId()}`;
      excalidraw.addFiles([{ id: fileId as never, mimeType: mimeType as never, dataURL: dataURL as never, created: Date.now() }]);
      const [image] = convertToExcalidrawElements([{ type: "image", fileId: fileId as never, x: -width / 2, y: -height / 2, width, height, locked: true, customData: { [BACKGROUND_MARK]: true } }]);
      const others = excalidraw.getSceneElementsIncludingDeleted().map((e) => (isBackground(e as never) && !e.isDeleted ? newElementWith(e, { isDeleted: true }) : e));
      excalidraw.updateScene({ elements: [image!, ...others], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      excalidraw.scrollToContent(undefined, { fitToContent: true });
      onClose();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={t("whiteboard.background")} open onClose={onClose}>
      <div className="space-y-4">
        <ErrorText>{error}</ErrorText>
        <label className="flex min-h-10 items-center gap-3 text-sm">
          <span className="flex-1">{t("whiteboard.background_color")}</span>
          <input type="color" aria-label={t("whiteboard.background_color")} defaultValue={c.background.length === 7 ? c.background : "#ffffff"} onChange={(e) => setColor(e.target.value)} className="h-10 w-16 cursor-pointer rounded border border-line bg-bg-0" />
        </label>
        <div className="flex flex-wrap gap-2">
          {["#ffffff", "#fdf6e3", "#f1f3f5", "#e7f5ff", "#2b2b30", "#1d3b2a"].map((color) => (
            <button key={color} type="button" aria-label={color} onClick={() => setColor(color)} className="h-8 w-8 rounded-full border border-line" style={{ background: color }} />
          ))}
        </div>
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" aria-label={t("whiteboard.background_image")} onChange={(e) => e.target.files?.[0] && void setImage(e.target.files[0])} />
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || !excalidraw} onClick={() => file.current?.click()}>
            {busy ? t("whiteboard.background_uploading") : t("whiteboard.background_image")}
          </Button>
          {hasImage && (
            <Button variant="ghost" disabled={busy} onClick={() => void removeImage()}>
              {t("whiteboard.background_remove")}
            </Button>
          )}
        </div>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function fileBase(title: string): string {
  const safe = title.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `whiteboard-${safe || "board"}`;
}

function ExportPanel({ c, title, onClose }: { c: WhiteboardController; title: string; onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const save = async (kind: "png" | "svg") => {
    setBusy(true);
    try {
      const scene = c.scene();
      const image = kind === "png" ? await exportPng(scene) : await exportSvg(scene);
      await saveFile({ name: `${fileBase(title)}.${kind}`, data: image, mime: image.type });
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("whiteboard.save_image")} open onClose={onClose}>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void save("png")}>
          {t("whiteboard.png")}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void save("svg")}>
          {t("whiteboard.svg")}
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          {t("common.close")}
        </Button>
      </div>
    </Dialog>
  );
}

function SharePanel({ c, targets, onClose }: { c: WhiteboardController; targets: ShareTarget[]; onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sorted = useMemo(() => targets, [targets]);
  const share = async (target: ShareTarget) => {
    setBusy(target.conversationId);
    setError(null);
    try {
      await shareImage(target, await exportPng(c.scene()), t("whiteboard.share_body"));
      useToasts.getState().push({ kind: "info", title: t("whiteboard.shared", { name: target.label }) });
      onClose();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog title={t("whiteboard.share_title")} open onClose={onClose}>
      <div className="space-y-3">
        <ErrorText>{error}</ErrorText>
        {sorted.length === 0 && <p className="text-sm text-fg-2">{t("whiteboard.share_none")}</p>}
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {sorted.map((target) => (
            <li key={`${target.domain}/${target.conversationId}`}>
              <button type="button" disabled={!!busy} onClick={() => void share(target)} className="flex min-h-10 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-bg-3 disabled:opacity-50">
                <span className="min-w-0 flex-1 truncate">{target.label}</span>
                {target.encrypted && <span aria-hidden="true">🔒</span>}
                {busy === target.conversationId && <span className="text-xs text-fg-2">…</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
