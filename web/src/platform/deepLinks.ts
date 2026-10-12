// SPDX-License-Identifier: Apache-2.0
/**
 * Deep links into the apps (docs/DESKTOP.md "Links into the app", docs/ANDROID.md "Links into the app"): the
 * `tavrn://` links the shells hand the client (checked there first: the Tauri shell's `deeplink.rs`, the Electron
 * shell's `deeplink.ts`) and, in the Android app, the App Links of the project's node (`https://app.tavrn.org/invite/…`,
 * `/add/…`). The client checks them again here and never acts on one by itself: `DeepLinkPrompt` shows the target and
 * the user decides. Platform-independent (tests pass the identity lookup).
 *
 * - `tavrn://invite/<node>/<code>`: the invite page (`/invite/<code>`, `?node=<identity domain>` for another node);
 * - `tavrn://room/<node>/<room>[/<channel>]`: the room (`/rooms/…`, `/n/<domain>/rooms/…` for another node);
 * - `tavrn://add/<node>/<id>`, `tavrn://add/<node>/<domain>/<id>` (`?room=`): an application's add link;
 * - `tavrn://connect?session=<id>&state=<state>`: the browser's "back to the app" after the sign-in on the node's
 *   page; it navigates nowhere and only wakes the pending sign-in when session and state are its own
 *   (`appSession.ts`).
 */
import { identityOfHost } from "@tavrn/sdk";

export type DeepLinkTarget =
  | { kind: "invite"; node: string; code: string }
  | { kind: "room"; node: string; room: string; channel: string | null }
  | { kind: "add"; node: string; domain: string | null; id: string; room: string | null }
  | { kind: "connect"; session: string; state: string };

const MAX_LINK = 512;
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
const CODE = /^[A-Za-z0-9_-]{4,64}$/;
const SESSION = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** A node's host in a link: a domain name with a dot, not an address (`deeplink.rs`, `resolve::valid_domain`). */
export function nodeHost(s: string | undefined): string | null {
  const d = (s ?? "").toLowerCase();
  if (!d || d.length > 253 || !d.includes(".")) return null;
  const labels = d.split(".");
  if (!labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels.at(-1) ?? "")) return null;
  return d;
}

function roomParam(v: string | null): string | null | false {
  if (v === null) return null;
  return v && v.length <= 200 && !/[\s\p{Cc}]/u.test(v) ? v : false;
}

/** The target of a link, or null when it is none of the forms above. */
export function parseDeepLink(link: string): DeepLinkTarget | null {
  if (typeof link !== "string" || link.length > MAX_LINK || /[#\\\s]/.test(link)) return null;
  // `tavrn://` is read like `https://` (hosts and paths alike in every engine; older webviews treat the host of an
  // unknown scheme as part of the path).
  const scheme = /^tavrn:\/\//i.test(link);
  let u: URL;
  try {
    u = new URL(scheme ? `https://${link.slice("tavrn://".length)}` : link);
  } catch {
    return null;
  }
  if (u.port || u.username || u.password) return null;
  const params = [...u.searchParams];
  if (!scheme && u.protocol === "https:") {
    // An App Link of the Android app: `https://<node>/invite/<code>` or `/add/[<domain>/]<id>[?room=]`.
    const node = nodeHost(u.hostname);
    const [kind, ...rest] = u.pathname.split("/").filter(Boolean);
    if (!node) return null;
    if (kind === "invite" && rest.length === 1 && params.length === 0 && CODE.test(rest[0] ?? "")) return { kind: "invite", node, code: rest[0] ?? "" };
    if (kind === "add") return addTarget(node, rest, params);
    return null;
  }
  if (!scheme) return null;
  const kind = u.hostname.toLowerCase();
  const segments = u.pathname.split("/").filter((s, i, all) => !(s === "" && (i === 0 || i === all.length - 1)));
  if (segments.some((s) => s === "")) return null;
  if (kind === "invite" && segments.length === 2 && params.length === 0) {
    const node = nodeHost(segments[0]);
    const code = segments[1] ?? "";
    return node && CODE.test(code) ? { kind: "invite", node, code } : null;
  }
  if (kind === "room" && (segments.length === 2 || segments.length === 3) && params.length === 0) {
    const node = nodeHost(segments[0]);
    const [room = "", channel] = segments.slice(1);
    if (!node || !TOKEN.test(room) || (channel !== undefined && !TOKEN.test(channel))) return null;
    return { kind: "room", node, room, channel: channel ?? null };
  }
  if (kind === "add" && segments.length >= 2) {
    const node = nodeHost(segments[0]);
    return node ? addTarget(node, segments.slice(1), params) : null;
  }
  if (kind === "connect" && segments.length === 0) {
    let session: string | null = null;
    let state: string | null = null;
    for (const [k, v] of params) {
      if (k === "session" && session === null && SESSION.test(v)) session = v;
      else if (k === "state" && state === null && STATE.test(v)) state = v;
      else return null;
    }
    return session && state ? { kind: "connect", session, state } : null;
  }
  return null;
}

function addTarget(node: string, rest: string[], params: [string, string][]): DeepLinkTarget | null {
  if (rest.length < 1 || rest.length > 2) return null;
  const domain = rest.length === 2 ? nodeHost(rest[0]) : null;
  const id = rest.at(-1) ?? "";
  if ((rest.length === 2 && !domain) || !TOKEN.test(id)) return null;
  if (params.length > 1 || (params.length === 1 && params[0]?.[0] !== "room")) return null;
  const room = roomParam(params[0]?.[1] ?? null);
  if (room === false) return null;
  return { kind: "add", node, domain, id, room };
}

/** The home node the routes are relative to: its web origin and identity domain. */
export interface HomeNode {
  web: string;
  domain: string | null;
}

/**
 * The identity domain of a link's node, and whether it is the home node: the home node's own web host, or a host whose
 * identity domain is the home node's (delegation: `app.tavrn.org` belongs to `tavrn.org`). Unknown (offline): the
 * host itself.
 */
async function nodeOf(host: string, home: HomeNode, identity: (host: string) => Promise<string | null>): Promise<{ domain: string; local: boolean }> {
  let own = false;
  try {
    own = new URL(home.web).hostname.toLowerCase() === host;
  } catch {
    own = false;
  }
  if (own) return { domain: home.domain ?? host, local: true };
  if (home.domain && host === home.domain) return { domain: host, local: true };
  const domain = (await identity(host).catch(() => null)) ?? host;
  return { domain, local: !!home.domain && domain === home.domain };
}

/** The client's route for a target (null for `connect`, which navigates nowhere). */
export async function deepLinkRoute(target: DeepLinkTarget, home: HomeNode, identity: (host: string) => Promise<string | null> = (h) => identityOfHost(h)): Promise<string | null> {
  if (target.kind === "connect") return null;
  const { domain, local } = await nodeOf(target.node, home, identity);
  if (target.kind === "invite") return local ? `/invite/${target.code}` : `/invite/${target.code}?node=${encodeURIComponent(domain)}`;
  if (target.kind === "room") {
    const base = local ? `/rooms/${target.room}` : `/n/${domain}/rooms/${target.room}`;
    return target.channel ? `${base}/channels/${target.channel}` : base;
  }
  const query = target.room ? `?room=${encodeURIComponent(target.room)}` : "";
  if (target.domain) return `/add/${target.domain}/${target.id}${query}`;
  return local ? `/add/${target.id}${query}` : `/add/${domain}/${target.id}${query}`;
}

/** The link that waits for the node picker (an app without a home node yet), for one session of the window. */
const PENDING_KEY = "tavrn.deeplink.pending";

export function keepPendingLink(link: string, storage: Pick<Storage, "setItem"> | null = safeSession()): void {
  try {
    storage?.setItem(PENDING_KEY, link);
  } catch {
    /* storage unavailable: the link is gone, the user can open it again */
  }
}

export function takePendingLink(storage: Pick<Storage, "getItem" | "removeItem"> | null = safeSession()): string | null {
  try {
    const link = storage?.getItem(PENDING_KEY) ?? null;
    storage?.removeItem(PENDING_KEY);
    return link;
  } catch {
    return null;
  }
}

function safeSession(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}
