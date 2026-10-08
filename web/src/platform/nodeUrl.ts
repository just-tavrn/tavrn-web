// SPDX-License-Identifier: Apache-2.0
/**
 * The home node URL of the desktop app's node picker. The same rules are enforced again by the shell
 * (`apps/desktop/src-tauri/src/node_url.rs`) before it persists anything.
 */
import { TavrnApi, isNodeDomain } from "@tavrn/sdk";

export type NodeUrlProblem = "invalid" | "insecure" | "credentials" | "path";
export type ParsedNodeUrl = { ok: true; url: string } | { ok: false; reason: NodeUrlProblem };

const MAX_LENGTH = 300;
/** Plain HTTP only for a node in development mode on this machine. */
const DEV_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Parses what the user typed into a node origin: https (http only for localhost), no credentials, no path. */
export function parseNodeUrl(input: string): ParsedNodeUrl {
  const text = input.trim();
  if (!text || text.length > MAX_LENGTH) return { ok: false, reason: "invalid" };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "invalid" };
  if (!url.hostname) return { ok: false, reason: "invalid" };
  if (url.protocol === "http:" && !DEV_HOSTS.has(url.hostname)) return { ok: false, reason: "insecure" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  if (url.pathname !== "/" || url.search || url.hash || /[?#]/.test(text)) return { ok: false, reason: "path" };
  return { ok: true, url: url.origin };
}

export type NodeCheck = { ok: true; domain: string; web?: string } | { ok: false; reason: "unreachable" | "not_a_node" };

/** Asks the node for its discovery document: a tavrn node answers with its identity domain. */
export async function checkNode(base: string): Promise<NodeCheck> {
  let doc: unknown;
  try {
    doc = await new TavrnApi({ baseUrl: base }).node.wellKnown();
  } catch (e) {
    return { ok: false, reason: e instanceof TypeError ? "unreachable" : "not_a_node" };
  }
  const { domain, web } = (doc ?? {}) as { domain?: unknown; web?: unknown };
  // A node in development mode (plain http on this computer) is called `localhost`.
  const valid = typeof domain === "string" && (isNodeDomain(domain) || (base.startsWith("http:") && domain === "localhost"));
  if (!valid) return { ok: false, reason: "not_a_node" };
  // The origin of its web client (the sign-in page of the desktop app), when the document names a usable one.
  const webOrigin = typeof web === "string" ? parseNodeUrl(web) : null;
  return webOrigin?.ok ? { ok: true, domain, web: webOrigin.url } : { ok: true, domain };
}
