// SPDX-License-Identifier: Apache-2.0
/**
 * Links into tavrn (PROTOCOL.md §7h): the canonical, portable https form of rooms, channels, messages, files of a
 * files channel, invites and profiles, on the web origin of the node that HOSTS the target, so the same link works
 * for members of every node and in a plain browser:
 *
 * - `https://<web>/rooms/<room>`, `…/rooms/<room>/channels/<channel>`, `…/channels/<channel>?message=<id>`,
 *   `…/channels/<channel>/files/<file>`;
 * - `https://<web>/invite/<code>`, `https://<web>/u/<address>`.
 *
 * `<web>` is the node's `web` origin from its discovery document (by default `https://<domain>`; under delegation
 * another host). Parsing is pure and strict: a link is recognised only on a node the client already talks to (the
 * home node and nodes with a federated session, by their web origin, or by their identity domain over https without
 * a port), never with credentials in the URL, with exact path shapes (ULIDs, invite codes, addresses) and no other
 * query or fragment. Anything else stays a plain external link: the client never contacts an unknown host for a link.
 */
import { useMemo } from "react";
import { isNodeDomain, parseAddress } from "@tavrn/sdk";
import { homeWeb, useAuth } from "../stores/auth";
import { isHome, useNodes } from "../stores/nodes";
import { webOrigin } from "../platform";

export type TavrnLink =
  | { kind: "room"; node: string; room: string }
  | { kind: "channel"; node: string; room: string; channel: string }
  | { kind: "message"; node: string; room: string; channel: string; message: string }
  | { kind: "file"; node: string; room: string; channel: string; file: string }
  | { kind: "invite"; node: string; code: string }
  | { kind: "user"; node: string; address: string };

export type TavrnLinkKind = TavrnLink["kind"];

/** A node the client talks to: its identity domain and, when known, the origin of its web client. */
export interface KnownNode {
  domain: string;
  web?: string | null;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CODE = /^[A-Za-z0-9_-]{4,64}$/;
/** Longer inputs are no links of ours (a URL of the forms above is far shorter). */
const MAX_URL = 512;

function origin(web: string): string | null {
  try {
    const u = new URL(web);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** The web origin for links of `domain` when only the domain is known. */
const defaultWeb = (domain: string) => `https://${domain}`;

/** The canonical URL of `link` on the node's web origin `web` (`https://node.example`, no trailing slash needed). */
export function tavrnUrl(web: string, link: TavrnLink): string {
  const base = (origin(web) ?? defaultWeb(link.node)).replace(/\/$/, "");
  switch (link.kind) {
    case "room":
      return `${base}/rooms/${link.room}`;
    case "channel":
      return `${base}/rooms/${link.room}/channels/${link.channel}`;
    case "message":
      return `${base}/rooms/${link.room}/channels/${link.channel}?message=${link.message}`;
    case "file":
      return `${base}/rooms/${link.room}/channels/${link.channel}/files/${link.file}`;
    case "invite":
      return `${base}/invite/${encodeURIComponent(link.code)}`;
    case "user":
      return `${base}/u/${link.address}`;
  }
}

/** The node owning `url`: a known web origin (exactly), or a known identity domain over https without a port. */
function nodeOf(url: URL, known: readonly KnownNode[]): string | null {
  for (const k of known) if (k.web && origin(k.web) === url.origin) return k.domain;
  if (url.protocol !== "https:" || url.port) return null;
  const host = url.hostname;
  return known.find((k) => k.domain === host)?.domain ?? null;
}

function segmentsOf(pathname: string): string[] | null {
  const parts = pathname.split("/");
  // A leading slash always; one trailing slash is tolerated, empty segments elsewhere are not.
  if (parts[0] !== "") return null;
  parts.shift();
  if (parts.length > 1 && parts.at(-1) === "") parts.pop();
  return parts.some((p) => p === "") ? null : parts;
}

/**
 * The tavrn target of `href`, or null when it is none of the forms above or its host is not a known node. Pure: the
 * caller passes the known nodes (see {@link useKnownNodes}).
 */
export function parseTavrnLink(href: string, known: readonly KnownNode[]): TavrnLink | null {
  if (typeof href !== "string" || href.length > MAX_URL || /[\s\\]/.test(href)) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.hash) return null;
  let node = nodeOf(url, known);
  if (!node) return null;
  let parts = segmentsOf(url.pathname);
  if (!parts) return null;
  // The client's own route of another node's room (`/n/<domain>/rooms/…`): only for a node the client knows too.
  if (parts[0] === "n") {
    const domain = (parts[1] ?? "").toLowerCase();
    if (!isNodeDomain(domain) || !known.some((k) => k.domain === domain) || parts[2] !== "rooms") return null;
    node = domain;
    parts = parts.slice(2);
  }
  const params = [...url.searchParams];
  const [first, a, second, b, third, c] = parts;
  if (first === "invite" && parts.length === 2 && !params.length) {
    let code: string;
    try {
      code = decodeURIComponent(a!);
    } catch {
      return null;
    }
    return CODE.test(code) ? { kind: "invite", node, code } : null;
  }
  if (first === "u" && parts.length === 2 && !params.length) {
    let raw: string;
    try {
      raw = decodeURIComponent(a!);
    } catch {
      return null;
    }
    const address = parseAddress(raw);
    // Exactly the address (no white space or case games around it).
    return address && `${address.username}@${address.domain}` === raw ? { kind: "user", node, address: raw } : null;
  }
  if (first !== "rooms" || !ULID.test(a ?? "")) return null;
  const room = a!;
  if (parts.length === 2) return params.length ? null : { kind: "room", node, room };
  if (second !== "channels" || !ULID.test(b ?? "")) return null;
  const channel = b!;
  if (parts.length === 4) {
    if (!params.length) return { kind: "channel", node, room, channel };
    const [only] = params;
    if (params.length === 1 && only![0] === "message" && ULID.test(only![1])) return { kind: "message", node, room, channel, message: only![1] };
    return null;
  }
  if (parts.length === 6 && third === "files" && ULID.test(c ?? "") && !params.length) return { kind: "file", node, room, channel, file: c! };
  return null;
}

/**
 * The client's route of a target: the classic routes for the home node, `/n/<domain>/…` for another node (the same
 * shapes as `roomPath`); a message opens its channel at the message (`?m=`), an invite the invite page.
 */
export function tavrnLinkPath(link: TavrnLink, home: (domain: string) => boolean): string {
  const local = home(link.node);
  const roomBase = "room" in link ? (local ? `/rooms/${link.room}` : `/n/${link.node}/rooms/${link.room}`) : "";
  switch (link.kind) {
    case "room":
      return roomBase;
    case "channel":
      return `${roomBase}/channels/${link.channel}`;
    case "message":
      return `${roomBase}/channels/${link.channel}?m=${link.message}`;
    case "file":
      return `${roomBase}/channels/${link.channel}/files/${link.file}`;
    case "invite":
      return local ? `/invite/${encodeURIComponent(link.code)}` : `/invite/${encodeURIComponent(link.code)}?node=${encodeURIComponent(link.node)}`;
    case "user":
      return local ? `/u/${link.address}` : `/u/${link.address}?via=${encodeURIComponent(link.node)}`;
  }
}

// ---------------------------------------------------------------- the client's nodes

/** The web origin of `domain`'s client: the home node's, a federated session's, else `https://<domain>`. */
export function webOf(domain: string): string {
  if (isHome(domain)) return homeWeb();
  return useNodes.getState().sessions[domain]?.web ?? defaultWeb(domain);
}

/** The canonical link of a channel hosted on `domain` (the composer's `#channel` uses it too). */
export function channelUrl(domain: string, roomId: string, channelId: string): string {
  return tavrnUrl(webOf(domain), { kind: "channel", node: domain, room: roomId, channel: channelId });
}

export function roomUrl(domain: string, roomId: string): string {
  return tavrnUrl(webOf(domain), { kind: "room", node: domain, room: roomId });
}

export function messageUrl(domain: string, roomId: string, channelId: string, messageId: string): string {
  return tavrnUrl(webOf(domain), { kind: "message", node: domain, room: roomId, channel: channelId, message: messageId });
}

export function fileUrl(domain: string, roomId: string, channelId: string, fileId: string): string {
  return tavrnUrl(webOf(domain), { kind: "file", node: domain, room: roomId, channel: channelId, file: fileId });
}

/** The nodes this client talks to (home node with its web origins, federated sessions); `key` changes with them. */
export function knownNodes(): { nodes: KnownNode[]; key: string } {
  const auth = useAuth.getState();
  return buildKnown(auth.user?.domain ?? null, !!auth.home, useNodes.getState().sessions);
}

function buildKnown(home: string | null, remoteHome: boolean, sessions: Record<string, { domain: string; web?: string | null }>): { nodes: KnownNode[]; key: string } {
  const nodes: KnownNode[] = [];
  if (home) {
    nodes.push({ domain: home, web: homeWeb() });
    // The page's own origin is the home node's web client, unless the account lives on another node.
    if (!remoteHome) nodes.push({ domain: home, web: webOrigin() });
    if (!remoteHome && typeof location !== "undefined") nodes.push({ domain: home, web: location.origin });
  }
  for (const s of Object.values(sessions)) if (s.domain !== home) nodes.push({ domain: s.domain, web: s.web ?? null });
  const key = nodes.map((n) => `${n.domain}=${n.web ?? ""}`).join(" ");
  return { nodes, key };
}

/** {@link knownNodes} for views: changes when the account or the federated sessions change. */
export function useKnownNodes(): { nodes: KnownNode[]; key: string } {
  const home = useAuth((s) => s.user?.domain ?? null);
  const remoteHome = useAuth((s) => !!s.home);
  const homeWebOrigin = useAuth((s) => s.home?.web ?? null);
  const sessions = useNodes((s) => s.sessions);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => buildKnown(home, remoteHome, sessions), [home, remoteHome, homeWebOrigin, sessions]);
}

/** Whether `url` is a recognised tavrn link (the sender's client does not unfurl these: the chip shows them). */
export function isTavrnLink(url: string): boolean {
  return !!parseTavrnLink(url, knownNodes().nodes);
}
