// SPDX-License-Identifier: Apache-2.0
// The start of a voice session (joinFlow.ts): what runs in parallel, what waits for what, and what a failure gives back.
import { describe, expect, it, vi } from "vitest";
import { earlyPipeline, startJoin, type JoinFlowDeps } from "./joinFlow";
import type { JoinInfo } from "./sessionShared";

const Q = "t.local/01J9ZK3G5M8Q2W4E6R8T0Y2V00";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const info = (epoch: number | null = 3): JoinInfo => ({ url: "wss://x", token: "t", epoch, limits: { audio_bitrate_kbps: 64 } as JoinInfo["limits"], reconnect_grace_secs: 30, participants: [] });

/** Every dependency as a deferred step, with the order of the calls. */
function harness(opts: { rejoin?: boolean } = {}) {
  const log: string[] = [];
  const steps = {
    ensure: deferred<"joined" | "no_group">(),
    pending: deferred<{ identity: string; reason: string }[]>(),
    join: deferred<JoinInfo>(),
    cleanup: deferred<() => void>(),
    update: deferred<boolean>(),
  };
  let epoch = 2;
  const later = vi.fn();
  const media = { release: vi.fn(async () => void log.push("release")) };
  const deps: JoinFlowDeps = {
    q: Q,
    canCreate: true,
    rejoin: !!opts.rejoin,
    mls: {
      ensureJoined: vi.fn(() => (log.push("ensureJoined"), steps.ensure.promise)),
      selfUpdate: vi.fn(() => (log.push("selfUpdate"), steps.update.promise.then((ok) => ((epoch += 1), ok)))),
      epoch: vi.fn(() => epoch),
      catchUp: vi.fn(async () => void (log.push("catchUp"), (epoch = 9))),
    },
    pending: vi.fn(() => (log.push("pending"), steps.pending.promise)),
    join: vi.fn(() => (log.push("join"), steps.join.promise)),
    leave: vi.fn(async () => void log.push("leave")),
    cleanup: vi.fn((p) => (log.push("cleanup"), p.then(() => steps.cleanup.promise))),
    media,
  };
  return { log, steps, deps, media, later, setEpoch: (e: number) => (epoch = e) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("startJoin: the order of a voice join", () => {
  it("requests the pending removals with the group join, sends voice/join while the cleanup and the self update run", async () => {
    const h = harness();
    const started = startJoin(h.deps);
    await tick();
    // Both requests are out before the group join finished.
    expect(h.log).toEqual(["pending", "ensureJoined"]);
    h.steps.ensure.resolve("joined");
    await tick();
    expect(h.log).toEqual(["pending", "ensureJoined", "join", "cleanup"]);
    // The node answers before the cleanup and the self update are done: the flow resolves, `fresh` waits.
    h.steps.join.resolve(info(2));
    const flow = await started;
    let fresh = false;
    void flow.fresh.then(() => (fresh = true));
    h.steps.pending.resolve([]);
    h.steps.cleanup.resolve(h.later);
    await tick();
    expect(h.log.at(-1)).toBe("selfUpdate");
    expect(fresh).toBe(false);
    h.steps.update.resolve(true);
    await flow.fresh;
    expect(h.deps.mls.catchUp).not.toHaveBeenCalled();
    // The postponed cleanup starts only when the session asks for it (once connected).
    expect(h.later).not.toHaveBeenCalled();
    flow.cleanupLater();
    expect(h.later).toHaveBeenCalledTimes(1);
    expect(h.media.release).not.toHaveBeenCalled();
  });

  it("catches up when the node's epoch is ahead after the self update", async () => {
    const h = harness();
    h.steps.ensure.resolve("joined");
    h.steps.pending.resolve([]);
    h.steps.cleanup.resolve(() => undefined);
    h.steps.update.resolve(false);
    h.steps.join.resolve(info(7));
    const flow = await startJoin(h.deps);
    await flow.fresh;
    expect(h.log).toContain("catchUp");
  });

  it("a rejoin keeps the epoch: no cleanup, no self update", async () => {
    const h = harness({ rejoin: true });
    h.steps.ensure.resolve("joined");
    h.steps.join.resolve(info(2));
    const flow = await startJoin(h.deps);
    await flow.fresh;
    expect(h.log).toEqual(["ensureJoined", "join"]);
  });
});

describe("startJoin: failures", () => {
  it("a group that cannot be joined: no voice/join, the media are released", async () => {
    const h = harness();
    h.steps.ensure.resolve("no_group");
    await expect(startJoin(h.deps)).rejects.toMatchObject({ code: "no_group" });
    expect(h.deps.join).not.toHaveBeenCalled();
    expect(h.media.release).toHaveBeenCalledTimes(1);
    expect(h.deps.leave).not.toHaveBeenCalled();
  });

  it("the MLS failing before the answer: the media are released, no seat was taken", async () => {
    const h = harness();
    h.steps.ensure.reject(new Error("offline"));
    await expect(startJoin(h.deps)).rejects.toThrow("offline");
    expect(h.media.release).toHaveBeenCalledTimes(1);
    expect(h.deps.join).not.toHaveBeenCalled();
  });

  it("a refused join: the media are released, no leave", async () => {
    const h = harness();
    h.steps.ensure.resolve("joined");
    h.steps.join.reject(Object.assign(new Error("full"), { code: "voice.channel_full" }));
    await expect(startJoin(h.deps)).rejects.toThrow("full");
    expect(h.media.release).toHaveBeenCalledTimes(1);
    expect(h.deps.leave).not.toHaveBeenCalled();
  });

  it("the MLS failing after the answer (catch-up to the node's epoch): `fresh` rejects, abandon frees the seat once", async () => {
    const h = harness();
    h.steps.ensure.resolve("joined");
    h.steps.pending.resolve([]);
    h.steps.cleanup.resolve(() => undefined);
    h.steps.update.resolve(false);
    h.steps.join.resolve(info(7));
    (h.deps.mls.catchUp as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("catch_up_failed"));
    const flow = await startJoin(h.deps);
    await expect(flow.fresh).rejects.toThrow("catch_up_failed");
    await flow.abandon();
    await flow.abandon();
    expect(h.deps.leave).toHaveBeenCalledTimes(1);
    expect(h.media.release).toHaveBeenCalledTimes(1);
    expect(h.log.slice(-2)).toEqual(["release", "leave"]);
  });

  it("a failed rejoin keeps the seat", async () => {
    const h = harness({ rejoin: true });
    h.steps.ensure.resolve("joined");
    h.steps.join.resolve(info(2));
    const flow = await startJoin(h.deps);
    await flow.abandon();
    expect(h.deps.leave).not.toHaveBeenCalled();
    expect(h.media.release).toHaveBeenCalledTimes(1);
  });

  it("a failing cleanup or self update is best effort", async () => {
    const h = harness();
    h.steps.ensure.resolve("joined");
    h.steps.pending.reject(new Error("offline"));
    h.steps.cleanup.reject(new Error("cleanup"));
    h.steps.update.reject(new Error("conflict"));
    h.steps.join.resolve(info(2));
    const flow = await startJoin(h.deps);
    await expect(flow.fresh).resolves.toBeUndefined();
  });
});

describe("earlyPipeline", () => {
  const pipe = (music: boolean) => ({ music, close: vi.fn(async () => undefined) });

  it("hands over the pipeline started at the click when the guess was right", async () => {
    const create = vi.fn(async (music: boolean) => pipe(music));
    const early = earlyPipeline(create, false);
    expect(create).toHaveBeenCalledTimes(1);
    const p = await early.take(false);
    expect(p.music).toBe(false);
    await early.release();
    expect(p.close).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("reopens in the other mode when the guess was wrong (the early one is closed)", async () => {
    const made: ReturnType<typeof pipe>[] = [];
    const early = earlyPipeline(async (music) => (made.push(pipe(music)), made.at(-1)!), false);
    const p = await early.take(true);
    expect(p.music).toBe(true);
    expect(made[0]!.close).toHaveBeenCalled();
  });

  it("release closes a pipeline that was not taken; take afterwards fails", async () => {
    const made: ReturnType<typeof pipe>[] = [];
    const early = earlyPipeline(async (music) => (made.push(pipe(music)), made.at(-1)!), false);
    await early.release();
    expect(made[0]!.close).toHaveBeenCalledTimes(1);
    await expect(early.take(false)).rejects.toMatchObject({ code: "connect_failed" });
  });

  it("a microphone that cannot be opened fails the take, not earlier", async () => {
    const early = earlyPipeline(async () => {
      throw new DOMException("denied", "NotAllowedError");
    }, false);
    await tick();
    await expect(early.take(false)).rejects.toThrow("denied");
    await expect(early.release()).resolves.toBeUndefined();
  });
});
