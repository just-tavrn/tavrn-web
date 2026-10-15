// SPDX-License-Identifier: Apache-2.0
import { useQueries, useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { apiFor, homeDomain, useNodes } from "../stores/nodes";
import { roomsQuery } from "./queries";

/**
 * Soundboard clips beyond the current room (design note 4.13): the own personal clips (home node) and the clips of
 * every other room the user is in, loaded when the soundboard opens. Playing them needs
 * `use_external_sounds` in the voice channel.
 */
export interface ExternalSound {
  id: string;
  name: string;
  emoji?: string | null;
  /** Node hosting the clip. */
  node: string;
  source: "personal" | "other";
  roomId?: string;
  roomName?: string;
}

export function useExternalSounds(currentRoomId: string, enabled: boolean): { personal: ExternalSound[]; other: ExternalSound[] } {
  const home = homeDomain() ?? "";
  const domains = useNodes((s) => Object.keys(s.sessions).filter((d) => d !== home).sort().join(","));
  const remote = domains ? domains.split(",") : [];
  const homeRooms = useQuery({ ...roomsQuery(null), enabled });
  const remoteRooms = useQueries({ queries: remote.map((d) => ({ ...roomsQuery(d), enabled })) });
  const rooms = [
    ...(homeRooms.data ?? []).map((r) => ({ id: r.id, name: r.name, node: home })),
    ...remoteRooms.flatMap((q, i) => (q.data ?? []).map((r) => ({ id: r.id, name: r.name, node: remote[i]! }))),
  ].filter((r) => r.id !== currentRoomId);
  const lists = useQueries({ queries: rooms.map((r) => ({ queryKey: ["soundboard", r.node, r.id], queryFn: () => apiFor(r.node).soundboard.list(r.id), enabled, staleTime: 60_000, retry: false })) });
  // Fresh on every open (clips may have been added on another device).
  const personal = useQuery({ queryKey: ["sounds", "personal"], queryFn: () => api.soundboard.personal.list(), enabled, staleTime: 0 });
  return {
    personal: (personal.data?.items ?? []).map((s) => ({ id: s.id, name: s.name, emoji: s.emoji, node: home, source: "personal" as const })),
    other: rooms.flatMap((r, i) => (lists[i]?.data ?? []).map((s) => ({ id: s.id, name: s.name, emoji: s.emoji, node: r.node, source: "other" as const, roomId: r.id, roomName: r.name }))),
  };
}
