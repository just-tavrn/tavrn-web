// SPDX-License-Identifier: Apache-2.0
/**
 * A room's privacy notice and legal notice (PROTOCOL.md §6b "Room privacy notice and legal notice"): optional Markdown
 * documents that inform members and people about to join. They are never accepted (unlike the rules): the join block
 * shows a disclosure per document, the room menu and Room settings → "Privacy & legal" show them to members. Rendered
 * with the legal documents' renderer (lib/markdown.ts `renderDocument`: raw HTML escaped, no images, safe links only).
 */
import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TavrnApi } from "@tavrn/sdk";
import { renderDocument } from "../lib/markdown";
import { intlLocale, useT } from "../i18n";
import { describeError } from "../stores/toasts";
import { Button, Dialog, ErrorText } from "./ui";

export type RoomDocumentKind = "privacy" | "legal";

/** The legal documents of a room as previews carry them; older nodes leave them out. */
export interface RoomLegalTexts {
  privacy_notice?: string | null;
  privacy_notice_updated_at?: string | null;
  legal_notice?: string | null;
  legal_notice_updated_at?: string | null;
}

/** The documents a room publishes, in display order (empty ones are off). */
export function roomDocuments(texts: RoomLegalTexts): { kind: RoomDocumentKind; markdown: string; updatedAt: string | null }[] {
  const out: { kind: RoomDocumentKind; markdown: string; updatedAt: string | null }[] = [];
  if (texts.privacy_notice?.trim()) out.push({ kind: "privacy", markdown: texts.privacy_notice, updatedAt: texts.privacy_notice_updated_at ?? null });
  if (texts.legal_notice?.trim()) out.push({ kind: "legal", markdown: texts.legal_notice, updatedAt: texts.legal_notice_updated_at ?? null });
  return out;
}

export function documentTitleKey(kind: RoomDocumentKind): string {
  return kind === "privacy" ? "roomdocs.privacy" : "roomdocs.legal";
}

function updatedText(t: ReturnType<typeof useT>, at: string | null): string | null {
  if (!at) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return t("roomdocs.updated", { date: date.toLocaleDateString(intlLocale()) });
}

/** One rendered document in a scroll box (focusable, so keys scroll it), with the date of its last change. */
export function RoomDocument({ kind, markdown, updatedAt, compact = false, id }: { kind: RoomDocumentKind; markdown: string; updatedAt?: string | null; compact?: boolean; id?: string }) {
  const t = useT();
  const html = useMemo(() => renderDocument(markdown), [markdown]);
  const updated = updatedText(t, updatedAt ?? null);
  return (
    <div id={id} className="space-y-1">
      <div
        role="region"
        aria-label={t(documentTitleKey(kind))}
        tabIndex={0}
        className={`legal-doc room-rules markdown overflow-y-auto break-words rounded-md border border-line bg-bg-0 p-3 text-left text-sm leading-relaxed text-fg-1 ${compact ? "max-h-48" : "max-h-[60dvh]"}`}
        data-testid={`room-doc-${kind}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {updated && <p className="text-xs text-fg-2">{updated}</p>}
    </div>
  );
}

/**
 * The documents of a room before joining: one disclosure button per published document (`aria-expanded`), the
 * document opens below it. Nothing is rendered while the room publishes none.
 */
export function RoomLegalLinks({ texts }: { texts: RoomLegalTexts }) {
  const t = useT();
  const docs = roomDocuments(texts);
  const [open, setOpen] = useState<RoomDocumentKind | null>(null);
  const base = useId();
  if (!docs.length) return null;
  return (
    <div className="space-y-2 text-left" data-testid="room-legal-links">
      <p className="text-xs text-fg-2">{t("roomdocs.join_hint")}</p>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {docs.map((d) => (
          <button
            key={d.kind}
            type="button"
            aria-expanded={open === d.kind}
            aria-controls={`${base}-${d.kind}`}
            onClick={() => setOpen((v) => (v === d.kind ? null : d.kind))}
            className="inline-flex min-h-10 items-center gap-1 rounded-md px-1 text-sm font-medium text-accent underline underline-offset-2 hover:text-accent-hover"
            data-testid={`room-doc-link-${d.kind}`}
          >
            <span aria-hidden="true">{open === d.kind ? "▾" : "▸"}</span>
            {t(documentTitleKey(d.kind))}
          </button>
        ))}
      </div>
      {docs
        .filter((d) => d.kind === open)
        .map((d) => (
          <RoomDocument key={d.kind} id={`${base}-${d.kind}`} kind={d.kind} markdown={d.markdown} updatedAt={d.updatedAt} compact />
        ))}
    </div>
  );
}

/** A room document for members (room menu): loaded from the room preview of the hosting node. */
export function RoomDocumentDialog({ client, roomId, roomName, kind, onClose }: { client: TavrnApi; roomId: string; roomName: string; kind: RoomDocumentKind; onClose: () => void }) {
  const t = useT();
  const preview = useQuery({ queryKey: ["room-preview", client.baseUrl, roomId], queryFn: () => client.rooms.preview(roomId), staleTime: 30_000 });
  const doc = preview.data ? roomDocuments(preview.data).find((d) => d.kind === kind) : undefined;
  return (
    <Dialog title={`${t(documentTitleKey(kind))} · ${roomName}`} open onClose={onClose}>
      <div className="space-y-3" data-testid="room-doc-dialog">
        {preview.isPending && <p className="text-sm text-fg-2">{t("common.loading")}</p>}
        {preview.isError && <ErrorText>{describeError(preview.error)}</ErrorText>}
        {preview.data && (doc ? <RoomDocument kind={kind} markdown={doc.markdown} updatedAt={doc.updatedAt} /> : <p className="text-sm text-fg-2">{t("roomlegal.none")}</p>)}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
