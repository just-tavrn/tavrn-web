// SPDX-License-Identifier: Apache-2.0
/**
 * Add links of applications (tavrn-protocol/APPLICATIONS.md §4.1): `https://<node>/add/<id>`, the cross-node form
 * `/add/<domain>/<id>` that every web client accepts, an application reference `<domain>/<id>` or a bare id
 * (an application of the node this web client belongs to). Pasted into "Add an application" in the room
 * settings or the "+" dialog; the result is the client path of the consent screen.
 */
import { isNodeDomain } from "@tavrn/sdk";
import type { InviteContext } from "./inviteLink";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export interface AddTarget {
  /** Domain of the application's home node, or null for the node this web client belongs to. */
  domain: string | null;
  /** Application id (ULID, upper case). */
  id: string;
}

function target(domain: string | null, id: string | undefined): AddTarget | null {
  if (!id || !ULID.test(id)) return null;
  const d = domain?.toLowerCase() ?? null;
  if (d !== null && !isNodeDomain(d)) return null;
  return { domain: d, id: id.toUpperCase() };
}

/** `ownDomain`: the domain of the node this web client belongs to (its references need no domain check). */
export function parseAddInput(input: string, ctx: InviteContext & { ownDomain?: string | null }): AddTarget | null {
  const text = input.trim();
  if (!text) return null;
  if (ULID.test(text)) return target(null, text);
  const own = (domain: string) => !!ctx.ownDomain && domain.toLowerCase() === ctx.ownDomain.toLowerCase();
  // `<domain>/<id>`: an application reference.
  const ref = /^([a-z0-9.-]+)\/([0-9a-z]{26})$/i.exec(text);
  if (ref) return own(ref[1]!) ? target(null, ref[2]) : target(ref[1]!, ref[2]);
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const at = segments.lastIndexOf("add");
  if (at < 0) return null;
  const rest = segments.slice(at + 1);
  if (rest.length === 2) return own(rest[0]!) ? target(null, rest[1]) : target(rest[0]!, rest[1]);
  if (rest.length !== 1) return null;
  if (url.origin === ctx.origin) return target(null, rest[0]);
  for (const [domain, web] of Object.entries(ctx.webs)) {
    try {
      if (new URL(web).origin === url.origin) return target(domain, rest[0]);
    } catch {
      /* a session without a valid web origin */
    }
  }
  const host = url.hostname.toLowerCase();
  // Only real node domains (never IP literals or plain http elsewhere).
  if (url.protocol !== "https:" || url.port || !isNodeDomain(host)) return null;
  return target(host, rest[0]);
}

/** Client path of the consent screen for a target (`/add/<id>` or `/add/<domain>/<id>`). */
export function addPath(t: AddTarget, room?: { node: string | null; id: string }): string {
  const base = t.domain ? `/add/${t.domain}/${t.id}` : `/add/${t.id}`;
  return room ? `${base}?room=${encodeURIComponent(room.node ? `${room.node}/${room.id}` : room.id)}` : base;
}

/** Splits the `room` query of the consent screen: `<id>` (home node) or `<domain>/<id>`. */
export function parseRoomParam(value: string | null): { node: string | null; id: string } | null {
  if (!value) return null;
  const at = value.lastIndexOf("/");
  const id = at >= 0 ? value.slice(at + 1) : value;
  const node = at >= 0 ? value.slice(0, at).toLowerCase() : null;
  if (!ULID.test(id) || (node !== null && !isNodeDomain(node))) return null;
  return { node, id };
}
