// SPDX-License-Identifier: Apache-2.0
/**
 * Deep links into the app (docs/DESKTOP.md "Links into the app"), the rules of the Tauri shell's `deeplink.rs`: the
 * scheme `tavrn://`, registered by the packages (`protocols` in electron-builder.config.mjs: the `.desktop` entry's
 * `x-scheme-handler/tavrn`, the Windows installer's registry) and at start (`app.setAsDefaultProtocolClient`). A start
 * with a link, or a second start with one (`second-instance`), hands it here; only a checked link reaches the client,
 * which shows its target and acts only when the user confirms.
 *
 * - `tavrn://invite/<node>/<code>`, `tavrn://room/<node>/<room>[/<channel>]`, `tavrn://add/<node>/<id>`,
 *   `tavrn://add/<node>/<domain>/<id>` (optional `?room=`), `tavrn://connect?session=<id>&state=<state>`;
 * - `<node>` a domain name with a dot (no port, no address, no `localhost`), codes and ids base64url tokens of at most
 *   64 characters, no fragment, no other parameter, at most 512 bytes.
 */
import { validDomain } from "./node_url.ts";

export const SCHEME = "tavrn";
const MAX_LINK = 512;
const MAX_ROOM_PARAM = 200;
/** Links kept until the client takes them (a burst of starts cannot grow the queue). */
export const MAX_PENDING = 8;

const token = (s: string, min: number) => s.length >= min && s.length <= 64 && /^[A-Za-z0-9_-]+$/.test(s);
const sessionId = (s: string) => /^[A-Za-z0-9_-]{43}$/.test(s);
const stateOk = (s: string) => s.length >= 16 && s.length <= 128 && /^[A-Za-z0-9_-]+$/.test(s);

/** A `tavrn://` link in the one written form the client receives (lower-case hosts, no trailing slash), or null. */
export function deepLink(input: string): string | null {
  if (typeof input !== "string" || input.length > MAX_LINK) return null;
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEME}:` || u.port || u.username || u.password || input.includes("#")) return null;
  const kind = u.hostname.toLowerCase();
  let path = u.pathname.startsWith("/") ? u.pathname.slice(1) : u.pathname;
  if (path.endsWith("/")) path = path.slice(0, -1);
  const segments = path ? path.split("/") : [];
  const query = [...u.searchParams];
  const node = (s: string | undefined) => {
    const d = (s ?? "").toLowerCase();
    return validDomain(d) ? d : null;
  };
  if (kind === "invite" && segments.length === 2 && query.length === 0) {
    const n = node(segments[0]);
    const code = segments[1] ?? "";
    return n && token(code, 4) ? `${SCHEME}://invite/${n}/${code}` : null;
  }
  if (kind === "room" && (segments.length === 2 || segments.length === 3) && query.length === 0) {
    const n = node(segments[0]);
    const ids = segments.slice(1);
    return n && ids.every((id) => token(id, 1)) ? `${SCHEME}://room/${n}/${ids.join("/")}` : null;
  }
  if (kind === "add" && (segments.length === 2 || segments.length === 3)) {
    const n = node(segments[0]);
    const domain = segments.length === 3 ? node(segments[1]) : null;
    const id = segments.at(-1) ?? "";
    if (!n || (segments.length === 3 && !domain) || !token(id, 1)) return null;
    let room: string | null = null;
    if (query.length === 1) {
      const [k, v] = query[0] ?? ["", ""];
      if (k !== "room" || !v || v.length > MAX_ROOM_PARAM || /[\s\p{Cc}]/u.test(v)) return null;
      room = v;
    } else if (query.length > 1) return null;
    const out = new URL(`${SCHEME}://add/${n}/${domain ? `${domain}/` : ""}${id}`);
    if (room) out.searchParams.set("room", room);
    return out.href;
  }
  if (kind === "connect" && segments.length === 0) {
    let session: string | null = null;
    let state: string | null = null;
    for (const [k, v] of query) {
      if (k === "session" && session === null && sessionId(v)) session = v;
      else if (k === "state" && state === null && stateOk(v)) state = v;
      else return null;
    }
    return session && state ? `${SCHEME}://connect?session=${session}&state=${state}` : null;
  }
  return null;
}

/** The deep links among a start's arguments (at most four). */
export function linksFromArgs(argv: readonly string[]): string[] {
  return argv
    .filter((a) => typeof a === "string" && a.startsWith(`${SCHEME}:`))
    .map(deepLink)
    .filter((l): l is string => !!l)
    .slice(0, 4);
}

/**
 * The links the client has not taken yet. The shell tells the client with the event `{ kind: "link" }` and the client
 * takes them (`shell.takeLinks`), so a link that arrives before the client listens is not lost.
 */
export class PendingLinks {
  #links: string[] = [];

  /** Keeps the checked links of `argv`; true when one was new. */
  add(argv: readonly string[]): boolean {
    const links = linksFromArgs(argv);
    for (const link of links) if (this.#links.length < MAX_PENDING) this.#links.push(link);
    return links.length > 0;
  }

  take(): string[] {
    const links = this.#links;
    this.#links = [];
    return links;
  }
}
