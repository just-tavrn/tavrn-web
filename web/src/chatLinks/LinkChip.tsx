// SPDX-License-Identifier: Apache-2.0
/**
 * The content of a tavrn link chip in a message (PROTOCOL.md §7h): icon and name of the channel, room, invite, message
 * or file. Names come from the client's caches first (the room detail every room view shares), otherwise from the
 * hosting node with the viewer's own session; the node's answer decides what the viewer sees: without access (not a
 * member, no `view_channel`, no right in the files channel, deleted) the chip is a neutral "Private channel" / "File
 * not available", never a name the viewer cannot see. Only nodes the client already talks to are asked (the parser
 * recognises no others). Decryption of file records happens locally, like in the files channel.
 */
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { qualify } from "@tavrn/e2ee";
import type { FileEntry, RoomDetail } from "@tavrn/sdk";
import { useT } from "../i18n";
import { apiFor } from "../stores/nodes";
import { useUnread } from "../stores/unread";
import { getMls } from "../stores/mls";
import { useHiddenChannels } from "../lib/hiddenChannels";
import { channelName } from "../lib/names";
import { formatBytes } from "../files/model";
import { decryptRecords } from "../files/e2ee";
import { RoomIcon } from "../components/Avatar";
import { AnnouncementIcon, FolderIcon, ForumIcon, HashIcon, LockIcon, SparkleIcon } from "../components/icons";
import { SpeakerIcon } from "../voice/ui/icons";
import type { TavrnLinkKind } from "../lib/tavrnLinks";
import { useChatLinks } from "./context";

/** A chip's target as the markdown pass wrote it into the anchor's data attributes. */
export interface ChipTarget {
  kind: TavrnLinkKind;
  node: string;
  room?: string;
  channel?: string;
  /** Message id, file id or invite code. */
  target?: string;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CODE = /^[A-Za-z0-9_-]{4,64}$/;
const KINDS: readonly TavrnLinkKind[] = ["room", "channel", "message", "file", "invite"];

/** Reads (and checks again) the target of an `a.tavrn-chip`; null for anything malformed. */
export function chipTarget(a: HTMLElement): ChipTarget | null {
  const kind = a.dataset.tavrnLink as TavrnLinkKind | undefined;
  const node = a.dataset.node ?? "";
  if (!kind || !KINDS.includes(kind) || !node) return null;
  const { room, channel, target } = a.dataset;
  if (kind === "invite") return target && CODE.test(target) ? { kind, node, target } : null;
  if (!room || !ULID.test(room)) return null;
  if (kind === "room") return { kind, node, room };
  if (!channel || !ULID.test(channel)) return null;
  if (kind === "channel") return { kind, node, room, channel };
  return target && ULID.test(target) ? { kind, node, room, channel, target } : null;
}

/** The room detail of a link's room: the shared room cache, else the hosting node (403/404: no access). */
function useLinkRoom(node: string, roomId: string) {
  return useQuery({
    queryKey: ["room", roomId],
    queryFn: async (): Promise<RoomDetail> => {
      const room = await apiFor(node).rooms.get(roomId);
      useUnread.getState().seed(room.read_states ?? []);
      return room;
    },
    retry: false,
    staleTime: 60_000,
  });
}

const ICON_CLASS = "tavrn-chip-icon";

function KindIcon({ kind }: { kind: string }) {
  const Icon = kind === "voice" ? SpeakerIcon : kind === "announcement" ? AnnouncementIcon : kind === "forum" ? ForumIcon : kind === "files" ? FolderIcon : kind === "system" ? SparkleIcon : HashIcon;
  return <Icon size={14} className={ICON_CLASS} data-icon={kind} />;
}

/** The chip's inside: an icon, the (screen-reader) kind and the label; `state` styles loading and private chips. */
function Chip({ icon, kind, label, state = "ok", extra }: { icon: ReactNode; kind: string; label: string; state?: "ok" | "loading" | "private"; extra?: ReactNode }) {
  return (
    <span className="tavrn-chip-body" data-state={state} data-testid="tavrn-chip-body">
      <span aria-hidden="true" className="inline-flex">
        {icon}
      </span>
      <span className="sr-only">{`${kind}:`}</span>{" "}
      <span className="tavrn-chip-label">{label}</span>
      {extra}
    </span>
  );
}

function ChannelChip({ node, room: roomId, channel: channelId, message }: { node: string; room: string; channel: string; message: boolean }) {
  const t = useT();
  const here = useChatLinks().room?.id;
  const room = useLinkRoom(node, roomId);
  const hidden = useHiddenChannels((s) => s.ids[channelId] === true);
  const kind = t(message ? "links.kind.message" : "links.kind.channel");
  if (room.isPending) return <Chip icon={<HashIcon size={14} className={ICON_CLASS} />} kind={kind} label={t("links.loading")} state="loading" />;
  const channel = !hidden ? room.data?.channels.find((c) => c.id === channelId) : undefined;
  if (!channel) return <Chip icon={<LockIcon size={14} className={ICON_CLASS} />} kind={kind} label={t(message ? "links.message_private" : "links.channel_private")} state="private" />;
  const name = channelName(channel);
  const where = roomId !== here && room.data ? ` · ${room.data.name}` : "";
  return <Chip icon={<KindIcon kind={channel.kind} />} kind={kind} label={message ? t("links.message_in", { channel: `${name}${where}` }) : `${name}${where}`} />;
}

function RoomChip({ node, room: roomId }: { node: string; room: string }) {
  const t = useT();
  const room = useLinkRoom(node, roomId);
  const kind = t("links.kind.room");
  if (room.isPending) return <Chip icon={<HashIcon size={14} className={ICON_CLASS} />} kind={kind} label={t("links.loading")} state="loading" />;
  if (!room.data) return <Chip icon={<LockIcon size={14} className={ICON_CLASS} />} kind={kind} label={t("links.room_private")} state="private" />;
  return <Chip icon={<RoomIcon room={room.data} size={16} node={node} />} kind={kind} label={room.data.name} />;
}

function InviteChip({ node, code }: { node: string; code: string }) {
  const t = useT();
  // The same query as the invite page (which reaches other nodes through their federated session).
  const preview = useQuery({ queryKey: ["invite", code, node], queryFn: () => apiFor(node).invites.preview(code), retry: false, staleTime: 60_000 });
  const kind = t("links.kind.invite");
  if (preview.isPending) return <Chip icon={<HashIcon size={14} className={ICON_CLASS} />} kind={kind} label={t("links.loading")} state="loading" />;
  if (!preview.data) return <Chip icon={<LockIcon size={14} className={ICON_CLASS} />} kind={kind} label={t("links.invite_unavailable")} state="private" />;
  return (
    <Chip
      icon={<RoomIcon room={preview.data.room} size={16} node={node} />}
      kind={kind}
      label={preview.data.room.name}
      extra={
        <span className="tavrn-chip-action" data-testid="tavrn-chip-join">
          {t("links.invite_join")}
        </span>
      }
    />
  );
}

interface FileInfo {
  name: string | null;
  size: number | null;
  folder: boolean;
}

function FileChip({ node, room, channel, file }: { node: string; room: string; channel: string; file: string }) {
  const t = useT();
  const info = useQuery({
    queryKey: ["file-link", node, channel, file],
    queryFn: async (): Promise<FileInfo> => {
      const { entry } = await apiFor(node).files.get(room, channel, file);
      const folder = entry.kind === "folder";
      if (!entry.record) return { name: entry.name || null, size: folder ? null : entry.size, folder };
      // An end-to-end encrypted channel (FILES.md §8): the record is decrypted here, with the channel's group.
      const mls = await getMls().catch(() => null);
      const result = mls ? (await decryptRecords(mls, qualify(node, channel), [entry as FileEntry])).get(entry.id) : undefined;
      return result?.ok ? { name: result.record.name, size: folder ? null : result.record.size, folder } : { name: null, size: null, folder };
    },
    retry: false,
    staleTime: 60_000,
  });
  const kind = t("links.kind.file");
  if (info.isPending) return <Chip icon={<span className={ICON_CLASS}>📄</span>} kind={kind} label={t("links.loading")} state="loading" />;
  if (!info.data) return <Chip icon={<LockIcon size={14} className={ICON_CLASS} />} kind={kind} label={t("links.file_unavailable")} state="private" />;
  const { name, size, folder } = info.data;
  return (
    <Chip
      icon={folder ? <FolderIcon size={14} className={ICON_CLASS} /> : <span className={ICON_CLASS}>📄</span>}
      kind={kind}
      label={name ?? t("links.file_encrypted")}
      extra={size !== null ? <span className="tavrn-chip-meta">{formatBytes(size)}</span> : undefined}
    />
  );
}

/** The chip for `target` (rendered into the anchor through a portal). */
export function LinkChip({ target }: { target: ChipTarget }) {
  switch (target.kind) {
    case "channel":
      return <ChannelChip node={target.node} room={target.room!} channel={target.channel!} message={false} />;
    case "message":
      return <ChannelChip node={target.node} room={target.room!} channel={target.channel!} message />;
    case "room":
      return <RoomChip node={target.node} room={target.room!} />;
    case "invite":
      return <InviteChip node={target.node} code={target.target!} />;
    case "file":
      return <FileChip node={target.node} room={target.room!} channel={target.channel!} file={target.target!} />;
    default:
      return null;
  }
}
