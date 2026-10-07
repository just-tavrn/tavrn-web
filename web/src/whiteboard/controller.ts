// SPDX-License-Identifier: Apache-2.0
/**
 * The whiteboard of one conversation on this device (tavrn-protocol/WHITEBOARD.md): the owner's device is the
 * source of truth and keeps the scene; viewers apply only what the owner's device sent; granted editors
 * propose changes that the owner applies and re-broadcasts. The controller holds the scene even while no
 * canvas is mounted (the owner keeps answering snapshot requests), talks to the network only through an
 * injected {@link Transport} and to Excalidraw only through an attached {@link CanvasView}.
 */
import { TavrnApiError, type SessionState, type WhiteboardSession } from "@tavrn/sdk";
import { TIMING, WB, identityOf, type Sender } from "./protocol";
import {
  ChunkAssembler,
  LIMITS,
  RateBudget,
  Throttle,
  byteLength,
  diffElements,
  isOwnerDevice,
  mayEdit,
  ordered,
  parseChunk,
  reconcile,
  sanitizeColor,
  sanitizeElements,
  sanitizeFiles,
  splitPayload,
  stamp,
  type WbElement,
  type WbFile,
} from "./sync";

export interface Transport {
  /** Sends one ephemeral event; resolves with the session after `whiteboard.open|grant|close`. */
  send(type: string, content: Record<string, unknown>, session?: SessionState): Promise<WhiteboardSession | null>;
}

export interface CursorInfo {
  /** Device identity `user/device`. */
  id: string;
  user: string;
  x: number;
  y: number;
  at: number;
}

export interface Participant {
  user: string;
  deviceId: string;
  lastSeen: number;
}

/** What the canvas (Excalidraw) does for the controller. */
export interface CanvasView {
  /** Elements accepted from the network; `replace`: the whole scene was replaced. */
  apply(elements: WbElement[], opts: { replace: boolean }): void;
  addFiles(files: WbFile[]): void;
  setBackground(color: string): void;
  setCursors(cursors: CursorInfo[]): void;
}

/** The owner's board as kept locally (unsaved boards survive a reload) and in the scene library. */
export interface Scene {
  elements: WbElement[];
  files: WbFile[];
  background: string;
}

export interface ControllerDeps {
  me: { address: string; deviceId: string };
  transport: Transport;
  /** Renders a small image of the board (data URL), at most every few seconds; optional. */
  renderThumbnail?: (scene: Scene) => Promise<string | null>;
  /** Owner: keeps the unsaved board in the local encrypted store (debounced). */
  saveDraft?: (scene: Scene) => void;
  clearDraft?: () => void;
  onError?: (e: unknown) => void;
  now?: () => number;
}

export type Role = "owner" | "editor" | "viewer";

interface Outgoing {
  type: string;
  content: Record<string, unknown>;
}

/** Thumbnails larger than this (data URL characters) are not sent. */
export const MAX_THUMBNAIL_CHARS = 60_000;
const THUMBNAIL_URL = /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const DEFAULT_BACKGROUND = "#ffffff";
/** Concurrent requests of the send queue. */
const IN_FLIGHT = 4;

export class WhiteboardController {
  session: WhiteboardSession | null = null;
  /** This device shows the board (the owner's device always does while the session lasts). */
  joined = false;
  /** The session ended while this device had joined (the owner closed the board). */
  ended = false;
  /** A viewer received a snapshot. */
  synced = false;
  readonly elements = new Map<string, WbElement>();
  readonly files = new Map<string, WbFile>();
  background = DEFAULT_BACKGROUND;
  thumbnailUrl: string | null = null;
  readonly participants = new Map<string, Participant>();
  readonly cursors = new Map<string, CursorInfo>();
  /** Mounted board views (the session is left when the last one goes). */
  views = 0;
  /** Bumps on every visible change (for `useSyncExternalStore`). */
  version = 0;

  private readonly listeners = new Set<() => void>();
  private readonly known = new Map<string, string>();
  private readonly pendingIds = new Set<string>();
  private readonly proposedIds = new Set<string>();
  private backgroundDirty = false;
  private readonly sentFiles = new Set<string>();
  private readonly queue: Outgoing[] = [];
  private inFlight = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCursor: { x: number; y: number } | null = null;
  /** The cursor throttle allows the next position to go out. */
  private cursorDue = false;
  private readonly budget: RateBudget;
  private readonly assembler: ChunkAssembler;
  private readonly updateThrottle: Throttle;
  private readonly proposeThrottle: Throttle;
  private readonly cursorThrottle: Throttle;
  private readonly snapshotTargets = new Set<string>();
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private requestTimer: ReturnType<typeof setTimeout> | null = null;
  private requests = 0;
  private lastResync = -Infinity;
  private ownerTimers: Array<ReturnType<typeof setInterval>> = [];
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private thumbDirty = false;
  private rendering = false;
  private chunkSeq = 0;
  private view: CanvasView | null = null;
  private disposed = false;

  constructor(private readonly deps: ControllerDeps) {
    const now = deps.now ?? (() => Date.now());
    this.budget = new RateBudget(TIMING.sendPerSecond, now);
    this.assembler = new ChunkAssembler(now);
    this.updateThrottle = new Throttle(TIMING.updateMs, () => this.flushUpdate(), now);
    this.proposeThrottle = new Throttle(TIMING.updateMs, () => this.flushProposal(), now);
    this.cursorThrottle = new Throttle(
      TIMING.cursorMs,
      () => {
        this.cursorDue = true;
        this.pump();
      },
      now,
    );
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // ---- observation ----------------------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  /** The role of this device in the current session (null without one). */
  get role(): Role | null {
    const s = this.session;
    if (!s) return null;
    if (isOwnerDevice(s, this.deps.me.address, this.deps.me.deviceId)) return "owner";
    return mayEdit(s, this.deps.me.address) ? "editor" : "viewer";
  }

  get isOwner(): boolean {
    return this.role === "owner";
  }

  /** The owner is this user, presenting from another device. */
  get ownedElsewhere(): boolean {
    const s = this.session;
    return !!s && s.owner.toLowerCase() === this.deps.me.address.toLowerCase() && s.device_id !== this.deps.me.deviceId;
  }

  /** The scene as it is now (z-order, without deleted elements). */
  scene(): Scene {
    const elements = ordered(this.elements.values());
    const used = new Set(elements.map((e) => e.fileId).filter((f): f is string => !!f));
    return { elements, files: [...this.files.values()].filter((f) => used.has(f.id)), background: this.background };
  }

  attach(view: CanvasView): () => void {
    this.view = view;
    view.addFiles([...this.files.values()]);
    view.setBackground(this.background);
    view.apply(ordered(this.elements.values(), { withDeleted: true }), { replace: true });
    view.setCursors([...this.cursors.values()]);
    return () => {
      if (this.view === view) this.view = null;
    };
  }

  // ---- session --------------------------------------------------------------------------------

  /** The session as the node reports it (`GET …/whiteboard`, `whiteboard.session`). */
  setSession(next: WhiteboardSession | null): void {
    const prev = this.session;
    const wasOwner = this.role === "owner";
    this.session = next;
    if (!next) {
      if (prev && (this.joined || wasOwner)) this.ended = true;
      this.stopOwner();
      this.joined = false;
      this.resetScene();
      this.participants.clear();
      this.thumbnailUrl = null;
      this.notify();
      return;
    }
    const sameBoard = !!prev && prev.owner === next.owner && prev.started_at === next.started_at;
    if (!sameBoard) {
      this.ended = false;
      if (!wasOwner || this.role !== "owner") {
        this.resetScene();
        this.synced = false;
        this.thumbnailUrl = null;
      }
    }
    const nowOwner = this.role === "owner";
    if (nowOwner && !wasOwner) {
      this.joined = true;
      this.startOwner();
      // A new owner device (reload or takeover) brings everyone back in sync.
      if (prev) this.sendSnapshot(null, true);
    } else if (!nowOwner && wasOwner) {
      this.stopOwner();
      this.synced = false;
      if (this.joined) this.requestSnapshot();
    } else if (!sameBoard && this.joined && !nowOwner) {
      this.requestSnapshot();
    }
    this.notify();
  }

  /** Opens a board on this device (it becomes the owner); `initial` restores a draft or a scene. */
  async open(initial?: Scene): Promise<void> {
    if (initial) this.loadScene(initial);
    const session = await this.deps.transport.send(WB.open, { type: WB.open }, { open_for_all: false, grants: [] });
    this.ended = false;
    this.joined = true;
    this.setSession(session);
    this.thumbDirty = true;
    this.notify();
  }

  /** The owner's other device continues presenting on this device. */
  async takeOver(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const session = await this.deps.transport.send(WB.open, { type: WB.open }, { open_for_all: s.open_for_all, grants: s.grants });
    this.joined = true;
    this.setSession(session);
  }

  /** Joins the session as a viewer (or editor): asks the owner for a snapshot. */
  join(): void {
    if (this.joined || !this.session) return;
    this.joined = true;
    this.ended = false;
    if (this.role !== "owner") {
      this.synced = false;
      this.requestSnapshot();
      this.startTick();
    }
    this.notify();
  }

  /**
   * The owner's events cannot be read (e.g. encrypted under an epoch this device has no key for): ask for a
   * fresh snapshot, at most every few seconds.
   */
  resync(): void {
    if (!this.joined || this.role === "owner" || this.now() - this.lastResync < TIMING.requestRetryMs) return;
    this.lastResync = this.now();
    this.synced = false;
    this.requestSnapshot();
  }

  /** Leaves the session (viewers); the owner's board keeps running until it is closed. */
  leave(): void {
    if (this.role === "owner" || !this.joined) return;
    this.joined = false;
    this.enqueue({ type: WB.leave, content: { type: WB.leave } });
    this.clearRequest();
    this.resetScene();
    this.stopTick();
    this.notify();
  }

  /** Closes the board for everyone (owner, or a moderator with `manage_channels`). */
  async close(): Promise<void> {
    await this.deps.transport.send(WB.close, { type: WB.close });
    this.deps.clearDraft?.();
    this.ended = false;
    this.setSession(null);
    this.ended = false;
    this.notify();
  }

  /** Owner: "open for everyone" and the granted users. */
  async setPermissions(state: SessionState): Promise<void> {
    if (this.role !== "owner") return;
    const session = await this.deps.transport.send(WB.grant, { type: WB.grant }, { open_for_all: !!state.open_for_all, grants: state.grants ?? [] });
    this.setSession(session);
  }

  /** Owner: replaces the board with a scene (loaded from the library) for everyone. */
  replaceScene(scene: Scene): void {
    if (this.role !== "owner") return;
    this.loadScene(scene);
    this.view?.addFiles(scene.files);
    this.view?.setBackground(this.background);
    this.view?.apply(ordered(this.elements.values()), { replace: true });
    this.sendSnapshot(null, true);
    this.thumbDirty = true;
    this.scheduleDraft();
    this.notify();
  }

  private loadScene(scene: Scene): void {
    this.resetScene();
    for (const e of sanitizeElements(scene.elements)) {
      this.elements.set(e.id, e);
      this.known.set(e.id, stamp(e));
    }
    for (const f of sanitizeFiles(scene.files)) this.files.set(f.id, f);
    this.background = sanitizeColor(scene.background) ?? DEFAULT_BACKGROUND;
  }

  private resetScene(): void {
    this.elements.clear();
    this.files.clear();
    this.known.clear();
    this.pendingIds.clear();
    this.proposedIds.clear();
    this.sentFiles.clear();
    this.cursors.clear();
    this.background = DEFAULT_BACKGROUND;
    this.view?.apply([], { replace: true });
    this.view?.setCursors([]);
  }

  // ---- local changes --------------------------------------------------------------------------

  /** Excalidraw `onChange`: elements (with deleted ones), the background color and the images. */
  localChange(elements: readonly WbElement[], background: string, files: readonly WbFile[]): void {
    const role = this.role;
    if (!role || !this.joined || (role === "viewer")) {
      // Viewers cannot edit; remember what the canvas shows so that nothing is sent later.
      diffElements(elements, this.known);
      return;
    }
    const changed = diffElements(elements, this.known);
    const color = sanitizeColor(background);
    const bgChanged = role === "owner" && !!color && color !== this.background;
    const newFiles = files.filter((f) => !this.files.has(f.id));
    if (changed.length === 0 && !bgChanged && newFiles.length === 0) return;
    for (const f of sanitizeFiles(newFiles)) this.files.set(f.id, f);
    for (const e of changed) this.elements.set(e.id, e);
    if (role === "owner") {
      if (bgChanged) {
        this.background = color;
        this.backgroundDirty = true;
      }
      this.broadcastFiles();
      for (const e of changed) this.pendingIds.add(e.id);
      this.updateThrottle.schedule();
      this.thumbDirty = true;
      this.scheduleDraft();
    } else {
      // Editor: images first (the owner checks them), then the elements.
      const owner = this.ownerIdentity();
      for (const f of sanitizeFiles(newFiles)) this.sendLarge({ type: WB.files, to: owner ? [owner] : null, files: [f] });
      for (const e of changed) this.proposedIds.add(e.id);
      this.proposeThrottle.schedule();
    }
    this.notify();
  }

  /** Pointer position in scene coordinates (sent throttled while joined). */
  pointer(x: number, y: number): void {
    if (!this.joined || !Number.isFinite(x) || !Number.isFinite(y)) return;
    this.pendingCursor = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
    this.cursorThrottle.schedule();
  }

  private ownerIdentity(): string | null {
    const s = this.session;
    return s ? `${s.owner}/${s.device_id}` : null;
  }

  private flushUpdate(): void {
    if (this.role !== "owner") return;
    const elements = [...this.pendingIds].map((id) => this.elements.get(id)).filter((e): e is WbElement => !!e);
    this.pendingIds.clear();
    const payload: Record<string, unknown> = { type: WB.update, elements };
    if (this.backgroundDirty) payload.background = this.background;
    this.backgroundDirty = false;
    if (elements.length === 0 && !("background" in payload)) return;
    this.sendLarge(payload);
  }

  private flushProposal(): void {
    if (this.role !== "editor") return;
    const elements = [...this.proposedIds].map((id) => this.elements.get(id)).filter((e): e is WbElement => !!e);
    this.proposedIds.clear();
    if (elements.length) this.sendLarge({ type: WB.propose, elements });
  }

  /** Owner: images not sent yet go to everyone. */
  private broadcastFiles(): void {
    for (const f of this.files.values()) {
      if (this.sentFiles.has(f.id)) continue;
      this.sentFiles.add(f.id);
      this.sendLarge({ type: WB.files, to: null, files: [f] });
    }
  }

  private sendSnapshot(to: string[] | null, replace: boolean): void {
    const scene = this.scene();
    this.sendLarge({ type: WB.snapshot, to, replace, elements: scene.elements, background: scene.background });
    for (const f of scene.files) {
      this.sentFiles.add(f.id);
      this.sendLarge({ type: WB.files, to, files: [f] });
    }
  }

  private requestSnapshot(): void {
    this.clearRequest();
    this.requests = 0;
    const ask = () => {
      if (!this.joined || this.synced || this.role === "owner" || this.requests >= 3) return;
      this.requests++;
      this.enqueue({ type: WB.request, content: { type: WB.request } });
      this.requestTimer = setTimeout(ask, TIMING.requestRetryMs);
    };
    ask();
  }

  private clearRequest(): void {
    if (this.requestTimer) clearTimeout(this.requestTimer);
    this.requestTimer = null;
  }

  // ---- sending --------------------------------------------------------------------------------

  /** Sends a payload in one event or, when large, in chunks. */
  private sendLarge(payload: Record<string, unknown>): void {
    const json = JSON.stringify(payload);
    if (byteLength(json) <= LIMITS.directBytes) {
      this.enqueue({ type: String(payload.type), content: payload });
      return;
    }
    const parts = splitPayload(json);
    const id = `${this.now().toString(36)}-${(this.chunkSeq++).toString(36)}`;
    parts.forEach((data, index) => this.enqueue({ type: WB.chunk, content: { type: WB.chunk, id, index, total: parts.length, data } }));
  }

  private enqueue(item: Outgoing): void {
    if (this.disposed) return;
    this.queue.push(item);
    this.pump();
  }

  /** Sends queued events within the rate budget; the newest cursor position only when there is room. */
  private pump(): void {
    if (this.disposed || this.pumpTimer) return;
    while (this.inFlight < IN_FLIGHT) {
      let item = this.queue[0];
      if (!item && this.pendingCursor && this.cursorDue) {
        // Cursors only with budget to spare: updates go first.
        if (!this.budget.take(6)) break;
        const c = this.pendingCursor;
        this.pendingCursor = null;
        this.cursorDue = false;
        item = { type: WB.cursor, content: { type: WB.cursor, x: c.x, y: c.y } };
        this.dispatch(item);
        continue;
      }
      if (!item) return;
      if (!this.budget.take()) {
        this.pumpTimer = setTimeout(() => {
          this.pumpTimer = null;
          this.pump();
        }, Math.max(10, this.budget.wait()));
        return;
      }
      this.queue.shift();
      this.dispatch(item);
    }
  }

  private dispatch(item: Outgoing): void {
    this.inFlight++;
    this.deps.transport
      .send(item.type, item.content)
      .catch((e: unknown) => {
        if (e instanceof TavrnApiError && e.status === 429 && item.type !== WB.cursor) {
          // Back off and try again; nothing is lost.
          this.queue.unshift(item);
          const retry = Number((e.problem as { meta?: { retry_after_secs?: number } }).meta?.retry_after_secs ?? 1);
          if (!this.pumpTimer) {
            this.pumpTimer = setTimeout(() => {
              this.pumpTimer = null;
              this.pump();
            }, Math.min(5, Math.max(1, retry)) * 1000);
          }
          return;
        }
        if (item.type !== WB.cursor) this.deps.onError?.(e);
      })
      .finally(() => {
        this.inFlight--;
        this.pump();
      });
  }

  // ---- receiving ------------------------------------------------------------------------------

  /** A decrypted ephemeral event of this conversation. */
  receive(type: string, from: Sender, content: Record<string, unknown>, depth = 0): void {
    if (this.disposed || content.type !== type) return;
    const me = this.deps.me;
    if (from.user.toLowerCase() === me.address.toLowerCase() && from.device_id === me.deviceId) return;
    const s = this.session;
    const fromId = identityOf(from);
    const fromOwner = isOwnerDevice(s, from.user, from.device_id);
    const role = this.role;
    const fromEditor = !!s && mayEdit(s, from.user);
    switch (type) {
      case WB.chunk: {
        if (depth > 0) return;
        if (!fromOwner && !(role === "owner" && fromEditor)) return;
        const chunk = parseChunk(content);
        const json = chunk ? this.assembler.add(fromId, chunk) : null;
        if (!json) return;
        let inner: unknown;
        try {
          inner = JSON.parse(json);
        } catch {
          return;
        }
        if (!inner || typeof inner !== "object" || Array.isArray(inner)) return;
        const t = (inner as Record<string, unknown>).type;
        if (t === WB.update || t === WB.snapshot || t === WB.files || t === WB.propose) this.receive(t, from, inner as Record<string, unknown>, depth + 1);
        return;
      }
      case WB.update: {
        if (!fromOwner || !this.joined || role === "owner") return;
        const accepted = reconcile(this.elements, sanitizeElements(content.elements), { incomingWinsTies: true });
        for (const e of accepted) this.known.set(e.id, stamp(e));
        const color = "background" in content ? sanitizeColor(content.background) : null;
        if (color && color !== this.background) {
          this.background = color;
          this.view?.setBackground(color);
        }
        if (accepted.length) this.view?.apply(accepted, { replace: false });
        break;
      }
      case WB.snapshot: {
        if (!fromOwner || !this.joined || role === "owner") return;
        const to = content.to;
        const forMe = to === null || to === undefined || (Array.isArray(to) && to.includes(identityOf({ user: me.address, device_id: me.deviceId })));
        if (!forMe) return;
        const incoming = sanitizeElements(content.elements);
        if (content.replace === true || !this.synced) {
          this.elements.clear();
          this.known.clear();
        }
        reconcile(this.elements, incoming, { incomingWinsTies: true });
        for (const e of this.elements.values()) this.known.set(e.id, stamp(e));
        this.background = sanitizeColor(content.background) ?? this.background;
        this.synced = true;
        this.clearRequest();
        this.view?.setBackground(this.background);
        this.view?.apply(ordered(this.elements.values(), { withDeleted: true }), { replace: true });
        break;
      }
      case WB.files: {
        const files = sanitizeFiles(content.files);
        if (fromOwner && this.joined && role !== "owner") {
          for (const f of files) this.files.set(f.id, f);
          this.view?.addFiles(files);
        } else if (role === "owner" && fromEditor) {
          const fresh = files.filter((f) => !this.files.has(f.id));
          for (const f of fresh) this.files.set(f.id, f);
          this.view?.addFiles(fresh);
          this.broadcastFiles();
        } else return;
        break;
      }
      case WB.propose: {
        if (role !== "owner" || !fromEditor) return;
        const accepted = reconcile(this.elements, sanitizeElements(content.elements), { incomingWinsTies: false });
        if (accepted.length === 0) return;
        for (const e of accepted) {
          this.known.set(e.id, stamp(e));
          this.pendingIds.add(e.id);
        }
        this.view?.apply(accepted, { replace: false });
        this.updateThrottle.schedule();
        this.thumbDirty = true;
        this.scheduleDraft();
        this.touch(from);
        break;
      }
      case WB.request: {
        if (role !== "owner") return;
        this.touch(from);
        this.snapshotTargets.add(fromId);
        if (!this.snapshotTimer) {
          this.snapshotTimer = setTimeout(() => {
            this.snapshotTimer = null;
            const targets = [...this.snapshotTargets];
            this.snapshotTargets.clear();
            if (this.role === "owner" && targets.length) this.sendSnapshot(targets, false);
          }, TIMING.snapshotDebounceMs);
        }
        break;
      }
      case WB.here: {
        if (role !== "owner") return;
        this.touch(from);
        break;
      }
      case WB.leave: {
        if (role === "owner") this.participants.delete(fromId);
        this.cursors.delete(fromId);
        this.view?.setCursors([...this.cursors.values()]);
        break;
      }
      case WB.thumbnail: {
        if (!fromOwner) return;
        const data = content.data;
        if (typeof data !== "string" || data.length > MAX_THUMBNAIL_CHARS || !THUMBNAIL_URL.test(data)) return;
        this.thumbnailUrl = data;
        break;
      }
      case WB.open: {
        // The owner's keepalive: joined viewers answer, so the owner knows who is watching.
        if (fromOwner && this.joined && role !== "owner") this.enqueue({ type: WB.here, content: { type: WB.here } });
        return;
      }
      case WB.cursor: {
        if (!this.joined && role !== "owner") return;
        const { x, y } = content;
        if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return;
        if (Math.abs(x) > 1e7 || Math.abs(y) > 1e7) return;
        this.cursors.set(fromId, { id: fromId, user: from.user, x, y, at: this.now() });
        if (role === "owner") this.touch(from);
        this.view?.setCursors([...this.cursors.values()]);
        break;
      }
      default:
        return;
    }
    this.notify();
  }

  private touch(from: Sender): void {
    this.participants.set(identityOf(from), { user: from.user, deviceId: from.device_id, lastSeen: this.now() });
  }

  // ---- owner loops ----------------------------------------------------------------------------

  private startOwner(): void {
    if (this.ownerTimers.length || this.disposed) return;
    this.ownerTimers.push(
      setInterval(() => {
        const s = this.session;
        if (!s || this.role !== "owner") return;
        // Keepalive: the node ends silent sessions; it also re-creates the session after a node restart.
        this.deps.transport
          .send(WB.open, { type: WB.open }, { open_for_all: s.open_for_all, grants: s.grants })
          .then((session) => session && this.setSession(session))
          .catch((e: unknown) => {
            // Someone else presents now (e.g. after a node restart): this device stops presenting.
            if (e instanceof TavrnApiError && e.code === "whiteboard.session_exists") this.setSession((e.problem as { meta?: WhiteboardSession }).meta ?? null);
          });
      }, TIMING.keepaliveMs),
      setInterval(() => void this.ownerTick(), TIMING.thumbnailMs),
    );
    this.startTick();
  }

  private stopOwner(): void {
    for (const t of this.ownerTimers) clearInterval(t);
    this.ownerTimers = [];
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
    this.snapshotTargets.clear();
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = null;
    this.updateThrottle.cancel();
    this.stopTick();
  }

  /** Every 5 s on the owner's device: the thumbnail (only after changes) and stale participants. */
  async ownerTick(): Promise<void> {
    const t = this.now();
    let changed = false;
    for (const [k, p] of this.participants) {
      if (t - p.lastSeen > TIMING.participantTimeoutMs) {
        this.participants.delete(k);
        changed = true;
      }
    }
    if (this.thumbDirty && !this.rendering && this.deps.renderThumbnail && this.role === "owner") {
      this.thumbDirty = false;
      this.rendering = true;
      try {
        const url = await this.deps.renderThumbnail(this.scene());
        if (url && url.length <= MAX_THUMBNAIL_CHARS && THUMBNAIL_URL.test(url) && this.role === "owner") {
          this.thumbnailUrl = url;
          this.enqueue({ type: WB.thumbnail, content: { type: WB.thumbnail, data: url } });
          changed = true;
        }
      } catch {
        /* a failed thumbnail is retried with the next change */
      } finally {
        this.rendering = false;
      }
    }
    if (changed) this.notify();
  }

  private startTick(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      const t = this.now();
      let changed = false;
      for (const [k, c] of this.cursors) {
        if (t - c.at > TIMING.cursorIdleMs) {
          this.cursors.delete(k);
          changed = true;
        }
      }
      if (changed) {
        this.view?.setCursors([...this.cursors.values()]);
        this.notify();
      }
    }, 1_000);
  }

  private stopTick(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private scheduleDraft(): void {
    if (!this.deps.saveDraft || this.draftTimer) return;
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      if (this.role === "owner") this.deps.saveDraft?.(this.scene());
    }, TIMING.draftMs);
  }

  dispose(): void {
    this.disposed = true;
    this.stopOwner();
    this.stopTick();
    this.clearRequest();
    this.proposeThrottle.cancel();
    this.cursorThrottle.cancel();
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.queue.length = 0;
    this.listeners.clear();
    this.view = null;
  }
}
