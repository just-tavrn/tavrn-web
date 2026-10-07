// SPDX-License-Identifier: Apache-2.0
/**
 * Invite links typed or pasted into the "+" dialog (design note 4.9): `https://<node>/invite/<code>` or a
 * bare code. The node is the one whose web client the link opens: this client's origin, a node whose
 * web client we know from its session, or else the link's host name (a node's web client usually lives
 * on its domain).
 */
import { isNodeDomain } from "@tavrn/sdk";

const CODE = /^[A-Za-z0-9_-]{4,64}$/;

export interface InviteTarget {
  /** Domain of the node, or null for the node this web client belongs to. */
  node: string | null;
  code: string;
}

export interface InviteContext {
  /** `location.origin` of this web client. */
  origin: string;
  /** Web client origins of nodes with a session: domain → origin (e.g. `https://chat.example`). */
  webs: Record<string, string>;
}

export function parseInviteInput(input: string, ctx: InviteContext): InviteTarget | null {
  const text = input.trim();
  if (!text) return null;
  if (CODE.test(text)) return { node: null, code: text };
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const at = segments.lastIndexOf("invite");
  const code = at >= 0 ? segments[at + 1] : undefined;
  if (!code || !CODE.test(code) || at + 2 !== segments.length) return null;
  if (url.origin === ctx.origin) return { node: null, code };
  for (const [domain, web] of Object.entries(ctx.webs)) {
    try {
      if (new URL(web).origin === url.origin) return { node: domain, code };
    } catch {
      /* a session without a valid web origin */
    }
  }
  const host = url.hostname.toLowerCase();
  // Only real node domains (never IP literals or plain http elsewhere): the client federates with it.
  if (url.protocol !== "https:" || url.port || !isNodeDomain(host)) return null;
  return { node: host, code };
}
