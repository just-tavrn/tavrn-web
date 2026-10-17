// SPDX-License-Identifier: Apache-2.0
/**
 * One join block for every path into a room (tavrn-web#195): the invite page, the "+" dialog's pasted link, the
 * invite list on the home page and public rooms of the home page and Discover. A room with rules shows them (compact
 * `RoomRules`) with the "I accept the rules" checkbox, which `accept_rules` follows; a room with a privacy notice or a
 * legal notice shows a link to each (information, never a second checkbox: PROTOCOL.md §6b). A room with none of
 * these is joined directly, as before.
 */
import { useState, type ReactNode } from "react";
import { TavrnApiError, type PublicRoom } from "@tavrn/sdk";
import { useT } from "../i18n";
import { describeError } from "../stores/toasts";
import { RoomIcon } from "./Avatar";
import { RoomRules } from "./RoomRules";
import { RoomLegalLinks, roomDocuments, type RoomLegalTexts } from "./RoomDocuments";
import { Button, Dialog, ErrorText } from "./ui";

/** What the join block needs: a `RoomPreview` or an `InvitePreview` (older nodes may lack the documents). */
export interface JoinInfo extends RoomLegalTexts {
  room: PublicRoom;
  rules?: string | null;
}

export function hasRules(info: Pick<JoinInfo, "rules">): boolean {
  return !!info.rules?.trim();
}

/** Rules or documents to show before the join; otherwise the room is joined directly. */
export function needsJoinDialog(info: JoinInfo): boolean {
  return hasRules(info) || roomDocuments(info).length > 0;
}

/**
 * The inner block: the room's head (icon, name, members and the node; `head={false}` for the invite page, which
 * shows its own large head), the rules with the checkbox and the document links.
 */
export function RoomJoinBlock({ info, node, accepted, onAcceptedChange, head = true, page = false }: { info: JoinInfo; node: string | null; accepted: boolean; onAcceptedChange: (v: boolean) => void; head?: boolean; page?: boolean }) {
  const t = useT();
  return (
    <div className="space-y-3" data-testid="join-block">
      {head && (
        <div className="flex items-center gap-3">
          <RoomIcon room={info.room} size={40} node={node} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium" data-testid="join-preview-name">
              {info.room.name}
            </p>
            <p className="truncate text-xs text-fg-2">
              {t("invite.members", { count: info.room.member_count })}
              {node ? ` · ${node}` : ""}
            </p>
          </div>
        </div>
      )}
      {hasRules(info) && (
        <div className={page ? "rounded-md border border-line bg-bg-0 p-3 text-left text-sm" : "space-y-2"}>
          {page && <p className="mb-1 font-medium">{t("invite.rules")}</p>}
          <RoomRules markdown={info.rules ?? ""} compact={!page} />
          <label className={`flex min-h-10 items-center gap-2 text-sm ${page ? "mt-3" : ""}`}>
            <input type="checkbox" checked={accepted} onChange={(e) => onAcceptedChange(e.target.checked)} className="h-5 w-5" data-testid="accept-rules" /> {t("invite.accept_rules")}
          </label>
        </div>
      )}
      <RoomLegalLinks texts={info} />
    </div>
  );
}

/** The modal of the invite list and the public room lists: the block with Join and Cancel. */
export function JoinRoomDialog({ info, node, onJoin, onClose }: { info: JoinInfo; node: string | null; onJoin: (acceptRules: boolean) => Promise<void>; onClose: () => void }) {
  const t = useT();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      await onJoin(accepted);
    } catch (e) {
      setError(describeError(e) || t("invite.failed"));
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("joinroom.title", { name: info.room.name })} open onClose={onClose}>
      <form
        className="space-y-3"
        data-testid="join-room-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void join();
        }}
      >
        <RoomJoinBlock info={info} node={node} accepted={accepted} onAcceptedChange={setAccepted} />
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy || (hasRules(info) && !accepted)} data-testid="join-room-submit">
            {t("invite.join")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * A node without the room preview route (older nodes): `404` with another code than the room's or the invite's own,
 * or `405`. Such a room is joined without a preview; a refusal for rules is shown as the error.
 */
function previewUnavailable(e: unknown): boolean {
  if (!(e instanceof TavrnApiError)) return false;
  if (e.status === 405) return true;
  return e.status === 404 && !/^(room|invite)\./.test(e.code ?? "");
}

export interface JoinFlow {
  /**
   * Loads the room's preview (`load`) and either joins directly (`join(false)`, nothing to show) or opens the dialog,
   * whose Join button calls `join(acceptRules)`. Resolves once the direct join is done or the dialog is open; errors of
   * the preview and of a direct join are thrown (the dialog shows its own). A direct join refused for rules (rules
   * added meanwhile) loads the preview again and opens the dialog.
   */
  start: (load: () => Promise<JoinInfo>, join: (acceptRules: boolean) => Promise<void>, node: string | null) => Promise<void>;
  /** The dialog while one is open. */
  overlay: ReactNode;
}

export function useJoinFlow(): JoinFlow {
  const [pending, setPending] = useState<{ info: JoinInfo; node: string | null; join: (acceptRules: boolean) => Promise<void> } | null>(null);
  const start: JoinFlow["start"] = async (load, join, node) => {
    const preview = async (): Promise<JoinInfo | null> => {
      try {
        return await load();
      } catch (e) {
        if (previewUnavailable(e)) return null;
        throw e;
      }
    };
    const info = await preview();
    if (info && needsJoinDialog(info)) {
      setPending({ info, node, join });
      return;
    }
    try {
      await join(false);
    } catch (e) {
      if (!(e instanceof TavrnApiError && e.code === "room.rules_not_accepted") || !info) throw e;
      const again = await preview();
      if (!again || !needsJoinDialog(again)) throw e;
      setPending({ info: again, node, join });
    }
  };
  const overlay = pending && (
    <JoinRoomDialog
      info={pending.info}
      node={pending.node}
      onJoin={async (acceptRules) => {
        await pending.join(acceptRules);
        setPending(null);
      }}
      onClose={() => setPending(null)}
    />
  );
  return { start, overlay };
}
