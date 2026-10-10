// SPDX-License-Identifier: Apache-2.0
/**
 * The home node URL of the node picker, checked again here before the shell persists it (the client checks the same
 * rules in `web/src/platform/nodeUrl.ts`, the Tauri shell in `src-tauri/src/node_url.rs`): https only (plain http only
 * for a development node on this computer: `localhost`, `127.0.0.1`), no credentials, no path, query or fragment. The
 * result is the origin.
 */

/** Longer input (in bytes) is refused before parsing. */
const MAX_LENGTH = 300;
/** Hosts that may be reached over plain HTTP (a node in development mode on this computer). */
export const DEV_HOSTS: readonly string[] = ["localhost", "127.0.0.1"];

export type NodeUrlCode = "node_url.invalid" | "node_url.insecure" | "node_url.credentials" | "node_url.path" | "node_url.domain";

/** A refused node URL; `code` is what the client translates (`node_picker.error.*`). */
export class NodeUrlError extends Error {
  readonly code: NodeUrlCode;
  constructor(code: NodeUrlCode) {
    super(code);
    this.code = code;
  }
}

/** Validates a node URL and returns its origin (`https://tavrn.example`, `http://127.0.0.1:8300`). */
export function validateNodeUrl(input: string): string {
  const text = input.trim();
  if (!text || Buffer.byteLength(text) > MAX_LENGTH) throw new NodeUrlError("node_url.invalid");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new NodeUrlError("node_url.invalid");
  }
  if (!url.hostname) throw new NodeUrlError("node_url.invalid");
  if (url.protocol === "http:") {
    if (!DEV_HOSTS.includes(url.hostname)) throw new NodeUrlError("node_url.insecure");
  } else if (url.protocol !== "https:") {
    throw new NodeUrlError("node_url.invalid");
  }
  if (url.username || url.password) throw new NodeUrlError("node_url.credentials");
  // Anything after the origin but the root path (a path, a query or fragment, even an empty one) is refused.
  if (url.href !== `${url.origin}/`) throw new NodeUrlError("node_url.path");
  return url.origin;
}

function validLabel(l: string): boolean {
  return l.length > 0 && l.length <= 63 && /^[a-z0-9-]+$/.test(l) && !l.startsWith("-") && !l.endsWith("-");
}

/** A node domain (FEDERATION.md §1.3 rule 1): lowercase labels, at least one dot, no port, no IP literal. */
export function validDomain(d: string): boolean {
  if (!d || d.length > 253 || !d.includes(".")) return false;
  const labels = d.split(".");
  return labels.every(validLabel) && !/^[0-9]+$/.test(labels[labels.length - 1] ?? "");
}

/** An identity domain worth storing: a node domain, or `localhost` (a development node). */
export function validIdentityDomain(d: string): boolean {
  return d === "localhost" || validDomain(d);
}
