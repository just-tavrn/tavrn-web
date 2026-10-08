// SPDX-License-Identifier: Apache-2.0
/** The room rail: the narrow bar on the far left (home, rooms, rooms of other nodes, create, discover). */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useLocation, useNavigate } from "react-router";
import { api } from "../lib/api";
import { useAuth } from "../stores/auth";
import { useT } from "../i18n";
import { useShell } from "./AppShell";
import { RoomIcon } from "./Avatar";
import { CreateRoomDialog } from "./CreateRoomDialog";
import { BrandIcon } from "./auth/Brand";
import { roomPath } from "./NodeScope";
import { useConversations } from "../pages/DirectMessages";
import { useUnread } from "../stores/unread";
import { apiFor, useNodes } from "../stores/nodes";
import { useReach } from "../stores/reach";
import { useConversationIndex } from "../stores/conversationIndex";
import { useRoomMenu } from "./menus/RoomMenu";

/**
 * Rooms of another node in the rail: always under its domain (design note 9d). The list comes from that
 * node; while it cannot be reached, the rooms known from the index stay visible and marked.
 */
function NodeRoomGroup({ domain, indexed }: { domain: string; indexed: string[] }) {
  const t = useT();
  const session = useNodes((s) => s.sessions[domain]);
  const unreachable = useReach((s) => s.nodes[domain] === "unreachable");
  const rooms = useQuery({ queryKey: ["rooms", domain], queryFn: () => apiFor(domain).rooms.list(), enabled: !!session, retry: 1 });
  const list = rooms.data ?? indexed.map((id) => ({ id, name: "?" }));
  if (!list.length) return null;
  return (
    <div className="flex w-full flex-col items-center gap-2" data-testid="node-group" data-node={domain} data-unreachable={unreachable || undefined}>
      <div className="my-1 h-px w-8 bg-line" />
      <span className={`max-w-[64px] truncate text-[10px] leading-tight ${unreachable ? "text-danger" : "text-fg-2"}`} title={unreachable ? t("node.offline", { domain }) : domain}>
        {unreachable && <span role="img" aria-label={t("node.offline_short")}>⚠ </span>}
        {domain}
      </span>
      {list.map((r) => (
        <RailRoom key={r.id} room={r} node={domain} title={`${r.name} · ${domain}`} label={`${r.name} (${domain})`} dimmed={unreachable}>
          <RoomIcon room={r} size={44} node={domain} />
        </RailRoom>
      ))}
    </div>
  );
}

/** A room in the rail with its context menu (right-click, long press, keyboard; design note 4.11). */
function RailRoom({ room, node, title, label, dimmed = false, children }: { room: { id: string; name: string }; node: string | null; title: string; label: string; dimmed?: boolean; children: ReactNode }) {
  const { menu, overlay } = useRoomMenu(room, node);
  return (
    <>
      <NavLink
        to={roomPath(node, room.id)}
        title={title}
        aria-label={label}
        data-testid="rail-room"
        data-room={room.id}
        {...menu.triggerProps}
        className={({ isActive }) => `relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition-all ${isActive ? "rounded-xl ring-2 ring-accent" : "hover:rounded-xl"} ${dimmed ? "opacity-50" : ""}`}
      >
        {children}
      </NavLink>
      {overlay}
    </>
  );
}

export function RoomRail() {
  const t = useT();
  const rooms = useQuery({ queryKey: ["rooms"], queryFn: () => api.rooms.list() });
  const { closeNav } = useShell();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const conversationIds = (useConversations().data ?? []).map((c) => c.id);
  const unread = useUnread((s) => conversationIds.some((id) => (s.states[id]?.unread ?? 0) > 0));
  const location = useLocation();
  const home = location.pathname === "/" || location.pathname.startsWith("/conversations") || /^\/n\/[^/]+\/conversations\//.test(location.pathname) || location.pathname === "/friends";
  const homeDomain = useAuth((s) => s.user?.domain);
  const index = useConversationIndex((s) => s.state);
  const sessionDomains = useNodes((s) => Object.keys(s.sessions).join(","));
  // Other nodes: those with a session and those the index names (rooms kept while a node is down).
  const indexed = new Map<string, string[]>();
  for (const d of sessionDomains ? sessionDomains.split(",") : []) indexed.set(d, []);
  for (const e of index?.items ?? []) {
    if (e.node === homeDomain || e.kind !== "room" || !e.room_id) continue;
    indexed.set(e.node, [...(indexed.get(e.node) ?? []), e.room_id]);
  }
  indexed.delete(homeDomain ?? "");
  return (
    <>
      <NavLink to="/" aria-label={t("shell.home")} title={t("shell.home")} className={`relative flex h-12 w-12 items-center justify-center rounded-2xl ${home ? "bg-bg-3 ring-2 ring-accent" : "bg-bg-3 hover:rounded-xl"}`}>
        <BrandIcon size={32} />
        {unread && <span role="img" className="absolute right-0 top-0 h-3 w-3 rounded-full border-2 border-bg-0 bg-accent" aria-label={t("dm.unread")} data-testid="home-unread" />}
      </NavLink>
      <div className="my-1 h-px w-8 bg-line" />
      {rooms.data?.map((r) => (
        <RailRoom key={r.id} room={r} node={null} title={r.name} label={r.name}>
          <RoomIcon room={r} size={44} node={null} />
        </RailRoom>
      ))}
      {[...indexed.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([domain, ids]) => (
          <NodeRoomGroup key={domain} domain={domain} indexed={ids} />
        ))}
      <button type="button" aria-label={t("shell.create_room")} title={t("shell.create_room")} onClick={() => setOpen(true)} className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-bg-3 text-xl text-accent hover:rounded-xl hover:bg-accent-soft">
        +
      </button>
      {/* Discover (FEDERATION.md §7.5): rooms and nodes of the directory. */}
      <NavLink to="/discover" onClick={closeNav} aria-label={t("discover.title")} title={t("discover.title")} data-testid="nav-discover" className={({ isActive }) => `flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-bg-3 text-xl text-accent hover:rounded-xl hover:bg-accent-soft ${isActive ? "rounded-xl ring-2 ring-accent" : ""}`}>
        <span aria-hidden="true">🧭</span>
      </NavLink>
      <CreateRoomDialog
        open={open}
        onClose={() => setOpen(false)}
        onCreated={(path) => {
          setOpen(false);
          closeNav();
          navigate(path);
        }}
      />
    </>
  );
}
