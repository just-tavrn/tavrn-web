// SPDX-License-Identifier: Apache-2.0
/**
 * One {@link WhiteboardController} per conversation, shared by every view that shows its board (the
 * board page, a badge in a header, later the voice stage tile). It loads the session from the hosting node,
 * keeps it current with `whiteboard.session`, decrypts the conversation's `ephemeral` events and feeds them
 * to the controller. The owner's controller outlives its views: the board keeps running (and answering late
 * joiners) while the owner looks at another channel, until it is closed.
 */
import { forgetGhostAck, isGhostRefusal } from "../components/GhostGate";
import { useEffect, useSyncExternalStore } from "react";
import type { TavrnApi, TavrnSocket, WhiteboardSession } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { useNodeSockets, useRealtimeState } from "../hooks/useRealtime";
import { getMls } from "../stores/mls";
import { cryptoStore } from "../crypto/store";
import { qualify, searchKeysFromStore } from "@tavrn/e2ee";
import { deleteDraft, readDraft, writeDraft } from "./drafts";
import { useNode } from "../components/NodeScope";
import { toastError } from "../stores/toasts";
import { WhiteboardController, type Role, type Scene, type Transport } from "./controller";
import { renderThumbnail } from "./excalidraw";
import { parseScene, serializeScene } from "./scenes";
import { WB, type Sender } from "./protocol";

interface Entry {
  controller: WhiteboardController;
  refs: number;
  stop: () => void;
}

const entries = new Map<string, Entry>();
/** Events that matter before joining (badges and stage tiles); everything else is not even decrypted. */
const BEFORE_JOIN = new Set<string>([WB.thumbnail]);

export interface BoardContext {
  /** Domain of the node hosting the conversation. */
  domain: string;
  /** Node-local conversation id (channel, DM or group DM). */
  conversationId: string;
  api: TavrnApi;
  home: boolean;
  /** Ephemeral content is encrypted like messages (voice channels and DMs always are). */
  encrypted: boolean;
}

/** The owner's unsaved board from the local encrypted store (null if none or locked). */
export async function loadDraft(domain: string, conversationId: string): Promise<Scene | null> {
  if (!cryptoStore.isUnlocked()) return null;
  const q = qualify(domain, conversationId);
  const bytes = await searchKeysFromStore(cryptoStore)
    .then((keys) => readDraft(cryptoStore, keys, q))
    .catch(() => null);
  if (!bytes) return null;
  try {
    return parseScene(bytes);
  } catch {
    return null;
  } finally {
    bytes.fill(0);
  }
}

function socketOf(ctx: BoardContext): TavrnSocket | null {
  return ctx.home ? useRealtimeState.getState().socket : (useNodeSockets.getState().sockets[ctx.domain] ?? null);
}

/** Sends ephemeral events of one conversation (encrypted like messages when the conversation is). */
export function ephemeralTransport(ctx: BoardContext): Transport {
  const q = qualify(ctx.domain, ctx.conversationId);
  return {
    async send(type, content, session) {
      let sealed: unknown = content;
      if (ctx.encrypted) {
        const mls = await getMls();
        if (!mls) throw new Error("locked");
        try {
          sealed = await mls.encryptEphemeral(q, content);
        } catch (e) {
          // An unacknowledged ghost leaf (ENCRYPTION.md §4.6): the board shows the warning again.
          if (isGhostRefusal(e)) forgetGhostAck(q);
          throw e;
        }
      }
      const r = await ctx.api.ephemeral.send(ctx.conversationId, { type, content: sealed, ...(session ? { session } : {}) });
      return r.session ?? null;
    },
  };
}

function create(key: string, ctx: BoardContext): Entry {
  const me = useAuth.getState();
  const q = qualify(ctx.domain, ctx.conversationId);
  // Draft writes in order (each derives the record name first): a later save never loses to an earlier one.
  let drafts: Promise<void> = Promise.resolve();
  const draftOp = (op: () => Promise<void>) => {
    drafts = drafts.then(op).catch(() => undefined);
  };
  const controller = new WhiteboardController({
    me: { address: me.user?.address ?? "", deviceId: me.deviceId ?? "" },
    transport: ephemeralTransport(ctx),
    renderThumbnail,
    saveDraft: (scene) => {
      if (!cryptoStore.isUnlocked()) return;
      const bytes = serializeScene(scene);
      draftOp(async () => writeDraft(cryptoStore, await searchKeysFromStore(cryptoStore), q, bytes));
    },
    clearDraft: () => draftOp(async () => deleteDraft(cryptoStore, await searchKeysFromStore(cryptoStore), q)),
    onError: (e) => toastError(e),
  });

  const onEphemeral = (d: { conversation_id: string; type: string; from: Sender; content: unknown }) => {
    if (d.conversation_id !== ctx.conversationId || !d.from) return;
    if (!controller.joined && !controller.isOwner && !BEFORE_JOIN.has(d.type)) return;
    void (async () => {
      let content: Record<string, unknown> | null = null;
      if (ctx.encrypted) {
        const mls = await getMls();
        const r = mls ? await mls.decryptEphemeral(q, d.from.user, d.from.device_id, d.content) : null;
        if (r?.ok) content = r.content;
        // Something of the presenting device could not be read: get the whole board again.
        else if (r?.reason === "missing_key" && controller.session?.device_id === d.from.device_id) controller.resync();
      } else if (d.content && typeof d.content === "object" && !Array.isArray(d.content)) {
        content = d.content as Record<string, unknown>;
      }
      if (content) controller.receive(d.type, d.from, content);
    })();
  };
  const onSession = (d: { conversation_id: string; session: WhiteboardSession | null }) => {
    if (d.conversation_id === ctx.conversationId) controller.setSession(d.session);
  };
  const refresh = () =>
    ctx.api.ephemeral
      .session(ctx.conversationId)
      .then((r) => controller.setSession(r.session ?? null))
      .catch(() => undefined);

  // Follow the socket of the hosting node (it is replaced after sign-in changes and reconnects).
  let socket: TavrnSocket | null = null;
  let offs: Array<() => void> = [];
  const bind = () => {
    const next = socketOf(ctx);
    if (next === socket) return;
    offs.forEach((off) => off());
    socket = next;
    offs = next ? [next.on("ephemeral", onEphemeral), next.on("whiteboard.session", onSession)] : [];
    void refresh();
  };
  bind();
  // Missed events while the socket was down: load the session again after every reconnect (no polling).
  let wasReady = useRealtimeState.getState().status === "ready";
  const onStatus = () => {
    const ready = useRealtimeState.getState().status === "ready";
    if (ready && !wasReady) void refresh();
    wasReady = ready;
  };
  const unsubs = [useRealtimeState.subscribe(bind), useRealtimeState.subscribe(onStatus), useNodeSockets.subscribe(bind)];
  return {
    controller,
    refs: 0,
    stop: () => {
      unsubs.forEach((u) => u());
      offs.forEach((off) => off());
      controller.dispose();
      if (entries.get(key)?.controller === controller) entries.delete(key);
    },
  };
}

function release(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entry.refs--;
  // Decided a moment later: on a route change the next view (e.g. the channel header after the board page)
  // takes the same board over without a restart.
  setTimeout(() => {
    if (entry.refs > 0 || entries.get(key) !== entry) return;
    const c = entry.controller;
    // The owner's board keeps running without views; it is stopped when the session ends.
    if (c.isOwner) {
      const off = c.subscribe(() => {
        if (!c.session && entry.refs === 0) {
          off();
          entry.stop();
        }
      });
      return;
    }
    c.leave();
    entry.stop();
  }, 0);
}

/** The controller of a conversation's board, created on first use and shared. */
export function useWhiteboardController(ctx: BoardContext): WhiteboardController {
  const key = `${ctx.domain}|${ctx.conversationId}`;
  let entry = entries.get(key);
  if (!entry) {
    entry = create(key, ctx);
    entries.set(key, entry);
  }
  const controller = entry.controller;
  useEffect(() => {
    const e = entries.get(key) ?? create(key, ctx);
    entries.set(key, e);
    e.refs++;
    return () => release(key);
    // The context of a key never changes (same node, same conversation).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // Session-level state only (controller.version): cursors and strokes do not re-render the views.
  useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.version,
  );
  return controller;
}

/**
 * Re-renders on changes of the board's elements and images, at most every `CONTENT_NOTIFY_MS` (element
 * counts, the texts for screen readers, the tile's shape); returns `contentVersion` for memo dependencies. The
 * canvas itself never needs it (the controller applies changes through the CanvasView).
 */
export function useBoardContent(controller: WhiteboardController): number {
  return useSyncExternalStore(
    (cb) => controller.subscribeContent(cb),
    () => controller.contentVersion,
  );
}

export interface WhiteboardSessionState {
  /** The session as the node reports it (owner, device, open for everyone, grants, start). */
  session: WhiteboardSession | null;
  /** This device presents the board. */
  isOwner: boolean;
  role: Role | null;
  /** This device shows the board. */
  joined: boolean;
  /** The session ended while this device had joined. */
  ended: boolean;
  join: () => void;
  leave: () => void;
  /** A small image of the board (data URL), refreshed by the owner every few seconds; null without one. */
  thumbnailUrl: string | null;
  controller: WhiteboardController;
}

/**
 * The integration surface for other views (the voice stage, tavrn-protocol/WHITEBOARD.md, `README.md` here):
 * the board of `conversationId` on the node of the current {@link useNode} scope.
 */
export function useWhiteboardSession(conversationId: string, opts: { encrypted?: boolean } = {}): WhiteboardSessionState {
  const { domain, api, home } = useNode();
  const controller = useWhiteboardController({ domain, api, home, conversationId, encrypted: opts.encrypted ?? true });
  return {
    session: controller.session,
    isOwner: controller.isOwner,
    role: controller.role,
    joined: controller.joined,
    ended: controller.ended,
    join: () => controller.join(),
    leave: () => controller.leave(),
    thumbnailUrl: controller.thumbnailUrl,
    controller,
  };
}

/** The boards this device presents right now (any conversation). */
export function ownedBoards(): WhiteboardController[] {
  return [...entries.values()].map((e) => e.controller).filter((c) => c.isOwner && !!c.session);
}

/** Tests: drops every board. */
export function resetWhiteboards(): void {
  for (const e of [...entries.values()]) e.stop();
}
