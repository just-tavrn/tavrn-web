// SPDX-License-Identifier: Apache-2.0
/**
 * The channel tree of the room settings (docs/CLIENT.md "Room settings"): the welcome channel, the channels without
 * category, then the categories with their channels, in the sidebar's order. Members with `manage_channels` reorder
 * it here (never in the sidebar, where a slip would move channels by accident): drag a row by its handle, or use the
 * up/down buttons (keyboard and touch). The moves are planned by lib/channelOrder.ts and saved one PATCH at a time.
 */
import { useEffect, useRef, useState, type DragEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Category, Channel, RoomDetail } from "@tavrn/sdk";
import { useNode } from "../../components/NodeScope";
import { useT } from "../../i18n";
import { toastError, useToasts } from "../../stores/toasts";
import { categoryName, channelName } from "../../lib/names";
import { AccessMark, BotsAllowedIcon, LockMark, NoBotsIcon } from "../../components/Badges";
import { channelPrivacy } from "../../lib/channelPermissions";
import { botMarker } from "../../lib/botAccess";
import { channelGroup, isFixedChannel, planCategoryMove, planChannelMove, planDrop, type DragItem, type DropTarget, type OrderPlan } from "../../lib/channelOrder";
import { patchRoom, withCategory, withChannel } from "../../lib/roomCache";

/**
 * Saves a plan one PATCH at a time and writes every answer into the cached room, so the sidebar follows at once. On an
 * error the node's state decides: the room is refetched.
 */
export function useOrderSaver(roomId: string) {
  const { api } = useNode();
  const t = useT();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const save = async (type: DragItem["type"], plan: OrderPlan, opts: { quiet?: boolean } = {}): Promise<boolean> => {
    if (!plan.ok) {
      if (plan.reason === "fixed") useToasts.getState().push({ kind: "warning", title: t("channels.reorder_fixed") });
      return false;
    }
    if (!plan.updates.length) return true;
    setBusy(true);
    try {
      for (const u of plan.updates) {
        if (type === "channel") {
          const channel = await api.channels.update(roomId, u.id, { position: u.position, ...("category_id" in u ? { category_id: u.category_id } : {}) });
          patchRoom(queryClient, roomId, withChannel(channel));
        } else {
          patchRoom(queryClient, roomId, withCategory(await api.channels.updateCategory(roomId, u.id, { position: u.position })));
        }
      }
      if (!opts.quiet) useToasts.getState().push({ kind: "info", title: t("channels.reorder_saved") });
      return true;
    } catch (e) {
      toastError(e);
      await queryClient.invalidateQueries({ queryKey: ["room", roomId] });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, save };
}

const dragKey = (target: DropTarget) => (target.type === "group_end" ? `group:${target.categoryId ?? ""}` : `${target.type}:${target.id}`);

export interface ChannelTreeProps {
  room: RoomDetail;
  /** Reordering is offered (`manage_channels`). */
  canReorder: boolean;
  /** The category headers open the category's permissions (`manage_roles`). */
  canManageRoles: boolean;
  selectedChannelId?: string;
  selectedCategoryId?: string;
  onSelectChannel: (id: string) => void;
  onSelectCategory: (id: string) => void;
  /** Shown for channel managers: deletes the category. */
  onDeleteCategory?: (category: Category) => void;
}

export function ChannelTree({ room, canReorder, canManageRoles, selectedChannelId, selectedCategoryId, onSelectChannel, onSelectCategory, onDeleteCategory }: ChannelTreeProps) {
  const t = useT();
  const { busy, save } = useOrderSaver(room.id);
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // An arrow button keeps the focus while its row moves (React moves the DOM node, which drops the focus).
  const [refocus, setRefocus] = useState<{ id: string; dir: "up" | "down" } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!refocus || busy) return;
    const find = (dir: string) => root.current?.querySelector<HTMLButtonElement>(`button[data-reorder="${dir}"][data-reorder-id="${CSS.escape(refocus.id)}"]`);
    const button = find(refocus.dir);
    (button && !button.disabled ? button : find(refocus.dir === "up" ? "down" : "up"))?.focus();
    setRefocus(null);
  }, [refocus, busy, room]);

  const categories = room.categories;
  const uncategorized = room.channels.filter((c) => !c.category_id);
  const reorder = canReorder;

  const move = async (type: DragItem["type"], id: string, dir: "up" | "down", plan: OrderPlan) => {
    if (busy) return;
    if (await save(type, plan)) setRefocus({ id, dir });
  };

  const dragProps = (item: DragItem) =>
    reorder
      ? {
          draggable: !busy,
          onDragStart: (e: DragEvent) => {
            e.stopPropagation();
            setDrag(item);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", `${item.type}:${item.id}`);
          },
          onDragEnd: () => {
            setDrag(null);
            setOver(null);
          },
        }
      : {};
  const dropProps = (target: DropTarget) => {
    if (!reorder) return {};
    const key = dragKey(target);
    return {
      onDragOver: (e: DragEvent) => {
        if (!drag || !planDrop(room, drag, target).ok) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setOver(key);
      },
      onDragLeave: () => setOver((o) => (o === key ? null : o)),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const [type, ...rest] = (e.dataTransfer.getData("text/plain") || "").split(":");
        const item = drag ?? (type === "channel" || type === "category" ? { type, id: rest.join(":") } : null);
        setDrag(null);
        setOver(null);
        if (item && !busy) void save(item.type, planDrop(room, item, target));
      },
    } as const;
  };
  const ring = (target: DropTarget, self: boolean) => `${over === dragKey(target) && !self ? "ring-2 ring-accent" : ""}`;

  const arrow = "min-h-6 min-w-6 shrink-0 rounded text-[10px] text-fg-2 hover:bg-bg-3 hover:text-fg-0 disabled:opacity-30 aria-disabled:opacity-30 pointer-coarse:min-h-11 pointer-coarse:min-w-11";
  // Plain render functions, not components: a component defined here would remount (and drop the focus) every render.
  const arrows = (type: DragItem["type"], id: string, name: string, index: number, count: number, plan: (to: number) => OrderPlan) => (
    <span className="flex shrink-0 items-center">
      <button type="button" data-reorder="up" data-reorder-id={id} disabled={index === 0} aria-disabled={busy || undefined} onClick={() => void move(type, id, "up", plan(index - 1))} aria-label={t(type === "channel" ? "channels.reorder_up" : "channels.reorder_category_up", { name })} className={arrow}>
        ▲
      </button>
      <button type="button" data-reorder="down" data-reorder-id={id} disabled={index === count - 1} aria-disabled={busy || undefined} onClick={() => void move(type, id, "down", plan(index + 1))} aria-label={t(type === "channel" ? "channels.reorder_down" : "channels.reorder_category_down", { name })} className={arrow}>
        ▼
      </button>
    </span>
  );
  const handle = (label: string) => (
    <span role="img" aria-label={label} title={label} data-testid="reorder-handle" className={`flex w-4 shrink-0 select-none justify-center text-fg-2 ${busy ? "opacity-30" : "cursor-grab"}`}>
      <span aria-hidden="true">⋮⋮</span>
    </span>
  );

  const rows = (channels: Channel[], categoryId: string | null) => {
    const movable = channelGroup(room, categoryId);
    return (
      <ul className="mt-1 space-y-0.5">
        {channels.map((c) => {
          const fixed = isFixedChannel(c);
          const index = movable.findIndex((m) => m.id === c.id);
          const target: DropTarget = { type: "channel", id: c.id };
          const privacy = channelPrivacy(room, c.id);
          const name = channelName(c);
          return (
            <li
              key={c.id}
              data-testid="channel-tree-row"
              data-channel={c.id}
              {...(fixed ? {} : { ...dragProps({ type: "channel", id: c.id }), ...dropProps(target) })}
              className={`flex items-center gap-1 rounded-md ${ring(target, drag?.id === c.id)} ${drag?.id === c.id ? "opacity-50" : ""}`}
            >
              {reorder && (fixed ? <span className="w-4 shrink-0" /> : handle(t("channels.reorder_drag", { name })))}
              <button type="button" onClick={() => onSelectChannel(c.id)} className={`flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm ${selectedChannelId === c.id ? "bg-bg-3 text-fg-0" : "text-fg-1 hover:bg-bg-3/60"}`}>
                <span className="text-fg-2">{c.kind === "voice" ? "🔊" : c.kind === "files" ? "📁" : "#"}</span>
                <span className="truncate">{name}</span>
                {privacy && <AccessMark kind={privacy} />}
                {!c.encrypted && c.kind !== "voice" && <LockMark open />}
                {botMarker(c, room) === "no_bots" && <NoBotsIcon />}
                {botMarker(c, room) === "bots_allowed" && <BotsAllowedIcon />}
              </button>
              {reorder && !fixed && arrows("channel", c.id, name, index, movable.length, (to) => planChannelMove(room, c.id, categoryId, to))}
            </li>
          );
        })}
      </ul>
    );
  };

  const groupTarget: DropTarget = { type: "group_end", categoryId: null };
  return (
    <div ref={root} className="space-y-3" data-testid="channel-tree" aria-busy={busy}>
      {(uncategorized.length > 0 || reorder) && (
        <div data-testid="channel-tree-group" data-category="">
          <div {...dropProps(groupTarget)} className={`flex min-h-6 items-center rounded-md px-2 text-[11px] font-semibold uppercase tracking-wide text-fg-2 ${ring(groupTarget, false)}`}>
            {t("channels.uncategorized")}
          </div>
          {rows(uncategorized, null)}
        </div>
      )}
      {categories.map((cat, index) => {
        const name = categoryName(cat);
        const target: DropTarget = { type: "category", id: cat.id };
        return (
          <div key={cat.id} data-testid="channel-tree-group" data-category={cat.id} className={drag?.type === "category" && drag.id === cat.id ? "opacity-50" : ""}>
            <div {...dragProps({ type: "category", id: cat.id })} {...dropProps(target)} data-testid="channel-tree-category" data-category={cat.id} className={`flex items-center gap-1 rounded-md text-[11px] font-semibold uppercase tracking-wide text-fg-2 ${ring(target, drag?.type === "category" && drag.id === cat.id)}`}>
              {reorder && handle(t("channels.reorder_drag_category", { name }))}
              {canManageRoles ? (
                <button
                  type="button"
                  onClick={() => onSelectCategory(cat.id)}
                  aria-label={t("channels.category_permissions_open", { name })}
                  aria-pressed={selectedCategoryId === cat.id}
                  data-testid="category-permissions"
                  data-category={cat.id}
                  className={`flex min-h-9 min-w-0 flex-1 items-center gap-1 rounded-md px-2 text-left uppercase ${selectedCategoryId === cat.id ? "bg-bg-3 text-fg-0" : "hover:bg-bg-3/60 hover:text-fg-0"}`}
                >
                  <span className="truncate">{name}</span>
                  <span className="ml-auto shrink-0 text-[10px] font-normal normal-case">{t("channels.category_permissions_short")}</span>
                </button>
              ) : (
                <span className="min-w-0 flex-1 truncate px-2">{name}</span>
              )}
              {reorder && arrows("category", cat.id, name, index, categories.length, (to) => planCategoryMove(room, cat.id, to))}
              {onDeleteCategory && (
                <button type="button" aria-label={t("channels.delete_category", { name })} className="min-h-6 min-w-6 shrink-0 text-fg-2 hover:text-danger pointer-coarse:min-h-11 pointer-coarse:min-w-11" onClick={() => onDeleteCategory(cat)}>
                  ×
                </button>
              )}
            </div>
            {rows(
              room.channels.filter((c) => c.category_id === cat.id),
              cat.id,
            )}
          </div>
        );
      })}
    </div>
  );
}
