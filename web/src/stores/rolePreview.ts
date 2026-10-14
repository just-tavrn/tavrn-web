// SPDX-License-Identifier: Apache-2.0
/**
 * The active "view the room as a role" preview (docs/CLIENT.md): which room, which roles, which join date. Session
 * state of this tab only, never persisted: it ends on exit, on leaving the room, on reload and on sign-out.
 */
import { useMemo } from "react";
import { create } from "zustand";
import type { RoomDetail } from "@tavrn/sdk";
import { previewRoom } from "../lib/previewRoom";
import { useAuth } from "./auth";

export interface RolePreview {
  roomId: string;
  /** The simulated member's roles (without `@everyone`, which every member holds; empty = `@everyone` alone). */
  roleIds: string[];
  /** The simulated join date (milliseconds): the start of the encrypted history window. */
  joinedAt: number;
  /** The role names for the banner ("@everyone" alone, or the chosen roles). */
  label: string;
}

interface RolePreviewState {
  preview: RolePreview | null;
  start: (preview: RolePreview) => void;
  exit: () => void;
}

export const useRolePreview = create<RolePreviewState>((set) => ({
  preview: null,
  start: (preview) => set({ preview: { ...preview, roleIds: [...preview.roleIds] } }),
  exit: () => set({ preview: null }),
}));

/** The preview of `roomId`, if one is active. */
export function previewOf(roomId: string | null | undefined): RolePreview | null {
  const p = useRolePreview.getState().preview;
  return p && roomId && p.roomId === roomId ? p : null;
}

/** Is any preview active (the write guard)? */
export function previewing(): boolean {
  return useRolePreview.getState().preview !== null;
}

/** The active preview of `roomId` (reactive). */
export function useRoomPreview(roomId: string | null | undefined): RolePreview | null {
  return useRolePreview((s) => (s.preview && roomId && s.preview.roomId === roomId ? s.preview : null));
}

/** The room detail as the previewed roles see it while a preview of this room is active, else unchanged. */
export function usePreviewedRoom<T extends RoomDetail | undefined>(room: T): T {
  const preview = useRoomPreview(room?.id);
  const roleKey = preview?.roleIds.join(",");
  // `roleKey` stands for the role ids (a new array per start).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (room && preview ? (previewRoom(room, preview.roleIds) as T) : room), [room, roleKey, !!preview]);
}

// Signing out ends the preview (the next account must not start in it).
useAuth.subscribe((s, prev) => {
  if (prev.token && !s.token) useRolePreview.getState().exit();
});
