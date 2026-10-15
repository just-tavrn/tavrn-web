// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TavrnApiError, type SessionState, type WhiteboardSession } from "@tavrn/sdk";
import { WhiteboardController, type CanvasView, type Transport } from "./controller";
import { TIMING, WB, type Sender } from "./protocol";
import type { WbElement, WbFile } from "./sync";

const el = (id: string, version: number, extra: Partial<WbElement> = {}): WbElement => ({ id, type: "rectangle", version, versionNonce: version * 11, index: `a${id}`, ...extra });

interface Member {
  ctrl: WhiteboardController;
  me: Sender;
}

/**
 * The node in miniature: keeps the session from open/grant/close like the real one (one owner, grants
 * replace), fans every event out to the other devices (deep copies, like JSON over the wire) and
 * announces session changes to everyone.
 */
class Bus {
  session: WhiteboardSession | null = null;
  members: Member[] = [];
  log: Array<{ from: string; type: string; content: Record<string, unknown> }> = [];
  failNext: TavrnApiError | null = null;

  transport(me: Sender): Transport {
    return {
      send: async (type: string, content: Record<string, unknown>, state?: SessionState) => {
        if (this.failNext) {
          const e = this.failNext;
          this.failNext = null;
          throw e;
        }
        let changed = false;
        if (type === WB.open) {
          if (this.session && this.session.owner !== me.user) throw new TavrnApiError({ type: "", title: "", status: 409, detail: "", code: "whiteboard.session_exists", meta: this.session } as never);
          const next = { conversation_id: "C", owner: me.user, owner_id: me.user, device_id: me.device_id, open_for_all: !!state?.open_for_all, grants: state?.grants ?? [], started_at: this.session?.started_at ?? "t0" };
          changed = JSON.stringify(next) !== JSON.stringify(this.session);
          this.session = next;
        } else if (type === WB.grant) {
          this.session = { ...this.session!, open_for_all: !!state?.open_for_all, grants: state?.grants ?? [] };
          changed = true;
        } else if (type === WB.close) {
          this.session = null;
          changed = true;
        }
        this.log.push({ from: `${me.user}/${me.device_id}`, type, content });
        const wire = JSON.parse(JSON.stringify(content)) as Record<string, unknown>;
        for (const m of this.members) if (m.me.user !== me.user || m.me.device_id !== me.device_id) m.ctrl.receive(type, me, wire);
        if (changed) for (const m of this.members) m.ctrl.setSession(this.session);
        return type === WB.open || type === WB.grant || type === WB.close ? this.session : null;
      },
    };
  }

  add(user: string, deviceId: string, extra: Partial<ConstructorParameters<typeof WhiteboardController>[0]> = {}): WhiteboardController {
    const me = { user, device_id: deviceId };
    const ctrl = new WhiteboardController({ me: { address: user, deviceId }, transport: this.transport(me), ...extra });
    ctrl.setSession(this.session);
    this.members.push({ ctrl, me });
    return ctrl;
  }

  sent(type: string, from?: string) {
    return this.log.filter((l) => l.type === type && (!from || l.from.startsWith(from)));
  }
}

function recordingView(): CanvasView & { applied: WbElement[][]; files: WbFile[] } {
  const v = {
    applied: [] as WbElement[][],
    files: [] as WbFile[],
    apply: (elements: WbElement[]) => void v.applied.push(elements),
    addFiles: (files: WbFile[]) => void v.files.push(...files),
    setBackground: () => undefined,
    setCursors: () => undefined,
  };
  return v;
}

/** Lets the queued sends and the fan-out run. */
async function settle(ms = 0) {
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(ms);
    await Promise.resolve();
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("WhiteboardController", () => {
  it("owner edits reach joined viewers; viewers cannot edit and ignore other senders", async () => {
    const bus = new Bus();
    const alice = bus.add("alice@n.test", "DA");
    const bob = bus.add("bob@n.test", "DB");
    await alice.open();
    await settle();
    expect(alice.role).toBe("owner");
    expect(bob.role).toBe("viewer");
    bob.join();
    await settle(TIMING.snapshotDebounceMs);
    expect(bob.synced).toBe(true);

    alice.localChange([el("r", 1)], "#ffffff", []);
    await settle(TIMING.updateMs);
    expect(bob.elements.get("r")?.version).toBe(1);

    // Bob's canvas is read-only; even if it reported a change, nothing is sent.
    bob.localChange([el("evil", 5)], "#000000", []);
    await settle(TIMING.updateMs);
    expect(bus.sent(WB.propose)).toHaveLength(0);
    expect(alice.elements.has("evil")).toBe(false);

    // An update that does not come from the owner's device is ignored (also from the owner's other devices).
    bob.receive(WB.update, { user: "carol@n.test", device_id: "DC" }, { type: WB.update, elements: [el("r", 9)] });
    bob.receive(WB.update, { user: "alice@n.test", device_id: "OTHER" }, { type: WB.update, elements: [el("r", 9)] });
    expect(bob.elements.get("r")?.version).toBe(1);
    // The payload type must match the event type.
    bob.receive(WB.update, { user: "alice@n.test", device_id: "DA" }, { type: WB.snapshot, elements: [el("r", 9)] });
    expect(bob.elements.get("r")?.version).toBe(1);
  });

  it("throttles and deduplicates element diffs", async () => {
    const bus = new Bus();
    const alice = bus.add("alice@n.test", "DA");
    await alice.open();
    await settle();
    for (let v = 1; v <= 10; v++) alice.localChange([el("r", v)], "#ffffff", []);
    alice.localChange([el("r", 10)], "#ffffff", []); // no change: nothing new
    await settle(TIMING.updateMs);
    const updates = bus.sent(WB.update);
    expect(updates.length).toBeLessThanOrEqual(2);
    const last = updates.at(-1)!.content.elements as WbElement[];
    expect(last[0]!.version).toBe(10);
    alice.localChange([el("r", 10)], "#ffffff", []);
    await settle(TIMING.updateMs * 2);
    expect(bus.sent(WB.update)).toHaveLength(updates.length);
  });

  it("applies proposals of granted editors only and re-broadcasts them", async () => {
    const bus = new Bus();
    const alice = bus.add("alice@n.test", "DA");
    const bob = bus.add("bob@n.test", "DB");
    const carol = bus.add("carol@n.test", "DC");
    await alice.open();
    bob.join();
    carol.join();
    await settle(TIMING.snapshotDebounceMs);

    // Not granted: a forged proposal is ignored by the owner.
    alice.receive(WB.propose, { user: "bob@n.test", device_id: "DB" }, { type: WB.propose, elements: [el("b1", 1)] });
    expect(alice.elements.has("b1")).toBe(false);

    await alice.setPermissions({ open_for_all: false, grants: ["bob@n.test"] });
    await settle();
    expect(bob.role).toBe("editor");
    expect(carol.role).toBe("viewer");
    bob.localChange([el("b1", 1)], "#ffffff", []);
    await settle(TIMING.updateMs * 3);
    expect(bus.sent(WB.propose, "bob")).toHaveLength(1);
    expect(alice.elements.get("b1")?.version).toBe(1);
    // Carol trusts the owner's re-broadcast, never Bob directly.
    expect(carol.elements.get("b1")?.version).toBe(1);
    expect(bus.sent(WB.update, "alice").some((u) => (u.content.elements as WbElement[]).some((e) => e.id === "b1"))).toBe(true);

    // Locking again: Bob's proposals are ignored from now on.
    await alice.setPermissions({ open_for_all: false, grants: [] });
    alice.receive(WB.propose, { user: "bob@n.test", device_id: "DB" }, { type: WB.propose, elements: [el("b2", 1)] });
    expect(alice.elements.has("b2")).toBe(false);
    // Open for everyone: carol may propose.
    await alice.setPermissions({ open_for_all: true, grants: [] });
    alice.receive(WB.propose, { user: "carol@n.test", device_id: "DC" }, { type: WB.propose, elements: [el("c1", 1)] });
    expect(alice.elements.has("c1")).toBe(true);
    // The owner keeps its own state against an older or tied proposal.
    alice.localChange([...alice.elements.values(), el("o", 3)], "#ffffff", []);
    alice.receive(WB.propose, { user: "carol@n.test", device_id: "DC" }, { type: WB.propose, elements: [{ ...el("o", 3), versionNonce: 1 }, el("o", 2)] });
    expect(alice.elements.get("o")!.versionNonce).toBe(33);
  });

  it("answers snapshot requests of late joiners, addressed to them", async () => {
    const bus = new Bus();
    const alice = bus.add("alice@n.test", "DA");
    const bob = bus.add("bob@n.test", "DB");
    const carol = bus.add("carol@n.test", "DC");
    await alice.open();
    alice.localChange([el("a", 1), el("gone", 2, { isDeleted: true })], "#ffeedd", []);
    await settle(TIMING.updateMs);
    carol.join();
    await settle(TIMING.snapshotDebounceMs);
    expect(carol.synced).toBe(true);

    const view = recordingView();
    bob.attach(view);
    bob.join();
    expect(bus.sent(WB.request, "bob")).toHaveLength(1);
    await settle(TIMING.snapshotDebounceMs);
    const snapshots = bus.sent(WB.snapshot);
    expect(snapshots.at(-1)!.content.to).toEqual(["bob@n.test/DB"]);
    expect([...bob.elements.keys()]).toEqual(["a"]); // deleted elements are not part of a snapshot
    expect(bob.background).toBe("#ffeedd");
    expect(bob.synced).toBe(true);
    expect(view.applied.at(-1)!.map((e) => e.id)).toEqual(["a"]);
    // Viewers that were not asked ignore it (no duplicate work); a forged snapshot is ignored.
    carol.receive(WB.snapshot, { user: "mallory@n.test", device_id: "DM" }, { type: WB.snapshot, to: null, replace: true, elements: [] });
    expect(carol.elements.has("a")).toBe(true);
    // The owner knows who joined.
    expect([...alice.participants.keys()].sort()).toEqual(["bob@n.test/DB", "carol@n.test/DC"]);
    bob.leave();
    await settle();
    expect([...alice.participants.keys()]).toEqual(["carol@n.test/DC"]);
    expect(bob.elements.size).toBe(0);
  });

  it("asks again when no snapshot arrives", async () => {
    const bus = new Bus();
    bus.session = { conversation_id: "C", owner: "alice@n.test", owner_id: "a", device_id: "DA", open_for_all: false, grants: [], started_at: "t0" };
    const bob = bus.add("bob@n.test", "DB"); // the owner's device does not answer
    bob.join();
    await settle(TIMING.requestRetryMs * 4);
    expect(bus.sent(WB.request)).toHaveLength(3);
  });

  it("sends large payloads in chunks that only the owner's device can feed", async () => {
    const bus = new Bus();
    const alice = bus.add("alice@n.test", "DA");
    const bob = bus.add("bob@n.test", "DB");
    await alice.open();
    bob.join();
    await settle(TIMING.snapshotDebounceMs);
    const points = Array.from({ length: 6_000 }, (_, i) => [i, i * 2]);
    alice.localChange([el("draw", 1, { type: "freedraw", points })], "#ffffff", []);
    await settle(TIMING.updateMs * 4);
    expect(bus.sent(WB.chunk).length).toBeGreaterThan(1);
    expect(bus.sent(WB.update)).toHaveLength(0);
    expect((bob.elements.get("draw")?.points as unknown[]).length).toBe(6_000);
    // Chunks of a viewer are not even assembled by other viewers.
    const carol = bus.add("carol@n.test", "DC");
    carol.join();
    carol.receive(WB.chunk, { user: "bob@n.test", device_id: "DB" }, { type: WB.chunk, id: "x", index: 0, total: 1, data: "e30" });
    expect(carol.elements.size).toBe(0);
  });

  it("sends images before the elements that use them and accepts images only from the owner", async () => {
    const bus = new Bus();
    const alice = bus.add("alice@n.test", "DA");
    const bob = bus.add("bob@n.test", "DB");
    await alice.open();
    bob.join();
    await settle(TIMING.snapshotDebounceMs);
    const file: WbFile = { id: "f1", mimeType: "image/png", dataURL: "data:image/png;base64,iVBORw0KGgo=", created: 1 };
    alice.localChange([el("img", 1, { type: "image", fileId: "f1" })], "#ffffff", [file]);
    await settle(TIMING.updateMs * 2);
    const types = bus.log.filter((l) => l.from.startsWith("alice")).map((l) => l.type);
    expect(types.indexOf(WB.files)).toBeLessThan(types.lastIndexOf(WB.update));
    expect(bob.files.get("f1")?.dataURL).toBe(file.dataURL);
    bob.receive(WB.files, { user: "mallory@n.test", device_id: "DM" }, { type: WB.files, to: null, files: [{ ...file, id: "evil" }] });
    expect(bob.files.has("evil")).toBe(false);
  });

  it("ends the session for viewers when the owner closes it", async () => {
    const bus = new Bus();
    const cleared = vi.fn();
    const alice = bus.add("alice@n.test", "DA", { clearDraft: cleared });
    const bob = bus.add("bob@n.test", "DB");
    await alice.open();
    bob.join();
    await settle(TIMING.snapshotDebounceMs);
    await alice.close();
    expect(bob.session).toBeNull();
    expect(bob.ended).toBe(true);
    expect(bob.joined).toBe(false);
    expect(alice.ended).toBe(false);
    expect(cleared).toHaveBeenCalled();
  });

  it("renders a thumbnail every few seconds after changes and shares it", async () => {
    const bus = new Bus();
    const render = vi.fn(async () => "data:image/webp;base64,AAAA");
    const alice = bus.add("alice@n.test", "DA", { renderThumbnail: render });
    const bob = bus.add("bob@n.test", "DB"); // not joined: tiles still show the thumbnail
    await alice.open();
    await settle(TIMING.thumbnailMs);
    expect(render).toHaveBeenCalledTimes(1);
    expect(bob.thumbnailUrl).toBe("data:image/webp;base64,AAAA");
    await settle(TIMING.thumbnailMs * 2);
    expect(render).toHaveBeenCalledTimes(1); // no change, no new thumbnail
    alice.localChange([el("r", 1)], "#ffffff", []);
    await settle(TIMING.thumbnailMs);
    expect(render).toHaveBeenCalledTimes(2);
    bob.receive(WB.thumbnail, { user: "alice@n.test", device_id: "DA" }, { type: WB.thumbnail, data: "javascript:alert(1)" });
    expect(bob.thumbnailUrl).toBe("data:image/webp;base64,AAAA");
  });

  it("retries after a rate limit answer without losing the update", async () => {
    const bus = new Bus();
    const alice = bus.add("alice@n.test", "DA");
    const bob = bus.add("bob@n.test", "DB");
    await alice.open();
    bob.join();
    await settle(TIMING.snapshotDebounceMs);
    bus.failNext = new TavrnApiError({ type: "", title: "", status: 429, detail: "", code: "rate_limited", meta: { retry_after_secs: 1 } } as never);
    alice.localChange([el("r", 1)], "#ffffff", []);
    await settle(TIMING.updateMs);
    expect(bob.elements.has("r")).toBe(false);
    await settle(1_000);
    expect(bob.elements.get("r")?.version).toBe(1);
  });

  it("shows cursors of joined participants and forgets idle ones", async () => {
    const bus = new Bus();
    const alice = bus.add("alice@n.test", "DA");
    const bob = bus.add("bob@n.test", "DB");
    await alice.open();
    bob.join();
    await settle(TIMING.snapshotDebounceMs);
    // 20 moves within 200 ms.
    for (let i = 0; i < 20; i++) {
      bob.pointer(i, i);
      await vi.advanceTimersByTimeAsync(10);
    }
    await settle(TIMING.cursorMs);
    const cursors = bus.sent(WB.cursor, "bob");
    expect(cursors.length).toBeGreaterThan(0);
    expect(cursors.length).toBeLessThanOrEqual(4); // ~10 per second
    expect(alice.cursors.get("bob@n.test/DB")).toMatchObject({ user: "bob@n.test", x: 19, y: 19 });
    await settle(TIMING.cursorIdleMs + 1_100);
    expect(alice.cursors.size).toBe(0);
  });
  it("cursor events and canvas echoes reach the canvas without notifying the views", async () => {
    const bus = new Bus();
    const alice = bus.add("alice@n.test", "DA");
    const bob = bus.add("bob@n.test", "DB");
    await alice.open();
    bob.join();
    await settle(TIMING.snapshotDebounceMs);
    alice.localChange([el("r", 1)], "#ffffff", []);
    await settle(TIMING.updateMs);
    const view = recordingView();
    let cursorsShown = 0;
    view.setCursors = () => void cursorsShown++;
    alice.attach(view);
    let meta = 0;
    let content = 0;
    alice.subscribe(() => meta++);
    alice.subscribeContent(() => content++);
    const shown = cursorsShown;
    for (let i = 0; i < 50; i++) {
      alice.receive(WB.cursor, { user: "bob@n.test", device_id: "DB" }, { type: WB.cursor, x: i, y: i });
      // Excalidraw reports every collaborator update as a change of the (unchanged) scene.
      alice.localChange([el("r", 1)], "#ffffff", []);
    }
    await settle(1_000);
    expect(cursorsShown - shown).toBe(50);
    expect(meta).toBe(0);
    expect(content).toBe(0);
    expect(bus.sent(WB.update, "alice")).toHaveLength(1);
  });

  it("notifies content changes coalesced, session changes at once", async () => {
    const bus = new Bus();
    const alice = bus.add("alice@n.test", "DA");
    await alice.open();
    let meta = 0;
    let content = 0;
    alice.subscribe(() => meta++);
    alice.subscribeContent(() => content++);
    for (let v = 1; v <= 30; v++) {
      alice.localChange([el("r", v)], "#ffffff", []);
      await vi.advanceTimersByTimeAsync(10);
    }
    await settle(500);
    // 30 strokes within 300 ms: a handful of content notifications, no session notification.
    expect(content).toBeGreaterThan(0);
    expect(content).toBeLessThanOrEqual(4);
    expect(meta).toBe(0);
    const before = alice.contentVersion;
    await alice.setPermissions({ open_for_all: true, grants: [] });
    expect(meta).toBeGreaterThan(0);
    expect(alice.contentVersion).toBe(before);
  });

  it("builds element updates when the queue has room: nothing piles up behind a stalled uplink", async () => {
    const sent: string[] = [];
    const stalled: Transport = {
      send: (type) => {
        sent.push(type);
        return type === WB.open ? Promise.resolve({ conversation_id: "C", owner: "alice@n.test", owner_id: "alice@n.test", device_id: "DA", open_for_all: false, grants: [], started_at: "t0" }) : new Promise(() => undefined);
      },
    };
    const alice = new WhiteboardController({ me: { address: "alice@n.test", deviceId: "DA" }, transport: stalled });
    await alice.open();
    // Drawing for 2 s while no request ever completes.
    for (let v = 1; v <= 120; v++) {
      alice.localChange([el("r", v), el(`s${v % 5}`, v)], "#ffffff", []);
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(alice.queued).toBeLessThanOrEqual(2);
    expect(sent.filter((t) => t === WB.update).length).toBeLessThanOrEqual(4);
    alice.dispose();
  });
});
