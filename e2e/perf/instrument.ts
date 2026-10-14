// SPDX-License-Identifier: Apache-2.0
/**
 * Client performance measurement helpers: what one user action costs in the browser (Playwright, Chromium). A recorder
 * attached to a page counts, per measured window, the HTTP requests (method, normalised path, status, bytes,
 * duration, start offset), the WebSocket events received, the long tasks and long animation frames, and the React
 * commits with the components that rendered (through a minimal DevTools hook installed before the app loads; names
 * are readable in development builds, minified in production builds). Optional: a CPU profile of the window (CDP),
 * aggregated by function self time.
 */
import type { CDPSession, Page, Request } from "@playwright/test";

/** In-page part: long tasks, long animation frames, React commits. Installed with `page.addInitScript`. */
export function installPageProbe(): void {
  type Fiber = {
    tag: number;
    type: unknown;
    elementType: unknown;
    flags: number;
    child: Fiber | null;
    sibling: Fiber | null;
    alternate: Fiber | null;
    actualDuration?: number;
    selfBaseDuration?: number;
  };
  const w = window as unknown as Record<string, unknown>;
  const state = {
    longtasks: [] as { start: number; duration: number }[],
    loaf: [] as { start: number; duration: number; blocking: number; scripts: { fn: string; src: string; ms: number }[] }[],
    commits: [] as { at: number; rendered: number; selfMs: number; names: Record<string, number> }[],
  };
  w.__perfProbe = state;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) state.longtasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {
    /* not supported */
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { startTime: number; duration: number; blockingDuration: number; scripts: { sourceFunctionName: string; sourceURL: string; invoker: string; duration: number }[] }[]) {
        state.loaf.push({
          start: e.startTime,
          duration: e.duration,
          blocking: e.blockingDuration,
          scripts: (e.scripts ?? []).map((s) => ({ fn: s.sourceFunctionName || s.invoker, src: (s.sourceURL || "").replace(/^.*\//, "").replace(/\?.*$/, ""), ms: s.duration })),
        });
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch {
    /* not supported */
  }
  const nameOf = (f: Fiber): string => {
    const t = (f.elementType ?? f.type) as { displayName?: string; name?: string; type?: { displayName?: string; name?: string }; render?: { displayName?: string; name?: string } } | null;
    if (!t) return "?";
    return t.displayName || t.name || t.type?.displayName || t.type?.name || t.render?.displayName || t.render?.name || "anonymous";
  };
  const COMPONENT = new Set([0, 1, 11, 14, 15]);
  const PERFORMED_WORK = 1;
  const renderers = new Map<number, unknown>();
  let lastRoot: { current: Fiber } | null = null;
  /** Mounted instances per component name (the whole committed tree). */
  (state as unknown as { instances: () => Record<string, number> }).instances = () => {
    const out: Record<string, number> = {};
    const stack: Fiber[] = lastRoot?.current.child ? [lastRoot.current.child] : [];
    while (stack.length) {
      for (let f: Fiber | null = stack.pop()!; f; f = f.sibling) {
        if (COMPONENT.has(f.tag)) {
          const n = nameOf(f);
          out[n] = (out[n] ?? 0) + 1;
        }
        if (f.child) stack.push(f.child);
      }
    }
    return out;
  };
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers,
    inject(r: unknown) {
      const id = renderers.size + 1;
      renderers.set(id, r);
      return id;
    },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      lastRoot = root;
      const out = { at: performance.now(), rendered: 0, selfMs: 0, names: {} as Record<string, number> };
      // DevTools' heuristic: a subtree whose child pointer did not change was not rendered in this commit.
      const stack: [Fiber, boolean][] = [];
      if (root.current.child) stack.push([root.current.child, !root.current.alternate]);
      while (stack.length) {
        const [first, mounting] = stack.pop()!;
        for (let f: Fiber | null = first; f; f = f.sibling) {
          const prev = f.alternate;
          const mount = mounting || !prev;
          if (COMPONENT.has(f.tag) && (mount || (f.flags & PERFORMED_WORK) === PERFORMED_WORK)) {
            out.rendered++;
            out.selfMs += f.selfBaseDuration ?? 0;
            const n = nameOf(f);
            out.names[n] = (out.names[n] ?? 0) + 1;
          }
          if (f.child && (mount || f.child !== prev!.child)) stack.push([f.child, mount]);
        }
      }
      state.commits.push(out);
    },
  };
}

export interface RequestRecord {
  method: string;
  path: string;
  status: number;
  bytes: number;
  ms: number;
  /** Start, milliseconds after the window began. */
  at: number;
}

export interface WindowResult {
  name: string;
  /** Time until the visible result (the action's own wait), milliseconds. */
  visibleMs: number;
  requests: RequestRecord[];
  wsEvents: Record<string, number>;
  longTasks: { count: number; totalMs: number; maxMs: number };
  loaf: { count: number; blockingMs: number; topScripts: { fn: string; src: string; ms: number }[] };
  commits: { count: number; rendered: number; selfMs: number; top: [string, number][] };
  cpu?: [string, number][];
}

/** Replaces ids (ULIDs, numbers, uuids) in an API path so that requests of one route group. */
export function normalisePath(url: string): string {
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + (u.search ? "?" + [...u.searchParams.keys()].join("&") : "");
  } catch {
    path = url;
  }
  return path
    .replace(/^\/api\/v1/, "")
    .replace(/[0-9A-HJKMNP-TV-Z]{26}/g, ":id")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":uuid")
    .replace(/\/\d+(?=\/|$)/g, "/:n");
}

/** Static assets of the dev server or the bundle: not counted. */
const STATIC = /\/(src|node_modules|@vite|@fs|@id|@react-refresh|assets|mediapipe)\/|\.(js|mjs|ts|tsx|css|wasm|woff2?|png|svg|ico|json\?import)(\?|$)/;

export class PerfRecorder {
  private requests: (RequestRecord & { req: Request; start: number })[] = [];
  private ws: { at: number; type: string; socket: number }[] = [];
  /** WebSocket connections the page opened to the API (url, open time). */
  readonly sockets: { url: string; at: number; closedAt?: number }[] = [];
  private cdp: CDPSession | null = null;

  constructor(private readonly page: Page) {
    page.on("request", (req) => {
      const url = req.url();
      if (STATIC.test(new URL(url).pathname) || url.startsWith("data:")) return;
      this.requests.push({ req, start: Date.now(), method: req.method(), path: normalisePath(url), status: 0, bytes: 0, ms: 0, at: 0 });
    });
    const done = async (req: Request) => {
      const r = this.requests.find((x) => x.req === req);
      if (!r) return;
      r.ms = Date.now() - r.start;
      const resp = await req.response().catch(() => null);
      r.status = resp?.status() ?? -1;
      const sizes = await req.sizes().catch(() => null);
      r.bytes = sizes ? sizes.responseBodySize + sizes.responseHeadersSize : 0;
    };
    page.on("requestfinished", (req) => void done(req));
    page.on("requestfailed", (req) => void done(req));
    page.on("websocket", (socket) => {
      if (!socket.url().includes("/api/v1/")) return;
      const n = this.sockets.push({ url: normalisePath(socket.url()), at: Date.now() }) - 1;
      socket.on("close", () => (this.sockets[n]!.closedAt = Date.now()));
      socket.on("framereceived", (f) => {
        try {
          const frame = JSON.parse(typeof f.payload === "string" ? f.payload : f.payload.toString()) as { op?: string; type?: string };
          this.ws.push({ at: Date.now(), type: frame.op === "event" ? String(frame.type) : `op:${frame.op}`, socket: n });
        } catch {
          /* binary */
        }
      });
    });
  }

  /** Runs `action` (which waits for its visible result), then waits `settleMs` for follow-up work, and reports the window. */
  async measure(name: string, action: () => Promise<void>, opts: { settleMs?: number; cpu?: boolean } = {}): Promise<WindowResult> {
    const settle = opts.settleMs ?? 2000;
    const pageStart = await this.page.evaluate(() => performance.now());
    if (opts.cpu) await this.startCpu();
    const t0 = Date.now();
    await action();
    const visibleMs = Date.now() - t0;
    await this.page.waitForTimeout(settle);
    const t1 = Date.now();
    const cpu = opts.cpu ? await this.stopCpu() : undefined;
    // Let pending response sizes resolve.
    await this.page.waitForTimeout(50);
    const probe = await this.page.evaluate((from) => {
      const s = (window as unknown as { __perfProbe: { longtasks: { start: number; duration: number }[]; loaf: { start: number; duration: number; blocking: number; scripts: { fn: string; src: string; ms: number }[] }[]; commits: { at: number; rendered: number; selfMs: number; names: Record<string, number> }[] } }).__perfProbe;
      return { longtasks: s.longtasks.filter((x) => x.start >= from), loaf: s.loaf.filter((x) => x.start >= from), commits: s.commits.filter((x) => x.at >= from) };
    }, pageStart);
    const requests = this.requests.filter((r) => r.start >= t0 && r.start <= t1).map(({ req: _req, start, ...r }) => ({ ...r, at: start - t0 }));
    const wsEvents: Record<string, number> = {};
    for (const e of this.ws) if (e.at >= t0 && e.at <= t1 && e.type !== "op:ping") wsEvents[`${e.type}#${e.socket}`] = (wsEvents[`${e.type}#${e.socket}`] ?? 0) + 1;
    const names: Record<string, number> = {};
    for (const c of probe.commits) for (const [n, k] of Object.entries(c.names)) names[n] = (names[n] ?? 0) + k;
    const scripts = new Map<string, { fn: string; src: string; ms: number }>();
    for (const f of probe.loaf)
      for (const s of f.scripts) {
        const key = `${s.fn}@${s.src}`;
        const cur = scripts.get(key) ?? { fn: s.fn, src: s.src, ms: 0 };
        cur.ms += s.ms;
        scripts.set(key, cur);
      }
    return {
      name,
      visibleMs,
      requests,
      wsEvents,
      longTasks: { count: probe.longtasks.length, totalMs: Math.round(probe.longtasks.reduce((a, x) => a + x.duration, 0)), maxMs: Math.round(Math.max(0, ...probe.longtasks.map((x) => x.duration))) },
      loaf: { count: probe.loaf.length, blockingMs: Math.round(probe.loaf.reduce((a, x) => a + x.blocking, 0)), topScripts: [...scripts.values()].sort((a, b) => b.ms - a.ms).slice(0, 8).map((s) => ({ ...s, ms: Math.round(s.ms) })) },
      commits: { count: probe.commits.length, rendered: probe.commits.reduce((a, c) => a + c.rendered, 0), selfMs: Math.round(probe.commits.reduce((a, c) => a + c.selfMs, 0)), top: Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 40) },
      cpu,
    };
  }

  private async startCpu() {
    this.cdp ??= await this.page.context().newCDPSession(this.page);
    await this.cdp.send("Profiler.enable");
    await this.cdp.send("Profiler.setSamplingInterval", { interval: 250 });
    await this.cdp.send("Profiler.start");
  }

  /** Self time per function (name and file:line), top 25, milliseconds. */
  private async stopCpu(): Promise<[string, number][]> {
    const { profile } = (await this.cdp!.send("Profiler.stop")) as unknown as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[]; timeDeltas: number[] } };
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const self = new Map<string, number>();
    profile.samples.forEach((id, i) => {
      const n = byId.get(id)!;
      const f = n.callFrame;
      const file = f.url.replace(/^.*\//, "").replace(/\?.*$/, "");
      const key = `${f.functionName || "(anon)"} ${file}:${f.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
    });
    return [...self.entries()]
      .filter(([k]) => !k.startsWith("(idle)") && !k.startsWith("(program)"))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([k, v]) => [k, Math.round(v * 10) / 10]);
  }
}

/** One line per window: visible time, request count and bytes, `GET /rooms/:id` count, WS events, long tasks, commits. */
export function summarise(r: WindowResult): string {
  const bytes = r.requests.reduce((a, x) => a + x.bytes, 0);
  const roomGets = r.requests.filter((x) => x.method === "GET" && x.path === "/rooms/:id").length;
  const ws = Object.values(r.wsEvents).reduce((a, x) => a + x, 0);
  return `${r.name.padEnd(34)} visible ${String(r.visibleMs).padStart(5)} ms | req ${String(r.requests.length).padStart(3)} (${(bytes / 1024).toFixed(1)} KiB, GET room ${roomGets}) | ws ${ws} | longtasks ${r.longTasks.count}/${r.longTasks.totalMs} ms (max ${r.longTasks.maxMs}) | loaf blocking ${r.loaf.blockingMs} ms | commits ${r.commits.count}, rendered ${r.commits.rendered} (${r.commits.selfMs} ms)`;
}
