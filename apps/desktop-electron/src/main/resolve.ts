// SPDX-License-Identifier: Apache-2.0
/**
 * Address first (docs/DESKTOP.md "The node picker"): the node of an identity domain (`alice@home.example` →
 * `home.example`), found as FEDERATION.md §1.4 says, with the rules and errors of the Tauri shell's `resolve.rs`:
 *
 * 1. `https://<domain>/.well-known/tavrn`, validated: `tavrn` = 1, `domain` equal to the requested one, the endpoints
 *    https/wss without credentials, query or fragment, `api` ending in `/api/v1`. Delegation (endpoints on another
 *    host) is the normal case; the result keeps the identity domain and the endpoints.
 * 2. After a `404` or without an HTTPS server (refused, DNS, TLS, timeout): the `_tavrn._tcp.<domain>` SRV records
 *    (lowest priority first, then highest weight, at most 3, domain names only). The request goes to the target's host
 *    and port but is made for the identity domain: SNI and `Host` name the domain and the target's certificate must be
 *    valid for the domain (FEDERATION.md §1.4), so a forged DNS answer alone cannot hand the app another node. The
 *    target's document must name `domain`.
 * 3. After a `404` only: `https://<domain>/api/v1`, the last attempt (it must answer `GET /node`).
 *
 * Any other status, an invalid document or a refused redirect is an error at its step. A development node on this
 * computer (`localhost:<port>`, `127.0.0.1:<port>`) is asked over plain http, without SRV.
 */
import { resolveSrv } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { getCACertificates, rootCertificates } from "node:tls";
import { DEV_HOSTS, validDomain } from "./node_url.ts";

/** SRV targets tried at most. */
export const MAX_SRV_TARGETS = 3;
/** Cap of a discovery document (FEDERATION.md §1.3 rule 5). */
export const MAX_DOCUMENT = 64 * 1024;
/** Redirects followed at most (to https on the same host). */
export const MAX_REDIRECTS = 3;
/** Until the answer's headers, and in total. */
export const HEADERS_TIMEOUT_MS = 5_000;
export const TOTAL_TIMEOUT_MS = 10_000;

export type Source = "well_known" | "srv" | "domain";
export type Step = "input" | "well_known" | "srv" | "direct";

export interface Resolved {
  domain: string;
  api: string;
  ws: string;
  web: string;
  source: Source;
}

/** Why no node was found (`resolve.*`): rejected as a plain object, as the Tauri command does. */
export interface Failure {
  code: "resolve.not_found" | "resolve.invalid" | "resolve.unreachable" | "resolve.domain_invalid";
  step: Step;
  domain: string;
}

export interface Fetched {
  status: number;
  body: Uint8Array;
}

/** `transport`: no HTTP answer (DNS, refused, TLS, timeout); `refused`: an answer that is not usable (redirect, size). */
export class FetchError extends Error {
  readonly kind: "transport" | "refused";
  constructor(kind: "transport" | "refused") {
    super(kind);
    this.kind = kind;
  }
}

export interface Fetcher {
  get(url: string): Promise<Fetched>;
  /**
   * GET `url` (on the identity domain) over a connection to `connect` instead of the URL's host: SNI and `Host` are the
   * URL's host and the certificate must be valid for it. No redirects.
   */
  getVia(url: string, connect: { host: string; port: number }): Promise<Fetched>;
}

export interface SrvRecord {
  priority: number;
  weight: number;
  port: number;
  target: string;
}

export interface SrvLookup {
  /** The records of `name`; rejects or answers an empty list when there are none. */
  srv(name: string): Promise<SrvRecord[]>;
}

/** `localhost:<port>` or `127.0.0.1:<port>` (a port is optional): a development node on this computer. */
export function devHost(d: string): boolean {
  const i = d.indexOf(":");
  const host = i < 0 ? d : d.slice(0, i);
  const port = i < 0 ? null : d.slice(i + 1);
  if (!DEV_HOSTS.includes(host)) return false;
  if (port === null) return true;
  return /^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535;
}

function endpoint(value: unknown, secure: string, insecure: string, dev: boolean): URL | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  const scheme = url.protocol.slice(0, -1);
  const okScheme = scheme === secure || (dev && scheme === insecure && DEV_HOSTS.includes(url.hostname));
  // An empty query or fragment (`…?`, `…#`) counts as one, as in the Rust shell.
  const extra = url.search !== "" || url.hash !== "" || /[?#]/.test(value);
  return okScheme && !url.username && !url.password && !extra ? url : null;
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

/** Validates a discovery document for `domain`; `dev`: a development node on this computer. */
export function validateDocument(body: Uint8Array, domain: string, dev: boolean): Resolved | null {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const d = doc as Record<string, unknown>;
  if (d.tavrn !== 1) return null;
  if (typeof d.domain !== "string") return null;
  const named = d.domain;
  const host = domain.split(":")[0] ?? domain;
  if (!(named === domain || (dev && (named === "localhost" || named === host)))) return null;
  const api = endpoint(d.api, "https", "http", dev);
  if (!api || !trimSlash(api.pathname).endsWith("/api/v1")) return null;
  const ws = endpoint(d.ws, "wss", "ws", dev);
  if (!ws) return null;
  const web = d.web === undefined ? api : endpoint(d.web, "https", "http", dev);
  if (!web) return null;
  return { domain: named, api: trimSlash(api.href), ws: trimSlash(ws.href), web: web.origin, source: "well_known" };
}

const failure = (code: Failure["code"], step: Step, domain: string): Failure => ({ code, step, domain });

async function attempt(fetcher: Fetcher, url: string): Promise<Fetched | FetchError> {
  try {
    return await fetcher.get(url);
  } catch (e) {
    return e instanceof FetchError ? e : new FetchError("transport");
  }
}

async function attemptVia(fetcher: Fetcher, url: string, connect: { host: string; port: number }): Promise<Fetched | FetchError> {
  try {
    return await fetcher.getVia(url, connect);
  } catch (e) {
    return e instanceof FetchError ? e : new FetchError("transport");
  }
}

/** Resolves `input` (an identity domain) to its node; rejects with a {@link Failure}. */
export async function resolveNode(input: string, fetcher: Fetcher, srv: SrvLookup): Promise<Resolved> {
  const domain = input.trim().replace(/\.+$/, "").toLowerCase();
  const dev = devHost(domain);
  if (!dev && !validDomain(domain)) throw failure("resolve.domain_invalid", "input", domain);
  const scheme = dev ? "http" : "https";

  // 1. The well-known on the identity domain itself.
  const first = await attempt(fetcher, `${scheme}://${domain}/.well-known/tavrn`);
  let after404: boolean;
  if (first instanceof FetchError) {
    if (first.kind === "refused") throw failure("resolve.unreachable", "well_known", domain);
    after404 = false;
  } else if (first.status === 200) {
    const found = validateDocument(first.body, domain, dev);
    if (!found) throw failure("resolve.invalid", "well_known", domain);
    return found;
  } else if (first.status === 404) {
    after404 = true;
  } else {
    throw failure("resolve.unreachable", "well_known", domain);
  }

  // 2. SRV (not for development nodes: a stopped one fails at once).
  if (!dev) {
    const records = await srv.srv(`_tavrn._tcp.${domain}`).catch(() => [] as SrvRecord[]);
    const ordered = [...records].sort((a, b) => a.priority - b.priority || b.weight - a.weight);
    for (const record of ordered.slice(0, MAX_SRV_TARGETS)) {
      const target = record.target.replace(/\.+$/, "").toLowerCase();
      if (!validDomain(target) || record.port === 0) continue;
      // A TLS failure (a certificate only for the target) skips the record like any transport failure.
      const r = await attemptVia(fetcher, `https://${domain}/.well-known/tavrn`, { host: target, port: record.port });
      if (r instanceof FetchError || r.status !== 200) continue;
      const found = validateDocument(r.body, domain, false);
      if (!found) throw failure("resolve.invalid", "srv", domain);
      return { ...found, source: "srv" };
    }
  }
  if (!after404) throw failure("resolve.unreachable", dev ? "well_known" : "srv", domain);

  // 3. After a 404 only: the API on the domain itself.
  const api = `${scheme}://${domain}/api/v1`;
  const r = await attempt(fetcher, `${api}/node`);
  if (!(r instanceof FetchError) && r.status === 200) {
    try {
      const v: unknown = JSON.parse(new TextDecoder().decode(r.body));
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        return { domain, api, ws: `${dev ? "ws" : "wss"}://${domain}/api/v1/ws`, web: `${scheme}://${domain}`, source: "domain" };
      }
    } catch {
      // not a node
    }
  }
  throw failure("resolve.not_found", "direct", domain);
}

/** The part of `fetch` the real fetcher uses (Electron's `net.fetch` in the app: Chromium's network stack and TLS). */
export type FetchLike = (url: string, init: { method: "GET"; headers: Record<string, string>; redirect: "manual"; signal: AbortSignal }) => Promise<Response>;

/** Options of the SRV step's connection (tests: their own CA and where a target name connects). */
export interface ViaOptions {
  /** Trust anchors; default: Node's bundled Mozilla roots plus the system's store. */
  ca?: string[];
  /** The address a target name connects to; default: the name itself (the system's DNS). */
  resolveTarget?: (target: string) => string;
}

/** Node's bundled roots plus the system's certificate store (when this Node can read it). */
function defaultTrust(): string[] {
  try {
    return [...new Set([...getCACertificates("default"), ...getCACertificates("system")])];
  } catch {
    return [...rootCertificates];
  }
}

/**
 * GET with verified TLS (the fetch it is given: Chromium's network stack with the system's trust store in the app), at
 * most {@link MAX_REDIRECTS} redirects to https on the same host, 5 s until the answer's headers, 10 s in total, the
 * body capped at {@link MAX_DOCUMENT}. The SRV step ({@link HttpFetcher.getVia}) uses Node's TLS instead, because
 * Chromium's fetch cannot connect to one host while verifying the certificate for another; it trusts Node's bundled
 * Mozilla roots and the system's store.
 */
export class HttpFetcher implements Fetcher {
  readonly #fetch: FetchLike;
  readonly #userAgent: string;
  readonly #via: ViaOptions;

  constructor(fetchImpl: FetchLike, version: string, via: ViaOptions = {}) {
    this.#fetch = fetchImpl;
    this.#userAgent = `tavrn-desktop/${version}`;
    this.#via = via;
  }

  getVia(url: string, connect: { host: string; port: number }): Promise<Fetched> {
    const target = new URL(url);
    if (target.protocol !== "https:") return Promise.reject(new FetchError("refused"));
    return new Promise<Fetched>((resolve, reject) => {
      let settled = false;
      const done = (e: FetchError | null, value?: Fetched) => {
        if (settled) return;
        settled = true;
        clearTimeout(total);
        if (e) {
          req.destroy();
          reject(e);
        } else resolve(value!);
      };
      const req = httpsRequest(
        {
          host: this.#via.resolveTarget ? this.#via.resolveTarget(connect.host) : connect.host,
          port: connect.port,
          // The certificate is verified for the identity domain (SNI and the hostname check), never for the target.
          servername: target.hostname,
          path: `${target.pathname}${target.search}`,
          method: "GET",
          headers: { Host: target.host, Accept: "application/json", "User-Agent": this.#userAgent },
          ca: this.#via.ca ?? defaultTrust(),
          rejectUnauthorized: true,
          agent: false,
          timeout: HEADERS_TIMEOUT_MS,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) return done(new FetchError("refused"));
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > MAX_DOCUMENT) return done(new FetchError("refused"));
            chunks.push(chunk);
          });
          res.on("end", () => done(null, { status, body: new Uint8Array(Buffer.concat(chunks)) }));
          res.on("error", () => done(new FetchError("transport")));
        },
      );
      const total = setTimeout(() => done(new FetchError("transport")), TOTAL_TIMEOUT_MS);
      req.on("timeout", () => done(new FetchError("transport")));
      req.on("error", () => done(new FetchError("transport")));
      req.end();
    });
  }

  async get(url: string): Promise<Fetched> {
    const total = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
    const origin = new URL(url);
    let current = url;
    for (let redirects = 0; ; redirects++) {
      const headers = new AbortController();
      const timer = setTimeout(() => headers.abort(), HEADERS_TIMEOUT_MS);
      let resp: Response;
      try {
        resp = await this.#fetch(current, {
          method: "GET",
          headers: { Accept: "application/json", "User-Agent": this.#userAgent },
          redirect: "manual",
          signal: AbortSignal.any([total, headers.signal]),
        });
      } catch {
        throw new FetchError("transport");
      } finally {
        clearTimeout(timer);
      }
      if (resp.type === "opaqueredirect") throw new FetchError("refused");
      if (resp.status >= 300 && resp.status < 400) {
        await resp.body?.cancel().catch(() => undefined);
        const location = resp.headers.get("location");
        let next: URL;
        try {
          next = new URL(location ?? "", current);
        } catch {
          throw new FetchError("refused");
        }
        if (!location || redirects >= MAX_REDIRECTS || next.protocol !== "https:" || next.hostname !== origin.hostname) throw new FetchError("refused");
        current = next.href;
        continue;
      }
      return { status: resp.status, body: await readCapped(resp, total) };
    }
  }
}

async function readCapped(resp: Response, signal: AbortSignal): Promise<Uint8Array> {
  const reader = resp.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new FetchError("transport");
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DOCUMENT) {
        await reader.cancel().catch(() => undefined);
        throw new FetchError("refused");
      }
      chunks.push(value);
    }
  } catch (e) {
    throw e instanceof FetchError ? e : new FetchError("transport");
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** SRV records through the system's DNS configuration (`/etc/resolv.conf`). */
export const systemSrv: SrvLookup = {
  srv: async (name) => (await resolveSrv(name)).map((r) => ({ priority: r.priority, weight: r.weight, port: r.port, target: r.name.replace(/\.+$/, "").toLowerCase() })),
};
