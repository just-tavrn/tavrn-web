// SPDX-License-Identifier: Apache-2.0
import { AdultsOnlyBadge } from "../components/age/LockedChannel";
import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import type { DirectoryNode, VerifiedRoom } from "@tavrn/sdk";
import { useT } from "../i18n";
import { Avatar, Button, Dialog, ErrorText, Field, Input } from "../components/ui";
import { describeError, toastError, useToasts } from "../stores/toasts";
import { api } from "../lib/api";
import { useAuth } from "../stores/auth";
import { iconClient, joinRoom, loadNodes, loadRoomIcons, loadRooms, type RoomIconUrls } from "../stores/discover";
import { MediaAvatar } from "../components/Avatar";
import { useNodes } from "../stores/nodes";
import { useOriginDomain } from "../lib/origin";
import { formatTime } from "../lib/format";
import { Select, Textarea } from "./settings/common";

type Tab = "rooms" | "nodes";
const MIN_MEMBERS = [0, 5, 25, 100];

/** `value`, once it stopped changing for `ms`. */
function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Domain label of a card: always visible (design note 9d), marked when it is the node of this client. */
function NodeLabel({ domain }: { domain: string }) {
  const t = useT();
  const origin = useOriginDomain();
  return (
    <span className="truncate text-xs text-fg-2" data-testid="discover-room-node" title={domain}>
      {domain}
      {domain === origin && <span className="ml-1 rounded bg-bg-3 px-1 text-[10px] uppercase tracking-wide">{t("discover.this_node")}</span>}
    </span>
  );
}

/** Reasons a user can pick when reporting a node or room (sent as `check`, FEDERATION.md §9.2). */
export const REPORT_REASONS = ["spam", "abuse", "illegal", "security", "other"] as const;
type ReportReason = (typeof REPORT_REASONS)[number];

/**
 * Reports a node (or one of its rooms) to the admins of the user's home node. Reports never block
 * anything on their own; the admins see them in their Federation tab.
 */
export function ReportDialog({ domain, room, onClose }: { domain: string; room?: { id: string; name: string }; onClose: () => void }) {
  const t = useT();
  const push = useToasts((s) => s.push);
  const [reason, setReason] = useState<ReportReason>("spam");
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.directory.report({ domain, room_id: room?.id ?? null, check: reason, detail: detail.trim() });
      push({ kind: "info", title: t("discover.report_sent") });
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={room ? t("discover.report_room_title", { name: room.name }) : t("discover.report_node_title", { domain })} open onClose={onClose}>
      <form
        className="space-y-3 text-sm"
        data-testid="report-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="break-words text-fg-1">{t("discover.report_hint", { domain })}</p>
        <Field label={t("discover.report_reason")}>
          <Select value={reason} onChange={(e) => setReason(e.target.value as ReportReason)}>
            {REPORT_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`discover.report_reason.${r}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("discover.report_detail")}>
          <Textarea value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={1000} rows={4} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="danger" disabled={busy}>
            {t("discover.report_send")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** What a report is about: a node, or one of its rooms. */
type ReportTarget = { domain: string; room?: { id: string; name: string } };

/**
 * The open report dialog of a tab. It lives in the tab, not in the card: the list behind it loads again (a changed
 * search, a refetch) and may drop or remount the card, which must not close what the user is writing.
 */
function useReportDialog() {
  const [target, setTarget] = useState<ReportTarget | null>(null);
  const dialog = target && <ReportDialog domain={target.domain} room={target.room} onClose={() => setTarget(null)} />;
  return { open: setTarget, dialog };
}

/** "Report" button of a card; hidden for the user's own home node (it cannot be reported to itself). */
function ReportButton({ target, label, onReport }: { target: ReportTarget; label: string; onReport: (target: ReportTarget) => void }) {
  const t = useT();
  const home = useAuth((s) => s.user?.domain);
  if (!home || target.domain === home) return null;
  return (
    <Button variant="ghost" onClick={() => onReport(target)} aria-label={label} data-testid="discover-report">
      {t("discover.report")}
    </Button>
  );
}

function RoomCard({ room, icon, onReport }: { room: VerifiedRoom; icon?: RoomIconUrls; onReport: (target: ReportTarget) => void }) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const join = async () => {
    setBusy(true);
    try {
      const path = await joinRoom(room);
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
      navigate(path);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-bg-1 p-3" data-testid="discover-room" data-node={room.node} data-room={room.room_id}>
      <div className="flex min-w-0 items-start gap-3">
        <MediaAvatar name={room.name} still={icon?.still} animated={icon?.animated} size={40} shape="squircle" testId="room-icon" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" data-testid="discover-room-name">
            {room.name}
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2">
            <NodeLabel domain={room.node} />
            <span className="text-xs text-fg-2">· {t("invite.members", { count: room.member_count })}</span>
            {room.age_gate === "adults_only" && <AdultsOnlyBadge />}
          </div>
        </div>
      </div>
      {room.description && <p className="line-clamp-3 break-words text-sm text-fg-1">{room.description}</p>}
      {room.verification === "unsupported" && <p className="text-xs text-warn">{t("discover.unverified")}</p>}
      <div className="mt-auto flex flex-wrap justify-end gap-2">
        <ReportButton target={{ domain: room.node, room: { id: room.room_id, name: room.name } }} label={`${t("discover.report")}: ${room.name} (${room.node})`} onReport={onReport} />
        <Button onClick={() => void join()} disabled={busy} aria-label={`${t("discover.join")}: ${room.name} (${room.node})`}>
          {busy ? t("discover.joining") : t("discover.join")}
        </Button>
      </div>
    </li>
  );
}

/**
 * Room icons for the cards (design note 4.9), keyed `<node>/<room id>`: loaded only from nodes this client
 * already talks to (`iconClient`), once per node, shown as stills that animate on hover.
 */
function useRoomIcons(rooms: VerifiedRoom[]): Record<string, RoomIconUrls> {
  const origin = useOriginDomain();
  // A node with a new federated session (joined from here) gets its icons too.
  const sessions = useNodes((s) => s.sessions);
  const sources = useMemo(
    () =>
      [...new Set(rooms.map((r) => r.node))].sort().flatMap((node) => {
        const client = iconClient(node, origin);
        return client ? [{ node, client }] : [];
      }),
    // `sessions` is read by iconClient through the store.
    [rooms, origin, sessions],
  );
  return useQueries({
    queries: sources.map(({ node, client }) => ({ queryKey: ["discover-icons", node], queryFn: () => loadRoomIcons(client), staleTime: 5 * 60_000, retry: false })),
    combine: (results) => {
      const out: Record<string, RoomIconUrls> = {};
      results.forEach((r, i) => {
        for (const [id, icon] of Object.entries(r.data ?? {})) out[`${sources[i]!.node}/${id}`] = icon;
      });
      return out;
    },
  });
}

function RoomsTab({ node, onClearNode }: { node: string | null; onClearNode: () => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [minMembers, setMinMembers] = useState(0);
  const search = useDebounced(q);
  const rooms = useInfiniteQuery({
    queryKey: ["directory", "rooms", search, minMembers, node],
    queryFn: ({ pageParam }) => loadRooms({ q: search, minMembers, node: node ?? undefined, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
  });
  const list = useMemo(() => rooms.data?.pages.flatMap((p) => p.rooms) ?? [], [rooms.data]);
  const icons = useRoomIcons(list);
  const hidden = rooms.data?.pages.reduce((n, p) => n + p.hidden, 0) ?? 0;
  const report = useReportDialog();
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field label={t("discover.search")}>
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("discover.search_rooms_placeholder")} maxLength={100} data-testid="discover-search" />
        </Field>
        <Field label={t("discover.min_members")}>
          <Select value={String(minMembers)} onChange={(e) => setMinMembers(Number(e.target.value))}>
            {MIN_MEMBERS.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? t("discover.min_members_any") : t("discover.min_members_n", { count: n })}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {node && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-fg-1">
          {t("discover.on_node", { domain: node })}
          <Button variant="ghost" onClick={onClearNode}>
            ✕
          </Button>
        </p>
      )}
      {rooms.isPending && <p className="text-sm text-fg-2">{t("common.loading")}</p>}
      {rooms.isError && <p className="text-sm text-danger">{describeError(rooms.error)}</p>}
      {rooms.isSuccess && list.length === 0 && <p className="text-sm text-fg-2">{t("discover.no_rooms")}</p>}
      {hidden > 0 && (
        <p className="text-xs text-warn" data-testid="discover-hidden">
          {t("discover.hidden", { count: hidden })}
        </p>
      )}
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="discover-rooms">
        {list.map((r) => (
          <RoomCard key={`${r.node}/${r.room_id}`} room={r} icon={icons[`${r.node}/${r.room_id}`]} onReport={report.open} />
        ))}
      </ul>
      {report.dialog}
      {rooms.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="ghost" onClick={() => void rooms.fetchNextPage()} disabled={rooms.isFetchingNextPage}>
            {t("discover.load_more")}
          </Button>
        </div>
      )}
    </div>
  );
}

function NodeCard({ node, onShowRooms, onReport }: { node: DirectoryNode; onShowRooms: () => void; onReport: (target: ReportTarget) => void }) {
  const t = useT();
  const mode = ["open", "invite", "closed"].includes(node.registration) ? t(`discover.registration.${node.registration}`) : node.registration;
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-bg-1 p-3" data-testid="discover-node-card" data-node={node.domain}>
      <div className="flex min-w-0 items-start gap-3">
        <Avatar name={node.domain} size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={node.domain}>
            {node.domain}
          </p>
          {node.name && <p className="truncate text-xs text-fg-2">{node.name}</p>}
        </div>
      </div>
      {node.description && <p className="line-clamp-3 break-words text-sm text-fg-1">{node.description}</p>}
      <ul className="space-y-0.5 text-xs text-fg-2">
        <li data-testid="discover-node-registration">{t("discover.registration", { mode })}</li>
        <li data-testid="discover-node-software">{t("discover.software", { name: node.software.name, version: node.software.version })}</li>
        {/* The listing node's conformance result (FEDERATION.md §7.5, §9.4); failing nodes are not listed. */}
        <li data-testid="discover-node-conformance" data-result={node.conformance} className={node.conformance === "warn" ? "text-warn" : undefined}>
          {t("discover.conformance", { result: t(`conformance.${["pass", "warn", "fail"].includes(node.conformance) ? node.conformance : "unknown"}`) })}
        </li>
        <li>{t("discover.node_rooms", { count: node.public_rooms })}</li>
        <li>{t("discover.last_seen", { time: formatTime(node.last_seen) })}</li>
      </ul>
      <div className="mt-auto flex flex-wrap justify-end gap-2">
        <ReportButton target={{ domain: node.domain }} label={`${t("discover.report")}: ${node.domain}`} onReport={onReport} />
        {node.public_rooms > 0 && (
          <Button variant="ghost" onClick={onShowRooms}>
            {t("discover.show_rooms")}
          </Button>
        )}
      </div>
    </li>
  );
}

function NodesTab({ onShowRooms }: { onShowRooms: (domain: string) => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const search = useDebounced(q);
  const nodes = useInfiniteQuery({
    queryKey: ["directory", "nodes", search],
    queryFn: ({ pageParam }) => loadNodes({ q: search, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next ?? null,
  });
  const list = nodes.data?.pages.flatMap((p) => p.items) ?? [];
  const report = useReportDialog();
  return (
    <div className="space-y-4">
      <Field label={t("discover.search")}>
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("discover.search_nodes_placeholder")} maxLength={100} />
      </Field>
      {nodes.isPending && <p className="text-sm text-fg-2">{t("common.loading")}</p>}
      {nodes.isError && <p className="text-sm text-danger">{describeError(nodes.error)}</p>}
      {nodes.isSuccess && list.length === 0 && <p className="text-sm text-fg-2">{t("discover.no_nodes")}</p>}
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="discover-nodes">
        {list.map((n) => (
          <NodeCard key={n.domain} node={n} onShowRooms={() => onShowRooms(n.domain)} onReport={report.open} />
        ))}
      </ul>
      {report.dialog}
      {nodes.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="ghost" onClick={() => void nodes.fetchNextPage()} disabled={nodes.isFetchingNextPage}>
            {t("discover.load_more")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Discover (FEDERATION.md §7.5): rooms and nodes of the directory of the node this client belongs to. */
export function DiscoverPage() {
  const t = useT();
  const [tab, setTab] = useState<Tab>("rooms");
  const [node, setNode] = useState<string | null>(null);
  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6">
      <h1 className="text-xl font-semibold">{t("discover.title")}</h1>
      <p className="mt-1 max-w-2xl text-sm text-fg-1">{t("discover.intro")}</p>
      <div role="tablist" aria-label={t("discover.title")} className="mt-4 grid select-none max-w-sm grid-cols-2 rounded-md bg-bg-0 p-1 text-sm">
        {(["rooms", "nodes"] as Tab[]).map((k) => (
          <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)} className={`min-h-10 rounded ${tab === k ? "bg-bg-3 text-fg-0" : "text-fg-2"}`}>
            {k === "rooms" ? t("discover.tab_rooms") : t("discover.tab_nodes")}
          </button>
        ))}
      </div>
      <div className="mt-4">
        {tab === "rooms" ? (
          <RoomsTab node={node} onClearNode={() => setNode(null)} />
        ) : (
          <NodesTab
            onShowRooms={(domain) => {
              setNode(domain);
              setTab("rooms");
            }}
          />
        )}
      </div>
    </div>
  );
}
