// SPDX-License-Identifier: Apache-2.0
/**
 * Handing a room to another member (protocol MODERATION.md §4): the owner picks a member (people of the room's own
 * node, no bots) and confirms; the node asks for a fresh proof of the owner's credentials (reauth dialog). Used in
 * the room settings overview and in the account deletion dialog, which refuses accounts that still own rooms.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isBotKind, TavrnApiError, type RoomDetail, type TavrnApi } from "@tavrn/sdk";
import { useT } from "../i18n";
import { useNode } from "../components/NodeScope";
import { describeError, useToasts } from "../stores/toasts";
import { Button, Dialog, ErrorText, Field } from "../components/ui";
import { Section, Select } from "../pages/settings/common";

export function TransferDialog({ client, roomId, roomName, domain, meId, onClose, onDone }: { client: TavrnApi; roomId: string; roomName: string; domain: string; meId: string | undefined; onClose: () => void; onDone?: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const members = useQuery({ queryKey: ["members", roomId], queryFn: () => client.members.list(roomId, { limit: 1000 }) });
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = (members.data ?? []).filter((m) => m.user.id !== meId && !isBotKind(m.user.kind) && m.user.domain === domain);
  const chosen = candidates.find((m) => m.user.id === target);
  const submit = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await client.rooms.transfer(roomId, chosen.user.id);
      await queryClient.invalidateQueries({ queryKey: ["room", roomId] });
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
      useToasts.getState().push({ kind: "info", title: t("transfer.done", { room: roomName, name: chosen.user.display_name }) });
      onDone?.();
      onClose();
    } catch (e) {
      // A cancelled reauth dialog is no error to show.
      if (!(e instanceof TavrnApiError && e.code === "auth.reauth_required")) setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("transfer.title", { room: roomName })} open onClose={onClose}>
      <div className="space-y-3 text-sm text-fg-1" data-testid="transfer-dialog">
        <p>{t("transfer.text")}</p>
        {members.isPending && <p className="text-fg-2">{t("common.loading")}</p>}
        {members.data && candidates.length === 0 && <p className="text-fg-2" data-testid="transfer-nobody">{t("transfer.nobody")}</p>}
        {candidates.length > 0 && (
          <Field label={t("transfer.new_owner")}>
            <Select value={target} onChange={(e) => setTarget(e.target.value)} data-testid="transfer-target">
              <option value="">{t("transfer.choose")}</option>
              {candidates.map((m) => (
                <option key={m.user.id} value={m.user.id}>
                  {m.nickname || m.user.display_name} ({m.user.address})
                </option>
              ))}
            </Select>
          </Field>
        )}
        {chosen && <p className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-xs">{t("transfer.warning", { name: chosen.user.display_name })}</p>}
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" disabled={!chosen || busy} onClick={() => void submit()} data-testid="transfer-confirm">
            {busy ? t("auth.wait") : t("transfer.confirm")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Room settings → Overview: the owner's "Transfer ownership" section. */
export function TransferSection({ room }: { room: RoomDetail }) {
  const t = useT();
  const { api, me, domain } = useNode();
  const [open, setOpen] = useState(false);
  if (!room.is_owner) return null;
  return (
    <Section title={t("transfer.section")} description={t("transfer.section_hint")}>
      <Button variant="ghost" onClick={() => setOpen(true)} data-testid="transfer-open">
        {t("transfer.open")}
      </Button>
      {open && <TransferDialog client={api} roomId={room.id} roomName={room.name} domain={domain} meId={me?.id} onClose={() => setOpen(false)} />}
    </Section>
  );
}
