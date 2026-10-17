// SPDX-License-Identifier: Apache-2.0
/**
 * Room settings → "Privacy & legal" (PROTOCOL.md §6b "Room privacy notice and legal notice"): the room's optional
 * privacy notice and legal notice. Members with *Manage room* edit both (Markdown with a preview like the rules, a
 * draft template each); every other member reads what the room published. The documents inform, they are never
 * accepted.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Permission, hasPermission, parsePermissions, type RoomDetail } from "@tavrn/sdk";
import { useNode } from "../../components/NodeScope";
import { useLocale, useT } from "../../i18n";
import { describeError, toastError, useToasts } from "../../stores/toasts";
import { Button, ErrorText, Field } from "../../components/ui";
import { confirmDialog } from "../../components/Confirm";
import { RoomDocument, documentTitleKey, roomDocuments, type RoomDocumentKind } from "../../components/RoomDocuments";
import { nodeInfoQuery } from "../../lib/queries";
import { legalNoticeTemplate, privacyNoticeTemplate } from "../../lib/roomLegalTemplates";
import { Section, Textarea } from "./common";

/** The operator guide in the umbrella repository (English). */
export const ROOM_LEGAL_GUIDE = "https://github.com/just-tavrn/tavrn/blob/main/docs/room-legal.md";
export const PRIVACY_NOTICE_MAX = 20_000;
export const LEGAL_NOTICE_MAX = 5_000;

/** Shown to members: with *Manage room*, or while the room publishes a document. */
export function showsLegalTab(room: Pick<RoomDetail, "my_permissions" | "privacy_notice_updated_at" | "legal_notice_updated_at">): boolean {
  return hasPermission(parsePermissions(room.my_permissions), Permission.MANAGE_ROOM) || !!room.privacy_notice_updated_at || !!room.legal_notice_updated_at;
}

export function RoomLegalTab({ room }: { room: RoomDetail }) {
  const t = useT();
  const { api, home, domain } = useNode();
  const canManage = hasPermission(parsePermissions(room.my_permissions), Permission.MANAGE_ROOM);
  const preview = useQuery({ queryKey: ["room-preview", api.baseUrl, room.id], queryFn: () => api.rooms.preview(room.id), staleTime: 30_000 });
  if (preview.isPending) return <p className="text-sm text-fg-2">{t("common.loading")}</p>;
  if (preview.isError) return <ErrorText>{describeError(preview.error)}</ErrorText>;
  if (!canManage) {
    const docs = roomDocuments(preview.data);
    return (
      <div className="space-y-4" data-testid="room-legal-read">
        {docs.length === 0 && <p className="text-sm text-fg-2">{t("roomlegal.none")}</p>}
        {docs.map((d) => (
          <Section key={d.kind} title={t(documentTitleKey(d.kind))}>
            <RoomDocument kind={d.kind} markdown={d.markdown} updatedAt={d.updatedAt} />
          </Section>
        ))}
      </div>
    );
  }
  return <LegalEditor room={room} node={home ? null : domain} domain={domain} initial={{ privacy: preview.data.privacy_notice ?? "", legal: preview.data.legal_notice ?? "" }} />;
}

function LegalEditor({ room, node, domain, initial }: { room: RoomDetail; node: string | null; domain: string; initial: { privacy: string; legal: string } }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const { api } = useNode();
  const queryClient = useQueryClient();
  const [texts, setTexts] = useState(initial);
  const [shown, setShown] = useState<RoomDocumentKind | null>(null);
  const [busy, setBusy] = useState(false);
  // A save elsewhere (another tab, another manager) refreshes the preview: take it over while nothing was typed.
  const [base, setBase] = useState(initial);
  useEffect(() => {
    if (texts.privacy === base.privacy && texts.legal === base.legal && (initial.privacy !== base.privacy || initial.legal !== base.legal)) {
      setTexts(initial);
      setBase(initial);
    }
  }, [initial, base, texts]);
  const nodeInfo = useQuery(nodeInfoQuery(node, api));
  const nodePrivacyUrl = nodeInfo.data?.legal?.pages?.privacy ? new URL(`${api.baseUrl}/legal/privacy`, window.location.origin).href : null;
  const dirty = texts.privacy !== base.privacy || texts.legal !== base.legal;

  const loadTemplate = async (kind: RoomDocumentKind) => {
    const facts = { room: room.name, node: domain, nodePrivacyUrl };
    const draft = kind === "privacy" ? privacyNoticeTemplate(locale, facts) : legalNoticeTemplate(locale, facts);
    const current = kind === "privacy" ? texts.privacy : texts.legal;
    if (current.trim() && !(await confirmDialog({ title: t("roomlegal.template"), text: t("roomlegal.template_replace"), confirmLabel: t("roomlegal.template_confirm") }))) return;
    setTexts((v) => (kind === "privacy" ? { ...v, privacy: draft } : { ...v, legal: draft }));
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.rooms.update(room.id, { privacy_notice: texts.privacy, legal_notice: texts.legal });
      setBase(texts);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["room", room.id] }), queryClient.invalidateQueries({ queryKey: ["room-preview", api.baseUrl, room.id] })]);
      useToasts.getState().push({ kind: "info", title: t("common.saved") });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const editor = (kind: RoomDocumentKind) => {
    const value = kind === "privacy" ? texts.privacy : texts.legal;
    const max = kind === "privacy" ? PRIVACY_NOTICE_MAX : LEGAL_NOTICE_MAX;
    const updatedAt = kind === "privacy" ? room.privacy_notice_updated_at : room.legal_notice_updated_at;
    return (
      <div className="space-y-2" data-testid={`room-legal-${kind}`}>
        <Field label={t(kind === "privacy" ? "roomlegal.privacy_label" : "roomlegal.legal_label")} hint={t(kind === "privacy" ? "roomlegal.privacy_hint" : "roomlegal.legal_hint", { max: max.toLocaleString() })}>
          <Textarea value={value} onChange={(e) => setTexts((v) => (kind === "privacy" ? { ...v, privacy: e.target.value } : { ...v, legal: e.target.value }))} rows={kind === "privacy" ? 10 : 5} maxLength={max} data-testid={`room-legal-${kind}-input`} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" aria-pressed={shown === kind} onClick={() => setShown((v) => (v === kind ? null : kind))} data-testid={`room-legal-${kind}-preview`}>
            {t("settings.rules_preview")}
          </Button>
          <Button variant="ghost" onClick={() => void loadTemplate(kind)} data-testid={`room-legal-${kind}-template`}>
            {t("roomlegal.template")}
          </Button>
        </div>
        {shown === kind && (value.trim() ? <RoomDocument kind={kind} markdown={value} updatedAt={value === (kind === "privacy" ? base.privacy : base.legal) ? updatedAt : null} /> : <p className="text-xs text-fg-2">{t("roomlegal.preview_empty")}</p>)}
      </div>
    );
  };

  return (
    <form onSubmit={save} className="space-y-4">
      <Section title={t("roomlegal.title")} description={t("roomlegal.help")}>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <li>
            <a href={ROOM_LEGAL_GUIDE} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 items-center text-accent underline underline-offset-2 hover:text-accent-hover">
              {t("roomlegal.guide")}
            </a>
          </li>
          {nodePrivacyUrl && (
            <li>
              <a href={nodePrivacyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 items-center text-accent underline underline-offset-2 hover:text-accent-hover">
                {t("roomlegal.node_policy", { node: domain })}
              </a>
            </li>
          )}
        </ul>
        {editor("privacy")}
        {editor("legal")}
        <div className="flex justify-end">
          <Button type="submit" disabled={busy || !dirty} data-testid="room-legal-save">
            {t("common.save")}
          </Button>
        </div>
      </Section>
    </form>
  );
}
