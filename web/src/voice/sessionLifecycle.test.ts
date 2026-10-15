// SPDX-License-Identifier: Apache-2.0
// The life of a voice session around the media (sessionLifecycle.ts), shared by both engines: the join queue, leaving
// while a join runs, the rejoin; and the epoch catch-up of sessionShared.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToasts } from "../stores/toasts";
import { useVoicePresence } from "./presence";
import { IDLE, useVoice, type VoiceTarget } from "./store";
import { JoinCancelled, SessionLifecycle, type Attempt, type LifecycleSession } from "./sessionLifecycle";
import { followEpoch, type Endpoints } from "./sessionShared";

const h = vi.hoisted(() => ({ leaves: [] as string[] }));
vi.mock("../stores/nodes", () => ({
  apiFor: () => ({ voice: { leave: async (_r: string, c: string) => void h.leaves.push(c) } }),
}));

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeSession extends LifecycleSession {
  closed: number;
}

const target = (channelId: string): VoiceTarget => ({ domain: "home.example", roomId: "r1", channelId });

/**
 * An engine whose connect runs in two steps (the node's answer, then the media connection), each a deferred, and
 * checks its attempt after each like the real engines. `abandon` counts the seat given back.
 */
function fakeEngine() {
  const steps: Array<{ answer: ReturnType<typeof deferred<void>>; media: ReturnType<typeof deferred<void>> }> = [];
  const log: string[] = [];
  const life: SessionLifecycle<FakeSession> = new SessionLifecycle<FakeSession>(
    {
      label: " (test)",
      async connect(attempt: Attempt) {
        const step = { answer: deferred<void>(), media: deferred<void>() };
        steps.push(step);
        const ep: Endpoints = {
          join: async () => ({}) as never,
          leave: async () => void log.push(`leave ${attempt.target.channelId}`),
          updateState: async () => undefined,
          joinScreen: async () => ({}) as never,
          leaveScreen: async () => undefined,
        };
        log.push(`connect ${attempt.target.channelId}`);
        await step.answer.promise;
        let session: FakeSession | null = null;
        try {
          attempt.check();
          const s: FakeSession = { id: attempt.id, target: attempt.target, ep, info: { reconnect_grace_secs: 30 } as never, leaving: false, mutedBeforeDeafen: false, closed: 0 };
          session = s;
          life.current = s;
          log.push(`mic on ${attempt.target.channelId}`);
          await step.media.promise;
          attempt.check();
          useVoice.setState({ status: "connected" });
        } catch (e) {
          if (session && !session.leaving) await cleanup(session);
          // JoinFlow.abandon: the seat goes back.
          await ep.leave();
          throw e;
        }
      },
      cleanup: async (s) => cleanup(s),
      identity: () => "me@home.example/1",
    },
    () => undefined,
  );
  async function cleanup(s: FakeSession) {
    s.leaving = true;
    s.closed++;
    log.push(`mic off ${s.target.channelId}`);
    if (life.current === s) life.current = null;
  }
  return { life, steps, log };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  useVoice.setState(IDLE);
  useToasts.setState({ toasts: [] });
  h.leaves.length = 0;
});

afterEach(() => vi.useRealTimers());

describe("leaving while a join runs (both engines)", () => {
  it("before the session exists: the join ends silently, nothing connects, the seat goes back", async () => {
    const { life, steps, log } = fakeEngine();
    const joined = life.join(target("c1"), { canCreate: true });
    await settle();
    expect(useVoice.getState().status).toBe("joining");
    await life.leave();
    expect(useVoice.getState().status).toBe("idle");
    // The node answers after the leave.
    steps[0]!.answer.resolve();
    await expect(joined).resolves.toBeUndefined();
    expect(log).toEqual(["connect c1", "leave c1"]);
    expect(useVoice.getState()).toMatchObject({ status: "idle", error: null, target: null });
    expect(useToasts.getState().toasts).toEqual([]);
    expect(life.current).toBeNull();
  });

  it("after the session exists: the microphone stops at once and once only, no error toast", async () => {
    const { life, steps, log } = fakeEngine();
    const joined = life.join(target("c1"), { canCreate: true });
    await settle();
    steps[0]!.answer.resolve();
    await settle();
    expect(log).toContain("mic on c1");
    const s = life.current!;
    await life.leave();
    expect(log.at(-1)).toBe("mic off c1");
    // The media connection the leave closed fails afterwards.
    steps[0]!.media.reject(new Error("connection closed"));
    await expect(joined).resolves.toBeUndefined();
    expect(s.closed).toBe(1);
    expect(log.filter((l) => l === "leave c1")).toHaveLength(1);
    expect(useVoice.getState()).toMatchObject({ status: "idle", error: null });
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it("joins asked for before a leave do not start", async () => {
    const { life, steps, log } = fakeEngine();
    const first = life.join(target("c1"), { canCreate: true });
    const second = life.join(target("c2"), { canCreate: true });
    await settle();
    await life.leave();
    steps[0]!.answer.resolve();
    await Promise.all([first, second]);
    expect(log).toEqual(["connect c1", "leave c1"]);
    expect(useVoice.getState().status).toBe("idle");
    // A join after the leave runs as usual.
    const third = life.join(target("c3"), { canCreate: true });
    await settle();
    steps[1]!.answer.resolve();
    await settle();
    steps[1]!.media.resolve();
    await third;
    expect(useVoice.getState().status).toBe("connected");
    expect(life.current?.target.channelId).toBe("c3");
  });

  it("a failure that is not a leave is reported", async () => {
    const { life, steps } = fakeEngine();
    const joined = life.join(target("c1"), { canCreate: true });
    await settle();
    steps[0]!.answer.reject(Object.assign(new Error("full"), { code: "voice.channel_full" }));
    await expect(joined).rejects.toThrow("full");
    expect(useVoice.getState().error).not.toBeNull();
  });

  it("a leave while rejoining stops the rejoin and gives the seat up", async () => {
    vi.useFakeTimers();
    const { life, steps } = fakeEngine();
    const joined = life.join(target("c1"), { canCreate: true });
    await settle();
    steps[0]!.answer.resolve();
    await settle();
    steps[0]!.media.resolve();
    await joined;
    const s = life.current!;
    const dropped = life.onDisconnected(s, "other");
    await settle();
    expect(useVoice.getState().status).toBe("reconnecting");
    await life.leave();
    expect(h.leaves).toEqual(["c1"]);
    await vi.advanceTimersByTimeAsync(5_000);
    await dropped;
    // No rejoin attempt started after the leave.
    expect(steps).toHaveLength(1);
    expect(useVoice.getState().status).toBe("idle");
  });

  it("JoinCancelled is not an error", () => {
    expect(new JoinCancelled()).toBeInstanceOf(Error);
  });
});

describe("the epoch catch-up (both engines)", () => {
  it("one catch-up at a time while the node's epoch is ahead, and a check once it settled", async () => {
    let local = 3;
    const running = deferred();
    const mls = { epoch: vi.fn(() => local), catchUp: vi.fn(() => running.promise) };
    const key = "home.example/c1";
    const off = followEpoch(key, "home.example/c1", mls);
    // Ten presence updates while this device is one epoch behind.
    for (let i = 0; i < 10; i++) useVoicePresence.setState((s) => ({ ...s, epochs: { ...s.epochs, [key]: 4 } }));
    expect(mls.catchUp).toHaveBeenCalledTimes(1);
    local = 4;
    running.resolve();
    await settle();
    // Caught up: the check after it settled finds nothing to do.
    expect(mls.catchUp).toHaveBeenCalledTimes(1);
    off();
    useVoicePresence.setState((s) => ({ ...s, epochs: { ...s.epochs, [key]: 9 } }));
    expect(mls.catchUp).toHaveBeenCalledTimes(1);
  });
});
