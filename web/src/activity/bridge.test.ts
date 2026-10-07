// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { Activity, PublicApplication } from "@tavrn/sdk";
import {
  BRIDGE_ERRORS,
  BRIDGE_PATH,
  BRIDGE_PORTS,
  BRIDGE_VERSION,
  Bridge,
  CLOSE_FORBIDDEN_ORIGIN,
  CLOSE_REFUSED,
  CONSENT_STORAGE_KEY,
  MAX_FRAME_CHARS,
  MockTransport,
  RATE_LIMIT_MS,
  applicationAllowed,
  fetchPublicDocument,
  isApplicationRef,
  localConsentStore,
  originAllowed,
  parseMessage,
  type BridgeClock,
  type BridgeDeps,
  type ConsentAnswer,
} from "./bridge";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const ID = "01J9Z8Y7X6W5V4T3S2R1Q0P9N8";
const REF = `games.example/${ID}`;
const STARTED = "2026-10-06T11:50:00Z";

function doc(over: Partial<PublicApplication> = {}): PublicApplication {
  return {
    ref: REF,
    id: ID,
    node: "games.example",
    name: "Space Miners",
    description: "",
    bot: "spaceminers@games.example",
    owner: "dev@games.example",
    public: true,
    avatar: null,
    requested_permissions: "0",
    scopes: ["presence"],
    rpc_origins: ["https://play.games.example"],
    commands_version: 0,
    commands: [],
    created_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

/** A clock whose timers run when the test advances it. */
class ManualClock implements BridgeClock {
  t = NOW;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== h);
  };
  async advance(ms: number) {
    this.t += ms;
    const due = this.timers.filter((x) => x.at <= this.t);
    this.timers = this.timers.filter((x) => x.at > this.t);
    for (const x of due) x.fn();
    await flush();
  }
  get scheduled() {
    return this.timers.length;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}

function setup(opts: { document?: PublicApplication | null; answer?: ConsentAnswer; hidden?: boolean; storage?: ReturnType<typeof memoryStorage> } = {}) {
  const clock = new ManualClock();
  const storage = opts.storage ?? memoryStorage();
  const published: (Activity | null)[] = [];
  const deps = {
    fetchDocument: vi.fn(async (_ref: string) => (opts.document === undefined ? doc() : opts.document)),
    askConsent: vi.fn(async () => (opts.answer === undefined ? "once" : opts.answer) as ConsentAnswer),
    publish: vi.fn(async (a: Activity | null) => void published.push(a)),
    hideActivity: vi.fn(() => !!opts.hidden),
    consent: localConsentStore(storage),
    clock,
  } satisfies BridgeDeps;
  const bridge = new Bridge(deps);
  return { clock, storage, published, deps, bridge };
}

const hello = (application = REF, v: number = BRIDGE_VERSION) => JSON.stringify({ op: "hello", v, application });
const set = (activity: Record<string, unknown>) => JSON.stringify({ op: "set_activity", activity: { type: "playing", name: "Space Miners", started_at: STARTED, ...activity } });
const clear = JSON.stringify({ op: "clear_activity" });

describe("constants", () => {
  it("match APPLICATIONS.md §7.3", () => {
    expect(BRIDGE_PATH).toBe("/tavrn-activity");
    expect(BRIDGE_VERSION).toBe(1);
    expect(BRIDGE_PORTS).toEqual([46480, 46481, 46482, 46483, 46484, 46485, 46486, 46487, 46488, 46489]);
    expect(CLOSE_FORBIDDEN_ORIGIN).toBe(4003);
    expect(RATE_LIMIT_MS).toBe(5000);
  });
});

describe("parseMessage", () => {
  it("accepts the three operations", () => {
    expect(parseMessage(hello(), NOW)).toEqual({ ok: true, message: { op: "hello", v: 1, application: REF } });
    expect(parseMessage(clear, NOW)).toEqual({ ok: true, message: { op: "clear_activity" } });
    const r = parseMessage(set({ details: " Ranked ", state: "In a party (2 of 4)", ends_at: "2026-10-06T13:00:00Z" }), NOW);
    expect(r).toEqual({
      ok: true,
      message: { op: "set_activity", activity: { type: "playing", name: "Space Miners", details: "Ranked", state: "In a party (2 of 4)", started_at: STARTED, ends_at: "2026-10-06T13:00:00Z" } },
    });
    // Already-parsed objects (a transport may hand them over) work too.
    expect(parseMessage({ op: "clear_activity" }, NOW).ok).toBe(true);
  });

  it("never throws on garbage", () => {
    const garbage: unknown[] = ["", "{", "null", "[]", "42", '"op"', "{}", '{"op":5}', undefined, null, 7, Symbol("x"), () => 1, new Date(), [{ op: "hello" }], "\u0000", "x".repeat(MAX_FRAME_CHARS + 1)];
    for (const g of garbage) expect(parseMessage(g, NOW)).toEqual({ ok: false, code: BRIDGE_ERRORS.invalid });
  });

  it("refuses unknown operations and fields", () => {
    for (const m of [
      { op: "get_user" },
      { op: "subscribe", events: ["*"] },
      { op: "HELLO", v: 1, application: REF },
      { op: "clear_activity", extra: 1 },
      { op: "hello", v: 1, application: REF, token: "x" },
      { op: "set_activity", activity: { type: "playing", name: "x", started_at: STARTED, buttons: [{ label: "Join" }] } },
      { op: "set_activity", activity: { type: "playing", name: "x", started_at: STARTED, application: { ref: REF, name: "Fake" } } },
    ]) {
      expect(parseMessage(JSON.stringify(m), NOW).ok, JSON.stringify(m)).toBe(false);
    }
  });

  it("refuses wrong types", () => {
    for (const m of [
      { op: "hello", v: "1", application: REF },
      { op: "hello", v: 1.5, application: REF },
      { op: "hello", v: 1, application: 7 },
      { op: "set_activity" },
      { op: "set_activity", activity: "playing" },
      { op: "set_activity", activity: [] },
      { op: "set_activity", activity: { type: "hacking", name: "x", started_at: STARTED } },
      { op: "set_activity", activity: { type: "playing", name: 5, started_at: STARTED } },
      { op: "set_activity", activity: { type: "playing", name: "x", details: 5, started_at: STARTED } },
      { op: "set_activity", activity: { type: "playing", name: "x", state: { a: 1 }, started_at: STARTED } },
      { op: "set_activity", activity: { type: "playing", name: "x" } },
      { op: "set_activity", activity: { type: "playing", name: "x", started_at: 1696500000 } },
      { op: "set_activity", activity: { type: "playing", name: "x", started_at: "yesterday" } },
    ]) {
      expect(parseMessage(JSON.stringify(m), NOW).ok, JSON.stringify(m)).toBe(false);
    }
  });

  it("refuses oversize strings, control characters and bad times", () => {
    const long = "x".repeat(129);
    for (const a of [
      { name: long },
      { name: "  " },
      { details: long },
      { state: long },
      { name: "a\u0007b" },
      { state: "line\nbreak" },
      { started_at: "2026-10-06T12:05:00Z" }, // in the future
      { ends_at: "2026-10-06T11:00:00Z" }, // before started_at
      { ends_at: STARTED }, // equal to started_at
      { ends_at: "2026-10-20T12:00:00Z" }, // more than a week ahead
    ]) {
      expect(parseMessage(set(a), NOW).ok, JSON.stringify(a)).toBe(false);
    }
    expect(parseMessage(set({ name: "x".repeat(128) }), NOW).ok).toBe(true);
    expect(parseMessage(set({ name: "😀".repeat(128) }), NOW).ok).toBe(true);
  });

  it("refuses bad application references", () => {
    for (const ref of ["", "games.example", `/${ID}`, `games.example/`, `games.example/not-a-ulid`, `Games.Example/${ID}`, `games.example:8080/${ID}`, `http://games.example/${ID}`, `games..example/${ID}`, `${"a".repeat(300)}.example/${ID}`, `games.example/${ID}/x`]) {
      expect(isApplicationRef(ref), ref).toBe(false);
      expect(parseMessage(hello(ref), NOW).ok, ref).toBe(false);
    }
    expect(isApplicationRef(REF)).toBe(true);
    expect(isApplicationRef(`localhost/${ID}`)).toBe(true);
  });
});

describe("origin rule", () => {
  const listed = ["https://play.games.example", "http://localhost:3000"];
  it("accepts native programs without Origin", () => {
    expect(originAllowed(null, [])).toBe(true);
    expect(originAllowed(undefined, [])).toBe(true);
  });
  it("accepts only listed origins", () => {
    expect(originAllowed("https://play.games.example", listed)).toBe(true);
    expect(originAllowed("https://PLAY.games.example:443", listed)).toBe(true);
    expect(originAllowed("http://localhost:3000", listed)).toBe(true);
    expect(originAllowed("https://evil.example", listed)).toBe(false);
    expect(originAllowed("http://play.games.example", listed)).toBe(false);
    expect(originAllowed("https://play.games.example.evil.example", listed)).toBe(false);
    expect(originAllowed("null", [...listed, "null"])).toBe(false);
    expect(originAllowed("", listed)).toBe(false);
    expect(originAllowed("file:///etc/passwd", ["file:///etc/passwd"])).toBe(false);
    expect(originAllowed("https://play.games.example", [])).toBe(false);
  });

  it("closes a connection from an unlisted origin with 4003 without an answer", async () => {
    const { bridge, deps } = setup();
    const t = new MockTransport();
    await bridge.connect(t, "https://evil.example").receive(hello());
    expect(t.closeCode).toBe(4003);
    expect(t.sent).toEqual([]);
    expect(deps.askConsent).not.toHaveBeenCalled();
  });

  it("an unlisted origin cannot tell unknown from known applications", async () => {
    const { bridge } = setup({ document: null });
    const t = new MockTransport();
    await bridge.connect(t, "https://evil.example").receive(hello());
    expect(t.closeCode).toBe(4003);
    expect(t.sent).toEqual([]);
  });

  it("lets a listed origin through", async () => {
    const { bridge } = setup();
    const t = new MockTransport();
    await bridge.connect(t, "https://play.games.example").receive(hello());
    expect(t.sent).toEqual([{ op: "ok" }]);
    expect(t.closeCode).toBeNull();
  });
});

describe("handshake", () => {
  it("refuses unknown, disabled or blocked applications", async () => {
    const { bridge, deps } = setup({ document: null });
    const t = new MockTransport();
    await bridge.connect(t).receive(hello());
    expect(t.sent).toEqual([{ op: "error", code: "app.not_allowed" }]);
    expect(t.closeCode).toBe(CLOSE_REFUSED);
    expect(deps.askConsent).not.toHaveBeenCalled();
  });

  it("refuses applications without the presence scope", async () => {
    const { bridge, deps } = setup({ document: doc({ scopes: ["messages:write", "commands"] }) });
    const t = new MockTransport();
    await bridge.connect(t).receive(hello());
    expect(t.sent).toEqual([{ op: "error", code: "app.not_allowed" }]);
    expect(deps.askConsent).not.toHaveBeenCalled();
  });

  it("refuses a document for another application or with a bot of another node", () => {
    expect(applicationAllowed(REF, doc())).toBe(true);
    expect(applicationAllowed(REF, doc({ ref: `games.example/01J9Z8Y7X6W5V4T3S2R1Q0P9N9` }))).toBe(false);
    expect(applicationAllowed(REF, doc({ bot: "spaceminers@evil.example" }))).toBe(false);
    expect(applicationAllowed(REF, doc({ name: " " }))).toBe(false);
    expect(applicationAllowed(REF, null)).toBe(false);
  });

  it("treats a failing document fetch as unknown", async () => {
    const { bridge, deps } = setup();
    deps.fetchDocument.mockRejectedValueOnce(new Error("network"));
    const t = new MockTransport();
    await bridge.connect(t).receive(hello());
    expect(t.last).toEqual({ op: "error", code: "app.not_allowed" });
    expect(await fetchPublicDocument(REF, async () => Promise.reject(new Error("404")))).toBeNull();
    expect(await fetchPublicDocument("bad", async () => doc())).toBeNull();
    const seen: string[] = [];
    await fetchPublicDocument(REF, async (d, id) => (seen.push(d, id), doc()));
    expect(seen).toEqual(["games.example", ID]);
  });

  it("refuses another protocol version", async () => {
    const { bridge, deps } = setup();
    const t = new MockTransport();
    await bridge.connect(t).receive(hello(REF, 2));
    expect(t.sent).toEqual([{ op: "error", code: BRIDGE_ERRORS.version }]);
    expect(t.closeCode).toBe(CLOSE_REFUSED);
    expect(deps.fetchDocument).not.toHaveBeenCalled();
  });

  it("requires hello first and only once", async () => {
    const { bridge } = setup();
    const t = new MockTransport();
    const s = bridge.connect(t);
    await s.receive(set({}));
    await s.receive(clear);
    expect(t.sent).toEqual([
      { op: "error", code: BRIDGE_ERRORS.handshake },
      { op: "error", code: BRIDGE_ERRORS.handshake },
    ]);
    await s.receive(hello());
    await s.receive(hello());
    expect(t.sent.slice(2)).toEqual([{ op: "ok" }, { op: "error", code: BRIDGE_ERRORS.handshake }]);
  });

  it("answers invalid frames with bridge.invalid and keeps the connection", async () => {
    const { bridge } = setup();
    const t = new MockTransport();
    const s = bridge.connect(t);
    await s.receive("not json");
    expect(t.sent).toEqual([{ op: "error", code: BRIDGE_ERRORS.invalid }]);
    expect(t.closeCode).toBeNull();
  });

  it("never tells the program anything but ok and error codes", async () => {
    const { bridge } = setup();
    const t = new MockTransport();
    const s = bridge.connect(t);
    await s.receive(hello());
    await s.receive(set({}));
    await s.receive(clear);
    for (const m of t.sent) expect(Object.keys(m).every((k) => k === "op" || k === "code")).toBe(true);
  });
});

describe("consent", () => {
  it("asks once with name and bot address, publishes with 'once' and stores nothing", async () => {
    const { bridge, deps, storage, published } = setup({ answer: "once" });
    const t = new MockTransport();
    const s = bridge.connect(t);
    await s.receive(hello());
    expect(deps.askConsent).toHaveBeenCalledWith({ ref: REF, name: "Space Miners", bot: "spaceminers@games.example" });
    expect(t.sent).toEqual([{ op: "ok" }]);
    expect(storage.map.has(CONSENT_STORAGE_KEY)).toBe(false);
    await s.receive(set({}));
    await flush();
    expect(published).toHaveLength(1);
    // The next connection is asked again.
    await bridge.connect(new MockTransport()).receive(hello());
    expect(deps.askConsent).toHaveBeenCalledTimes(2);
  });

  it("stores 'always' per application ref and does not ask again", async () => {
    const storage = memoryStorage();
    const first = setup({ answer: "always", storage });
    await first.bridge.connect(new MockTransport()).receive(hello());
    expect(JSON.parse(storage.map.get(CONSENT_STORAGE_KEY)!)[REF]).toMatchObject({ ref: REF, name: "Space Miners", bot: "spaceminers@games.example", decision: "always" });

    const second = setup({ answer: "never", storage });
    const t = new MockTransport();
    await second.bridge.connect(t).receive(hello());
    expect(second.deps.askConsent).not.toHaveBeenCalled();
    expect(t.sent).toEqual([{ op: "ok" }]);

    // Another application is still asked.
    const other = `games.example/01J9Z8Y7X6W5V4T3S2R1Q0P9N9`;
    second.deps.fetchDocument.mockResolvedValueOnce(doc({ ref: other, id: "01J9Z8Y7X6W5V4T3S2R1Q0P9N9", name: "Other" }));
    await second.bridge.connect(new MockTransport()).receive(hello(other));
    expect(second.deps.askConsent).toHaveBeenCalledTimes(1);
  });

  it("stores 'never' and refuses without asking again", async () => {
    const storage = memoryStorage();
    const first = setup({ answer: "never", storage });
    const t1 = new MockTransport();
    await first.bridge.connect(t1).receive(hello());
    expect(t1.sent).toEqual([{ op: "error", code: "app.not_allowed" }]);
    expect(t1.closeCode).toBe(CLOSE_REFUSED);

    const second = setup({ answer: "always", storage });
    const t2 = new MockTransport();
    await second.bridge.connect(t2).receive(hello());
    expect(second.deps.askConsent).not.toHaveBeenCalled();
    expect(t2.sent).toEqual([{ op: "error", code: "app.not_allowed" }]);
    expect(first.published).toEqual([]);
  });

  it("a dismissed prompt refuses this time and stores nothing", async () => {
    const { bridge, storage } = setup({ answer: null });
    const t = new MockTransport();
    await bridge.connect(t).receive(hello());
    expect(t.last).toEqual({ op: "error", code: "app.not_allowed" });
    expect(storage.map.has(CONSENT_STORAGE_KEY)).toBe(false);
  });

  it("revoking removes the decision so the application is asked again", async () => {
    const storage = memoryStorage();
    const { bridge, deps } = setup({ answer: "always", storage });
    await bridge.connect(new MockTransport()).receive(hello());
    const store = localConsentStore(storage);
    expect(store.list().map((e) => e.ref)).toEqual([REF]);
    store.revoke(REF);
    expect(store.list()).toEqual([]);
    expect(storage.map.has(CONSENT_STORAGE_KEY)).toBe(false);
    await bridge.connect(new MockTransport()).receive(hello());
    expect(deps.askConsent).toHaveBeenCalledTimes(2);
  });

  it("users with hide_activity are asked nothing and nothing is shown", async () => {
    const { bridge, deps, published, clock } = setup({ hidden: true, answer: "always" });
    const t = new MockTransport();
    const s = bridge.connect(t);
    await s.receive(hello());
    await s.receive(set({}));
    await s.receive(clear);
    await clock.advance(RATE_LIMIT_MS);
    await s.disconnected();
    expect(deps.askConsent).not.toHaveBeenCalled();
    expect(published).toEqual([]);
    // The program cannot tell the activity is hidden.
    expect(t.sent).toEqual([{ op: "ok" }, { op: "ok" }, { op: "ok" }]);
  });

  it("survives broken or unavailable storage", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    const store = localConsentStore(broken);
    expect(store.get(REF)).toBeNull();
    expect(() => store.set({ ref: REF, name: "x", bot: "b@games.example", decision: "always", decided_at: 1 })).not.toThrow();
    expect(store.list()).toEqual([]);
    expect(localConsentStore(null).list()).toEqual([]);
    const corrupt = memoryStorage();
    corrupt.map.set(CONSENT_STORAGE_KEY, JSON.stringify({ [REF]: { ref: REF, name: "x", bot: "b", decision: "maybe", decided_at: 1 }, "x/y": { ref: "x/y" } }));
    expect(localConsentStore(corrupt).list()).toEqual([]);
    corrupt.map.set(CONSENT_STORAGE_KEY, "{not json");
    expect(localConsentStore(corrupt).get(REF)).toBeNull();
  });
});

describe("publishing", () => {
  async function ready(over: Parameters<typeof setup>[0] = {}) {
    const ctx = setup({ answer: "always", ...over });
    const t = new MockTransport();
    const s = ctx.bridge.connect(t);
    await s.receive(hello());
    return { ...ctx, t, s };
  }

  it("adds the application from the public document", async () => {
    const { s, published } = await ready();
    await s.receive(set({ details: "Ranked match", state: "In a party (2 of 4)", ends_at: "2026-10-06T12:30:00Z" }));
    await flush();
    expect(published).toEqual([
      {
        type: "playing",
        name: "Space Miners",
        details: "Ranked match",
        state: "In a party (2 of 4)",
        started_at: STARTED,
        ends_at: "2026-10-06T12:30:00Z",
        application: { ref: REF, name: "Space Miners" },
      },
    ]);
  });

  it("coalesces updates within 5 s and publishes the latest one", async () => {
    const { s, t, published, clock } = await ready();
    await s.receive(set({ details: "1" }));
    await flush();
    expect(published.map((a) => a?.details)).toEqual(["1"]);
    await clock.advance(1000);
    await s.receive(set({ details: "2" }));
    await s.receive(set({ details: "3" }));
    await s.receive(set({ details: "4" }));
    // Every update is acknowledged, none published yet.
    expect(t.sent.filter((m) => m.op === "ok")).toHaveLength(5);
    expect(published).toHaveLength(1);
    expect(clock.scheduled).toBe(1);
    await clock.advance(3999);
    expect(published).toHaveLength(1);
    await clock.advance(1);
    expect(published.map((a) => a?.details)).toEqual(["1", "4"]);
    // Nothing waiting, nothing more published.
    await clock.advance(RATE_LIMIT_MS * 3);
    expect(published).toHaveLength(2);
    // After the interval the next update goes out at once.
    await s.receive(set({ details: "5" }));
    await flush();
    expect(published.map((a) => a?.details)).toEqual(["1", "4", "5"]);
  });

  it("a clear inside the interval is coalesced too", async () => {
    const { s, published, clock } = await ready();
    await s.receive(set({}));
    await flush();
    await s.receive(set({ details: "x" }));
    await s.receive(clear);
    await clock.advance(RATE_LIMIT_MS);
    expect(published).toHaveLength(2);
    expect(published[1]).toBeNull();
  });

  it("clears the activity when the program disconnects", async () => {
    const { s, published, clock } = await ready();
    await s.receive(set({}));
    await flush();
    await s.receive(set({ details: "pending" }));
    await s.disconnected();
    expect(published).toHaveLength(2);
    expect(published[1]).toBeNull();
    // The pending update was dropped.
    await clock.advance(RATE_LIMIT_MS * 2);
    expect(published).toHaveLength(2);
    expect(s.closed).toBe(true);
  });

  it("does not clear on disconnect when nothing was published", async () => {
    const { s, published } = await ready();
    await s.disconnected();
    expect(published).toEqual([]);
  });

  it("only the program whose activity is shown clears it", async () => {
    const { bridge, s, published } = await ready();
    const t2 = new MockTransport();
    const other = bridge.connect(t2);
    await other.receive(hello());
    await s.receive(set({ details: "first" }));
    await flush();
    await other.receive(set({ details: "second" }));
    await flush();
    await s.receive(clear);
    await s.disconnected();
    expect(published.map((a) => a?.details ?? null)).toEqual(["first", "second"]);
    await other.disconnected();
    expect(published.map((a) => a?.details ?? null)).toEqual(["first", "second", null]);
    expect(bridge.connections).toBe(0);
  });

  it("does not publish when hide_activity was switched on later", async () => {
    const { s, published, deps } = await ready();
    deps.hideActivity.mockReturnValue(true);
    await s.receive(set({}));
    await flush();
    expect(published).toEqual([]);
  });

  it("swallows publish failures", async () => {
    const { s, t, deps } = await ready();
    deps.publish.mockRejectedValueOnce(new Error("offline"));
    await s.receive(set({}));
    await flush();
    expect(t.last).toEqual({ op: "ok" });
  });

  it("refuses frames beyond the queue limit", async () => {
    const { bridge, deps } = setup({ answer: "always" });
    let release!: (d: PublicApplication) => void;
    deps.fetchDocument.mockImplementationOnce(() => new Promise<PublicApplication>((r) => (release = r)));
    const t = new MockTransport();
    const s = bridge.connect(t);
    void s.receive(hello());
    for (let i = 0; i < 20; i++) void s.receive(clear);
    expect(t.sent.filter((m) => m.op === "error" && m.code === BRIDGE_ERRORS.busy).length).toBeGreaterThan(0);
    await flush();
    release(doc());
    await flush();
    expect(t.sent.find((m) => m.op === "ok" || m.code !== BRIDGE_ERRORS.busy)).toEqual({ op: "ok" });
  });
});
