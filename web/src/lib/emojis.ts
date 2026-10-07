// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Emoji } from "@tavrn/sdk";
import { useNode } from "../components/NodeScope";
import { api } from "./api";
import { apiFor, homeDomain, useNodes } from "../stores/nodes";
import type { EmojiResolver, EmojiToken } from "./markdown";

/**
 * Custom emojis (design note 4.13): room emojis, personal emojis on the home node and emojis of every other room
 * the user is in. Images come from the public route of the node hosting the emoji
 * (`GET /api/v1/emojis/{id}/image`, `?still=1` for the first frame), so they need no token and are cached.
 */

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** `prefers-reduced-motion`, kept current. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(reducedMotion);
  useEffect(() => {
    const mq = typeof window !== "undefined" ? window.matchMedia?.("(prefers-reduced-motion: reduce)") : undefined;
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/** Base URL of a node's API for images: same origin (""), or an http(s) origin; anything else falls back to `https://node`. */
export function nodeBase(node: string | null | undefined): string {
  const base = apiFor(node).baseUrl;
  if (base === "" || /^https?:\/\/[^/?#\s"'<>]+$/i.test(base.replace(/\/+$/, ""))) return base.replace(/\/+$/, "");
  return `https://${node}`;
}

const urls = new Map<string, string>();

/**
 * Image URL of emoji `id`, loaded from `via` (a node the client talks to anyway: the conversation's or the home
 * node). An emoji hosted elsewhere (`origin`) is served from `via`'s cached copy (`?host=`, design note 4.13): the
 * client never contacts foreign nodes. Kept in a per-session map.
 */
export function emojiImageUrl(via: string | null | undefined, id: string, still = false, origin?: string | null): string {
  const host = origin && origin !== via ? origin : null;
  const key = `${via ?? ""}|${id}|${still ? 1 : 0}|${host ?? ""}`;
  let url = urls.get(key);
  if (!url) {
    const q = [still ? "still=1" : "", host ? `host=${encodeURIComponent(host)}` : ""].filter(Boolean).join("&");
    url = `${nodeBase(via)}/api/v1/emojis/${encodeURIComponent(id)}/image${q ? `?${q}` : ""}`;
    urls.set(key, url);
  }
  return url;
}

/** What views of one conversation know about emojis (provided by the conversation view). */
export interface EmojiContextValue {
  /** Node hosting the conversation (tokens without a host live there). */
  domain: string;
  /** Room channels: the room. */
  roomId?: string;
  /** May emojis of other rooms and personal emojis be used here (`use_external_emojis`; DMs always). */
  externalAllowed: boolean;
  /** The room's own emojis. */
  roomEmojis: Emoji[];
}

export const EmojiContext = createContext<EmojiContextValue | null>(null);

export function useEmojiContext(): EmojiContextValue | null {
  return useContext(EmojiContext);
}

/** Resolver for `<:name:ID@host>` tokens in this conversation (animated unless reduced motion). */
export function useEmojiResolver(): EmojiResolver | undefined {
  const ctx = useEmojiContext();
  const reduced = useReducedMotion();
  const domain = ctx?.domain;
  return useMemo(() => (domain ? (t: EmojiToken) => emojiImageUrl(domain, t.id, reduced, t.host) : undefined), [domain, reduced]);
}

/** Public URL of a room emoji of the current node scope (kept for callers that name the room). */
export function useEmojiImage(_roomId: string, emojiId: string, still = false): string | null {
  const { domain } = useNode();
  return emojiId ? emojiImageUrl(domain, emojiId, still) : null;
}

export function useRoomEmojis(roomId: string) {
  const { api: nodeApi } = useNode();
  return useQuery({ queryKey: ["emojis", roomId], queryFn: () => nodeApi.emojis.list(roomId), enabled: !!roomId, staleTime: 5 * 60_000 });
}

/** name → image URL for all emojis of a room (`:name:` in messages); animated unless reduced motion. */
export function useEmojiUrlMap(_roomId: string, emojis: { id: string; name: string }[]): Record<string, string> {
  const { domain } = useNode();
  const reduced = useReducedMotion();
  const signature = emojis.map((e) => `${e.id}:${e.name}`).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => Object.fromEntries(emojis.map((e) => [e.name, emojiImageUrl(domain, e.id, reduced)])), [domain, signature, reduced]);
}

/** A custom emoji offered by the picker. */
export interface PickerEmoji {
  id: string;
  name: string;
  animated: boolean;
  /** Node the image is loaded from. */
  node: string;
  /** The node hosting it when it is not `node` (loaded from `node`'s cached copy). */
  origin?: string | null;
  source: "room" | "personal" | "other";
  roomId?: string;
  roomName?: string;
}

/** The own personal emojis (home node). */
export function usePersonalEmojis(enabled = true) {
  return useQuery({ queryKey: ["emojis", "personal"], queryFn: () => api.emojis.personal.list(), enabled, staleTime: 5 * 60_000 });
}

/**
 * Emojis of every other room the user is in (home node and connected nodes) and the personal ones, loaded
 * when the picker opens.
 */
export function useOtherEmojis(currentRoomId: string | undefined, enabled: boolean): { personal: PickerEmoji[]; other: PickerEmoji[]; loading: boolean } {
  const home = homeDomain() ?? "";
  const domains = useNodes((s) => Object.keys(s.sessions).filter((d) => d !== home).sort().join(","));
  const remote = domains ? domains.split(",") : [];
  const homeRooms = useQuery({ queryKey: ["rooms"], queryFn: () => api.rooms.list(), enabled, staleTime: 60_000 });
  const remoteRooms = useQueries({ queries: remote.map((d) => ({ queryKey: ["rooms", d], queryFn: () => apiFor(d).rooms.list(), enabled, staleTime: 60_000 })) });
  const rooms: { id: string; name: string; node: string }[] = [
    ...(homeRooms.data ?? []).map((r) => ({ id: r.id, name: r.name, node: home })),
    ...remoteRooms.flatMap((q, i) => (q.data ?? []).map((r) => ({ id: r.id, name: r.name, node: remote[i]! }))),
  ].filter((r) => r.id !== currentRoomId);
  const lists = useQueries({ queries: rooms.map((r) => ({ queryKey: ["emojis", r.id], queryFn: () => apiFor(r.node).emojis.list(r.id), enabled, staleTime: 5 * 60_000 })) });
  const personal = usePersonalEmojis(enabled);
  return {
    personal: (personal.data?.items ?? []).map((e) => ({ id: e.id, name: e.name, animated: e.animated, node: home, source: "personal" as const })),
    other: rooms.flatMap((r, i) => (lists[i]?.data ?? []).map((e) => ({ id: e.id, name: e.name, animated: !!e.animated, node: r.node, source: "other" as const, roomId: r.id, roomName: r.name }))),
    loading: homeRooms.isLoading || personal.isLoading || lists.some((l) => l.isLoading),
  };
}
