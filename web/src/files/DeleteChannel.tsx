// SPDX-License-Identifier: Apache-2.0
/**
 * What deleting a files channel (or a room with files channels) does to the files (FILES.md §9): the counts and the
 * place from `GET …/files/usage`, and the consequence. Files on this node are deleted at once; objects on an external
 * store are deleted from it in the background, unless the user keeps them, which is offered only for unencrypted
 * external channels (encrypted objects are unreadable without the channel's keys and always go).
 */
import { useQuery } from "@tanstack/react-query";
import type { Channel, FilesInfo, RoomDetail } from "@tavrn/sdk";
import { useT } from "../i18n";
import { useNode } from "../components/NodeScope";
import { formatBytes } from "./model";

export type DeletionCase = "internal" | "external_plain" | "external_encrypted";

/** The case of the dialog for a channel's usage. */
export function deletionCase(info: Pick<FilesInfo, "backend" | "encrypted">): DeletionCase {
  // `none` (no store yet, FILES.md §5): anything left is on the node.
  if (info.backend === "internal" || info.backend === "none") return "internal";
  return info.encrypted ? "external_encrypted" : "external_plain";
}

/** The text block for one files channel: counts, place, consequence (and the keep option where it applies). */
export function FilesDeletionFacts({ name, info, keep, onKeep }: { name?: string; info: FilesInfo; keep: boolean; onKeep?: (keep: boolean) => void }) {
  const t = useT();
  const c = deletionCase(info);
  const where = c === "internal" ? t("files.delete_where_node") : t("files.delete_where_external", { kind: t(`files.backend.${info.backend}`), host: info.backend_host || "?" });
  return (
    <div className="space-y-1.5 rounded-md border border-line bg-bg-1 p-2 text-sm" data-testid="files-deletion-facts" data-case={c}>
      {name && <p className="font-medium text-fg-0">{name}</p>}
      <p data-testid="files-deletion-counts">{t("files.delete_counts", { files: info.files, folders: info.folders, size: formatBytes(info.used_bytes) })}</p>
      <p>{where}</p>
      {c === "internal" && <p className="text-danger">{t("files.delete_internal")}</p>}
      {(c === "external_encrypted" || (c === "external_plain" && !keep)) && <p className="text-danger">{t("files.delete_external", { prefix: info.backend_prefix || "" })}</p>}
      {c === "external_encrypted" && <p className="text-fg-2">{t("files.delete_external_encrypted")}</p>}
      {c === "external_plain" && onKeep && (
        <label className="flex min-h-10 items-center gap-2">
          <input type="checkbox" className="h-6 w-6 accent-accent" checked={keep} onChange={(e) => onKeep(e.target.checked)} data-testid="files-keep-external" />
          {t("files.delete_keep_external")}
        </label>
      )}
      {c === "external_plain" && keep && <p className="text-fg-2">{t("files.delete_kept", { prefix: info.backend_prefix || "" })}</p>}
    </div>
  );
}

/** The usage of the files channels of a room (for the room deletion dialog); only for members who may see it. */
export function useFilesChannelsUsage(room: RoomDetail, enabled: boolean) {
  const { api, domain } = useNode();
  const files = room.channels.filter((c) => c.kind === "files");
  return useQuery({
    queryKey: ["files-usage-all", domain, room.id, files.map((c) => c.id).join(",")],
    queryFn: async () => {
      const out: { channel: Channel; info: FilesInfo }[] = [];
      for (const channel of files) {
        try {
          out.push({ channel, info: await api.files.usage(room.id, channel.id) });
        } catch {
          /* channels the user cannot see are left out */
        }
      }
      return out;
    },
    enabled: enabled && files.length > 0,
  });
}
