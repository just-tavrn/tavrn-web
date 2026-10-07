// SPDX-License-Identifier: Apache-2.0
/**
 * The local activity bridge (APPLICATIONS.md §7.3): a local program (a game or its launcher) connects to
 * the user's desktop client over a loopback WebSocket and asks it to show what the user is doing. The
 * client checks the application, asks the user once and then publishes the activity on the user's own
 * sessions (`PUT /users/me/activity` on every node, PROTOCOL.md §6a).
 *
 * This module holds the protocol (constants, message types, a strict parser), the origin, handshake and
 * consent rules and the per-connection state machine. It has no listener: browsers cannot accept
 * connections; the loopback listener comes with the desktop app (phase 6) and only has to feed raw
 * frames into {@link Bridge.connect} / {@link BridgeSession.receive} and call
 * {@link BridgeSession.disconnected}. Every dependency is injected, so the whole flow is unit-tested.
 *
 * Privacy: the program only ever receives `ok` and `error { code }` answers. It never learns the user's
 * identity, tokens, rooms, contacts or even whether the activity is hidden.
 */
import type { Activity, PublicApplication } from "@tavrn/sdk";

// ---------------------------------------------------------------- protocol constants

/** Path of the listener: `ws://127.0.0.1:<port>/tavrn-activity?v=1`. */
export const BRIDGE_PATH = "/tavrn-activity";
/** Protocol version (query `v` and `hello.v`). */
export const BRIDGE_VERSION = 1;
/** The listener takes the first free port of this range; programs try them in order. */
export const BRIDGE_PORT_FIRST = 46480;
export const BRIDGE_PORT_LAST = 46489;
export const BRIDGE_PORTS: readonly number[] = Array.from({ length: BRIDGE_PORT_LAST - BRIDGE_PORT_FIRST + 1 }, (_, i) => BRIDGE_PORT_FIRST + i);
/** Close code for a forbidden origin. */
export const CLOSE_FORBIDDEN_ORIGIN = 4003;
/** Close code after a refused handshake (WebSocket "policy violation"). */
export const CLOSE_REFUSED = 1008;
/** At most one published update per interval; updates in between are coalesced (the last one wins). */
export const RATE_LIMIT_MS = 5_000;
/** Largest frame the bridge parses at all (characters). */
export const MAX_FRAME_CHARS = 4_096;
/** Text fields of an activity (`name`, `details`, `state`). */
export const ACTIVITY_TEXT_MAX = 128;
/** Longest application reference accepted. */
export const REF_MAX = 300;
/** `started_at` may lie this far in the future (clock skew), like the node. */
export const START_SKEW_MS = 60_000;
/** `ends_at` at most a week ahead, like the node. */
export const MAX_DURATION_MS = 7 * 24 * 3600_000;
/** Frames waiting for an answer per connection before further frames are refused. */
export const MAX_PENDING_FRAMES = 16;
export const ACTIVITY_TYPES = ["playing", "listening", "watching", "streaming", "competing"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** The only scope that lets an application use the bridge. */
export const PRESENCE_SCOPE = "presence";

/** Error codes sent to the program. */
export const BRIDGE_ERRORS = {
  /** Unparseable or invalid frame. */
  invalid: "bridge.invalid",
  /** Operation before (or a second) `hello`. */
  handshake: "bridge.handshake_required",
  /** Unsupported protocol version. */
  version: "bridge.version_unsupported",
  /** Too many frames waiting. */
  busy: "bridge.busy",
  /** Unknown, disabled or blocked application, no `presence` scope, or the user said no. */
  notAllowed: "app.not_allowed",
} as const;
export type BridgeErrorCode = (typeof BRIDGE_ERRORS)[keyof typeof BRIDGE_ERRORS];

// ---------------------------------------------------------------- messages

/** The activity a program may send (`application` is added by the client). */
export interface BridgeActivity {
  type: ActivityType;
  name: string;
  details?: string | null;
  state?: string | null;
  started_at: string;
  ends_at?: string | null;
}

export type HelloMessage = { op: "hello"; v: number; application: string };
export type SetActivityMessage = { op: "set_activity"; activity: BridgeActivity };
export type ClearActivityMessage = { op: "clear_activity" };
export type BridgeRequest = HelloMessage | SetActivityMessage | ClearActivityMessage;

export type OkAnswer = { op: "ok" };
export type ErrorAnswer = { op: "error"; code: BridgeErrorCode };
export type BridgeAnswer = OkAnswer | ErrorAnswer;

export type ParseResult = { ok: true; message: BridgeRequest } | { ok: false; code: BridgeErrorCode };

// ---------------------------------------------------------------- validation

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:[Zz]|[+-]\d{2}:\d{2})$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function validDomain(d: string): boolean {
  return d.length > 0 && d.length <= 253 && d.split(".").every((l) => DOMAIN_LABEL.test(l));
}

/** `<domain>/<ULID>` with a lowercase host name (the node's rule, PROTOCOL.md §6a). */
export function isApplicationRef(v: unknown): v is string {
  if (typeof v !== "string" || v.length > REF_MAX) return false;
  const slash = v.lastIndexOf("/");
  if (slash <= 0) return false;
  return validDomain(v.slice(0, slash)) && ULID.test(v.slice(slash + 1));
}

/** Splits a valid reference into its node domain and application id. */
export function splitRef(ref: string): { domain: string; id: string } {
  const slash = ref.lastIndexOf("/");
  return { domain: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

/** A required text: trimmed, 1–128 characters, no control characters. */
function text(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s || [...s].length > ACTIVITY_TEXT_MAX || CONTROL.test(s)) return undefined;
  return s;
}

/** An optional text: absent/null/empty → null; invalid → undefined. */
function optionalText(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return undefined;
  if (!v.trim()) return null;
  return text(v);
}

function time(v: unknown): number | undefined {
  if (typeof v !== "string" || v.length > 40 || !RFC3339.test(v)) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Validates the `activity` of `set_activity` against the node's rules (so a refused update is answered
 * here, not by a node): known type, name 1–128, optional details/state ≤ 128, `started_at` not in the
 * future, `ends_at` after `started_at` and at most a week ahead. Unknown fields are refused.
 */
export function parseActivity(v: unknown, now: number): BridgeActivity | null {
  if (!isPlainObject(v) || !onlyKeys(v, ["type", "name", "details", "state", "started_at", "ends_at"])) return null;
  if (typeof v.type !== "string" || !(ACTIVITY_TYPES as readonly string[]).includes(v.type)) return null;
  const name = text(v.name);
  const details = optionalText(v.details);
  const state = optionalText(v.state);
  if (name === undefined || details === undefined || state === undefined) return null;
  const started = time(v.started_at);
  if (started === undefined || started > now + START_SKEW_MS) return null;
  let ends_at: string | null = null;
  if (v.ends_at !== undefined && v.ends_at !== null) {
    const ends = time(v.ends_at);
    if (ends === undefined || ends <= started || ends > now + MAX_DURATION_MS) return null;
    ends_at = v.ends_at as string;
  }
  return { type: v.type as ActivityType, name, details, state, started_at: v.started_at as string, ends_at };
}

/**
 * Parses one frame from a program. Never throws: garbage, unknown operations, wrong types, oversize
 * strings and malformed references give `bridge.invalid`.
 */
export function parseMessage(raw: unknown, now: number): ParseResult {
  const invalid: ParseResult = { ok: false, code: BRIDGE_ERRORS.invalid };
  let data: unknown;
  if (typeof raw === "string") {
    if (raw.length > MAX_FRAME_CHARS) return invalid;
    try {
      data = JSON.parse(raw);
    } catch {
      return invalid;
    }
  } else {
    data = raw;
  }
  if (!isPlainObject(data) || typeof data.op !== "string") return invalid;
  switch (data.op) {
    case "hello": {
      if (!onlyKeys(data, ["op", "v", "application"])) return invalid;
      if (typeof data.v !== "number" || !Number.isInteger(data.v)) return invalid;
      if (!isApplicationRef(data.application)) return invalid;
      return { ok: true, message: { op: "hello", v: data.v, application: data.application } };
    }
    case "set_activity": {
      if (!onlyKeys(data, ["op", "activity"])) return invalid;
      const activity = parseActivity(data.activity, now);
      return activity ? { ok: true, message: { op: "set_activity", activity } } : invalid;
    }
    case "clear_activity":
      return onlyKeys(data, ["op"]) ? { ok: true, message: { op: "clear_activity" } } : invalid;
    default:
      return invalid;
  }
}

// ---------------------------------------------------------------- origin rule

/** `https://Game.example:443/` → `https://game.example`; null when not an http(s) origin. */
export function normalizeOrigin(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Connections without an `Origin` header (native programs) are accepted; with one only when it is listed
 * in the application's `rpc_origins` (compared as normalized origins; the opaque origin `null` never).
 */
export function originAllowed(origin: string | null | undefined, rpcOrigins: readonly string[]): boolean {
  if (origin === undefined || origin === null) return true;
  const mine = normalizeOrigin(origin);
  if (!mine) return false;
  return rpcOrigins.some((o) => typeof o === "string" && normalizeOrigin(o) === mine);
}

// ---------------------------------------------------------------- handshake rule

/** What the consent prompt and the settings show of an application. */
export interface BridgeApp {
  ref: string;
  name: string;
  /** Bot address (shown in the prompt: "Allow <name> (<bot>) …"). */
  bot: string;
}

/**
 * Whether the public document allows the application on the bridge: it must be the requested one (same
 * reference), its bot must live on the application's node and its `scopes` must include `presence`.
 * Unknown, disabled and blocked applications have no document (`fetchDocument` gives null).
 */
export function applicationAllowed(ref: string, doc: PublicApplication | null | undefined): doc is PublicApplication {
  if (!doc || typeof doc !== "object") return false;
  if (typeof doc.ref !== "string" || doc.ref.toLowerCase() !== ref.toLowerCase()) return false;
  const { domain } = splitRef(ref);
  if (typeof doc.bot !== "string" || doc.bot.slice(doc.bot.lastIndexOf("@") + 1).toLowerCase() !== domain) return false;
  if (typeof doc.name !== "string" || !doc.name.trim()) return false;
  return Array.isArray(doc.scopes) && doc.scopes.includes(PRESENCE_SCOPE);
}

/**
 * Fetches the public document of `ref` from the application's node with `publicDocument(domain, id)`;
 * a 404 (unknown, disabled, blocked) or any other failure gives null.
 */
export async function fetchPublicDocument(ref: string, publicDocument: (domain: string, id: string) => Promise<PublicApplication>): Promise<PublicApplication | null> {
  if (!isApplicationRef(ref)) return null;
  const { domain, id } = splitRef(ref);
  try {
    return await publicDocument(domain, id);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- consent

/** The user's answer to the prompt; null = dismissed (refused this time, nothing stored). */
export type ConsentAnswer = "once" | "always" | "never" | null;
export type StoredDecision = "always" | "never";

export interface ConsentEntry {
  ref: string;
  name: string;
  bot: string;
  decision: StoredDecision;
  /** Epoch milliseconds. */
  decided_at: number;
}

/** Device-local storage of the decisions, one per application reference. */
export interface ConsentStore {
  get(ref: string): ConsentEntry | null;
  set(entry: ConsentEntry): void;
  /** Removes the decision: the application is asked again next time. */
  revoke(ref: string): void;
  list(): ConsentEntry[];
}

/** localStorage key of the decisions (device-local settings). */
export const CONSENT_STORAGE_KEY = "tavrn.activity.consent";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function validEntry(e: unknown): e is ConsentEntry {
  if (!isPlainObject(e)) return false;
  return (
    isApplicationRef(e.ref) &&
    typeof e.name === "string" &&
    e.name.length <= 256 &&
    typeof e.bot === "string" &&
    e.bot.length <= 512 &&
    (e.decision === "always" || e.decision === "never") &&
    typeof e.decided_at === "number"
  );
}

const listeners = new Set<() => void>();
/** Called after every change of the stored decisions (the settings list re-renders). */
export function onConsentChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Decisions in `localStorage` (every access wrapped: private windows and blocked storage just mean
 * "nothing stored", the user is asked again). Corrupt entries are ignored.
 */
export function localConsentStore(storage: StorageLike | null = defaultStorage()): ConsentStore {
  const read = (): Record<string, ConsentEntry> => {
    try {
      const raw = storage?.getItem(CONSENT_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (!isPlainObject(parsed)) return {};
      const out: Record<string, ConsentEntry> = {};
      for (const [k, v] of Object.entries(parsed)) if (validEntry(v) && v.ref === k) out[k] = v;
      return out;
    } catch {
      return {};
    }
  };
  const write = (all: Record<string, ConsentEntry>) => {
    try {
      if (Object.keys(all).length) storage?.setItem(CONSENT_STORAGE_KEY, JSON.stringify(all));
      else storage?.removeItem(CONSENT_STORAGE_KEY);
    } catch {
      /* storage unavailable: the decision lasts for this session only */
    }
    for (const fn of [...listeners]) fn();
  };
  return {
    get: (ref) => read()[ref] ?? null,
    set: (entry) => write({ ...read(), [entry.ref]: entry }),
    revoke: (ref) => {
      const { [ref]: _gone, ...rest } = read();
      write(rest);
    },
    list: () => Object.values(read()).sort((a, b) => a.name.localeCompare(b.name) || a.ref.localeCompare(b.ref)),
  };
}

// ---------------------------------------------------------------- session

/** The connection to one program (a WebSocket in the desktop app). */
export interface BridgeTransport {
  send(answer: BridgeAnswer): void;
  close(code: number, reason?: string): void;
}

/** Time source (injected for tests). */
export interface BridgeClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: BridgeClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface BridgeDeps {
  /** The public document of an application ref (§1.8) from its node; null when unknown, disabled or blocked. */
  fetchDocument(ref: string): Promise<PublicApplication | null>;
  /** Asks the user "Allow <name> (<bot>) to show what you are doing?". */
  askConsent(app: BridgeApp): Promise<ConsentAnswer>;
  /** Publishes (`PUT /users/me/activity`) or clears (`DELETE`, null) the activity on every node with a session. */
  publish(activity: Activity | null): Promise<void>;
  /** The user's `hide_activity` setting: when on, nobody is asked and nothing is published. */
  hideActivity(): boolean | Promise<boolean>;
  consent: ConsentStore;
  clock?: BridgeClock;
}

type Phase = "hello" | "handshake" | "ready" | "closed";

/** One connected program. Created by {@link Bridge.connect}. */
export class BridgeSession {
  private phase: Phase = "hello";
  private app: BridgeApp | null = null;
  /** The user's choice for this connection (true also for "allow once"). */
  private allowed = false;
  private hidden = false;
  private chain: Promise<void> = Promise.resolve();
  private waiting = 0;
  /** The update waiting for the rate limit (undefined: none; null: clear). */
  private pending: Activity | null | undefined = undefined;
  private timer: unknown = null;
  private lastPublish = -Infinity;
  private readonly clock: BridgeClock;

  constructor(
    private readonly bridge: Bridge,
    private readonly deps: BridgeDeps,
    private readonly transport: BridgeTransport,
    /** The `Origin` header of the connection (null: none, a native program). */
    private readonly origin: string | null,
  ) {
    this.clock = deps.clock ?? systemClock;
  }

  /** The application of this connection once the handshake passed. */
  get application(): BridgeApp | null {
    return this.phase === "ready" ? this.app : null;
  }

  get closed(): boolean {
    return this.phase === "closed";
  }

  /** Handles one frame; frames are processed in order. Resolves when this frame is answered. */
  receive(raw: unknown): Promise<void> {
    if (this.phase === "closed") return Promise.resolve();
    if (this.waiting >= MAX_PENDING_FRAMES) {
      this.answer({ op: "error", code: BRIDGE_ERRORS.busy });
      return Promise.resolve();
    }
    this.waiting++;
    this.chain = this.chain
      .then(() => this.handle(raw))
      .catch(() => this.answer({ op: "error", code: BRIDGE_ERRORS.invalid }))
      .finally(() => {
        this.waiting--;
      });
    return this.chain;
  }

  /** The program disconnected: drops a waiting update and clears what this program published. */
  async disconnected(): Promise<void> {
    if (this.phase === "closed") return;
    this.phase = "closed";
    this.cancelTimer();
    this.pending = undefined;
    await this.bridge.release(this);
  }

  private answer(a: BridgeAnswer) {
    if (this.phase === "closed") return;
    try {
      this.transport.send(a);
    } catch {
      /* the program went away; `disconnected` follows */
    }
  }

  private close(code: number, reason: string) {
    try {
      this.transport.close(code, reason);
    } catch {
      /* already closed */
    }
    void this.disconnected();
  }

  private refuse() {
    this.answer({ op: "error", code: BRIDGE_ERRORS.notAllowed });
    this.close(CLOSE_REFUSED, BRIDGE_ERRORS.notAllowed);
  }

  private async handle(raw: unknown): Promise<void> {
    if (this.phase === "closed") return;
    const parsed = parseMessage(raw, this.clock.now());
    if (!parsed.ok) return this.answer({ op: "error", code: parsed.code });
    const msg = parsed.message;
    if (msg.op === "hello") {
      if (this.phase !== "hello") return this.answer({ op: "error", code: BRIDGE_ERRORS.handshake });
      return this.hello(msg);
    }
    if (this.phase !== "ready") return this.answer({ op: "error", code: BRIDGE_ERRORS.handshake });
    if (msg.op === "set_activity") {
      const a = msg.activity;
      const app = this.app!;
      this.schedule({
        type: a.type,
        name: a.name,
        details: a.details ?? null,
        state: a.state ?? null,
        started_at: a.started_at,
        ends_at: a.ends_at ?? null,
        application: { ref: app.ref, name: app.name },
      });
    } else {
      this.schedule(null);
    }
    this.answer({ op: "ok" });
  }

  private async hello(msg: HelloMessage): Promise<void> {
    this.phase = "handshake";
    if (msg.v !== BRIDGE_VERSION) {
      this.answer({ op: "error", code: BRIDGE_ERRORS.version });
      return this.close(CLOSE_REFUSED, BRIDGE_ERRORS.version);
    }
    let doc: PublicApplication | null = null;
    try {
      doc = await this.deps.fetchDocument(msg.application);
    } catch {
      doc = null;
    }
    if (this.closed) return;
    // A connection with an Origin header learns nothing but the close code unless its origin is listed.
    const origins = doc && Array.isArray(doc.rpc_origins) ? doc.rpc_origins : [];
    if (!originAllowed(this.origin, origins)) return this.close(CLOSE_FORBIDDEN_ORIGIN, "origin");
    if (!applicationAllowed(msg.application, doc)) return this.refuse();
    const app: BridgeApp = { ref: doc.ref, name: doc.name.trim().slice(0, ACTIVITY_TEXT_MAX), bot: doc.bot };
    this.app = app;
    if (await this.isHidden()) {
      // Asked nothing, shown nothing; the program cannot tell.
      this.hidden = true;
      this.phase = "ready";
      return this.answer({ op: "ok" });
    }
    const stored = this.deps.consent.get(app.ref);
    let decision: ConsentAnswer = stored?.decision ?? null;
    if (!stored) {
      try {
        decision = await this.deps.askConsent(app);
      } catch {
        decision = null;
      }
      if (decision === "always" || decision === "never") {
        this.deps.consent.set({ ref: app.ref, name: app.name, bot: app.bot, decision, decided_at: this.clock.now() });
      }
    }
    if (this.closed) return;
    if (decision !== "once" && decision !== "always") return this.refuse();
    this.allowed = true;
    this.phase = "ready";
    this.answer({ op: "ok" });
  }

  private async isHidden(): Promise<boolean> {
    try {
      return !!(await this.deps.hideActivity());
    } catch {
      return true;
    }
  }

  /** Publishes now, or after the rate limit with the latest update (coalesced). */
  private schedule(next: Activity | null) {
    if (!this.allowed || this.hidden) return;
    this.pending = next;
    if (this.timer !== null) return;
    const wait = this.lastPublish + RATE_LIMIT_MS - this.clock.now();
    if (wait <= 0) {
      void this.flush();
      return;
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  private cancelTimer() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private async flush() {
    if (this.phase === "closed" || this.pending === undefined) return;
    const next = this.pending;
    this.pending = undefined;
    this.lastPublish = this.clock.now();
    // The setting may have changed since the handshake.
    if (await this.isHidden()) return;
    if (this.closed) return;
    await this.bridge.publishFrom(this, next);
  }
}

/**
 * The bridge controller: one per desktop client. Several programs may be connected; the activity shown
 * is the one published last, and only its program's disconnect clears it.
 */
export class Bridge {
  private readonly sessions = new Set<BridgeSession>();
  /** The session whose activity is currently published. */
  private owner: BridgeSession | null = null;

  constructor(private readonly deps: BridgeDeps) {}

  /** A program connected (`origin`: its `Origin` header, null without one). */
  connect(transport: BridgeTransport, origin: string | null = null): BridgeSession {
    const s = new BridgeSession(this, this.deps, transport, origin);
    this.sessions.add(s);
    return s;
  }

  get connections(): number {
    return this.sessions.size;
  }

  /** @internal Publishes for `session` (null clears) and records it as the owner. */
  async publishFrom(session: BridgeSession, activity: Activity | null): Promise<void> {
    if (activity === null && this.owner !== session) return;
    this.owner = activity ? session : null;
    try {
      await this.deps.publish(activity);
    } catch {
      /* a node was unreachable; the next update retries */
    }
  }

  /** @internal A session ended: clears its activity if it is the one shown. */
  async release(session: BridgeSession): Promise<void> {
    this.sessions.delete(session);
    if (this.owner !== session) return;
    this.owner = null;
    try {
      await this.deps.publish(null);
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------- test double

/** A transport that records what the bridge sends (Vitest; also handy for a desktop smoke test). */
export class MockTransport implements BridgeTransport {
  readonly sent: BridgeAnswer[] = [];
  closeCode: number | null = null;
  closeReason: string | undefined;
  send(answer: BridgeAnswer): void {
    if (this.closeCode !== null) throw new Error("closed");
    this.sent.push(answer);
  }
  close(code: number, reason?: string): void {
    if (this.closeCode === null) {
      this.closeCode = code;
      this.closeReason = reason;
    }
  }
  get last(): BridgeAnswer | undefined {
    return this.sent[this.sent.length - 1];
  }
}
