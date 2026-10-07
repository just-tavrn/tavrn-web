// SPDX-License-Identifier: Apache-2.0
/**
 * Embeds from an allow list (design note 4.13 item 7): the reader recognises a few providers from the URL alone
 * and offers a click-to-play iframe; nothing is fetched to recognise them. The iframe hosts are exactly the
 * `frame-src` of the node's CSP (tavrn-node/src/webapp.rs). Loading a thumbnail or the player reveals the
 * reader's IP address to the provider, hence the "Embeds" privacy setting.
 */

export type EmbedProvider = "youtube" | "twitch" | "vimeo" | "spotify";

/** What the embed shows; decides the label and the card's shape. */
export type EmbedKind = "video" | "short" | "channel" | "clip" | "track" | "album" | "playlist" | "episode";

export interface Embed {
  provider: EmbedProvider;
  kind: EmbedKind;
  /** The provider's id of the item (video id, channel name, clip slug, …). */
  id: string;
  /** The URL as written in the message. */
  url: string;
  /** The player URL for the iframe (allow-listed host). */
  embedUrl: string;
  /** Provider thumbnail (https), when one can be derived from the URL. */
  thumbnail?: string;
  /** Spotify players are short strips; everything else is 16:9 (Shorts 9:16). */
  shape: "wide" | "tall" | "strip" | "panel";
}

/** The iframe hosts; the same list as the CSP `frame-src` (besides the captcha). */
export const EMBED_HOSTS = ["www.youtube-nocookie.com", "player.twitch.tv", "clips.twitch.tv", "player.vimeo.com", "open.spotify.com"] as const;

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const TWITCH_NAME = /^[A-Za-z0-9_]{3,25}$/;
const TWITCH_SLUG = /^[A-Za-z0-9_-]{1,100}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
/** Twitch paths that are pages, not channels. */
const TWITCH_RESERVED = new Set(["directory", "videos", "settings", "p", "downloads", "jobs", "search", "subscriptions", "inventory", "wallet", "drops", "turbo", "login", "signup", "friends", "messages", "store", "prime", "bits"]);

/** `90`, `90s`, `1m30s`, `1h2m3s` → seconds (0 if unreadable, at most one day). */
export function parseStart(v: string | null): number {
  if (!v) return 0;
  if (/^\d{1,6}$/.test(v)) return Math.min(Number(v), 86_400);
  const m = /^(?:(\d{1,2})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s)?$/.exec(v);
  if (!m || (!m[1] && !m[2] && !m[3])) return 0;
  return Math.min(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0), 86_400);
}

function youtube(u: URL, host: string): Omit<Embed, "url"> | null {
  let id: string | undefined;
  let kind: EmbedKind = "video";
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "youtu.be") id = parts[0];
  else if (parts[0] === "watch") id = u.searchParams.get("v") ?? undefined;
  else if (parts[0] === "shorts") {
    id = parts[1];
    kind = "short";
  } else if (parts[0] === "embed" || parts[0] === "live" || parts[0] === "v") id = parts[1];
  if (!id || !YT_ID.test(id)) return null;
  const start = parseStart(u.searchParams.get("t") ?? u.searchParams.get("start"));
  const embedUrl = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1${start ? `&start=${start}` : ""}`;
  return { provider: "youtube", kind, id, embedUrl, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, shape: kind === "short" ? "tall" : "wide" };
}

function twitch(u: URL, host: string, parent: string): Omit<Embed, "url"> | null {
  const parts = u.pathname.split("/").filter(Boolean);
  const p = encodeURIComponent(parent);
  const clip = (slug: string | undefined): Omit<Embed, "url"> | null =>
    slug && TWITCH_SLUG.test(slug) ? { provider: "twitch", kind: "clip", id: slug, embedUrl: `https://clips.twitch.tv/embed?clip=${slug}&parent=${p}&autoplay=true`, shape: "wide" } : null;
  if (host === "clips.twitch.tv") return parts[0] === "embed" ? clip(u.searchParams.get("clip") ?? undefined) : clip(parts[0]);
  if (parts[0] === "videos" && /^\d{1,15}$/.test(parts[1] ?? "")) {
    return { provider: "twitch", kind: "video", id: parts[1]!, embedUrl: `https://player.twitch.tv/?video=v${parts[1]}&parent=${p}&autoplay=true`, shape: "wide" };
  }
  const name = parts[0]?.toLowerCase();
  if (!name || !TWITCH_NAME.test(name) || TWITCH_RESERVED.has(name)) return null;
  if (parts[1] === "clip") return clip(parts[2]);
  if (parts.length > 1) return null;
  return {
    provider: "twitch",
    kind: "channel",
    id: name,
    embedUrl: `https://player.twitch.tv/?channel=${name}&parent=${p}&autoplay=true`,
    thumbnail: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${name}-640x360.jpg`,
    shape: "wide",
  };
}

function vimeo(u: URL, host: string): Omit<Embed, "url"> | null {
  const parts = u.pathname.split("/").filter(Boolean);
  const id = host === "player.vimeo.com" ? (parts[0] === "video" ? parts[1] : undefined) : [...parts].reverse().find((x) => /^\d{1,12}$/.test(x));
  if (!id || !/^\d{1,12}$/.test(id)) return null;
  const start = parseStart(u.hash.match(/^#t=([0-9hms]+)$/)?.[1] ?? null);
  return { provider: "vimeo", kind: "video", id, embedUrl: `https://player.vimeo.com/video/${id}?autoplay=1${start ? `#t=${start}s` : ""}`, shape: "wide" };
}

function spotify(u: URL): Omit<Embed, "url"> | null {
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0]?.startsWith("intl-")) parts.shift();
  if (parts[0] === "embed") parts.shift();
  const [type, id] = parts;
  if (!(type === "track" || type === "album" || type === "playlist" || type === "episode") || !id || !SPOTIFY_ID.test(id)) return null;
  return { provider: "spotify", kind: type, id, embedUrl: `https://open.spotify.com/embed/${type}/${id}`, shape: type === "track" || type === "episode" ? "strip" : "panel" };
}

/**
 * The embed for `raw`, or `null` when it is not an allow-listed provider URL. `parent` is the host name of
 * the page that embeds Twitch players (Twitch refuses to play without it).
 */
export function parseEmbed(raw: string, parent: string): Embed | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || (u.port && u.port !== "443" && u.port !== "80")) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  let e: Omit<Embed, "url"> | null = null;
  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com" || host === "youtu.be" || host === "youtube-nocookie.com") e = youtube(u, host);
  else if (host === "twitch.tv" || host === "m.twitch.tv" || host === "clips.twitch.tv") e = twitch(u, host, parent);
  else if (host === "vimeo.com" || host === "player.vimeo.com") e = vimeo(u, host);
  else if (host === "open.spotify.com") e = spotify(u);
  return e ? { ...e, url: raw } : null;
}

/** The provider's display name. */
export const PROVIDER_NAMES: Record<EmbedProvider, string> = { youtube: "YouTube", twitch: "Twitch", vimeo: "Vimeo", spotify: "Spotify" };
