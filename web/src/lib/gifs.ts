// SPDX-License-Identifier: Apache-2.0
/**
 * Hosts of the GIF providers a node may configure (same list as the node, `tavrn-node/src/gifs.rs`).
 * In encrypted messages the node cannot check GIF URLs, so the client does: anything else would let
 * a member make every reader's browser load an arbitrary URL (tracking, IP leak).
 */
const GIF_HOSTS = new Set(["media.giphy.com", "media0.giphy.com", "media1.giphy.com", "media2.giphy.com", "media3.giphy.com", "media4.giphy.com", "i.giphy.com", "media.tenor.com", "c.tenor.com", "media1.tenor.com"]);

export function isGifUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 2048 || !url.startsWith("https://")) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && GIF_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}
