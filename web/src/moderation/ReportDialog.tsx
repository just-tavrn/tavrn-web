// SPDX-License-Identifier: Apache-2.0
/**
 * Reporting a message, a member or a room (protocol MODERATION.md §1). For a message of an encrypted conversation
 * the reporter may release its plaintext and up to ten messages before it: the dialog shows exactly what would be
 * sent, asks for an explicit consent and lets the reporter leave context messages out. Plaintext messages need no
 * evidence: the node links them itself.
 */
import { useState } from "react";
import type { Message, TavrnApi } from "@tavrn/sdk";
import { useT } from "../i18n";
import { formatFullTime } from "../lib/format";
import { describeError, useToasts } from "../stores/toasts";
import { Button, Dialog, ErrorText, Field } from "../components/ui";
import { Select, Textarea } from "../pages/settings/common";
import { selectedEvidence, type EvidenceCandidate } from "./evidence";

export const CATEGORIES = ["spam", "harassment", "illegal", "sexual", "violence", "other"] as const;
const DETAIL_MAX = 2000;

export type ReportSubject =
  | {
      kind: "message";
      message: Message;
      encrypted: boolean;
      /** Readable messages for the evidence (oldest first, the reported one last); empty for plaintext. */
      candidates: EvidenceCandidate[];
      /** A DM or group DM on another node: the report goes to the home node, naming that node. */
      remoteNode?: string | null;
      /** Room channels: the room's name (who handles the report). */
      roomName?: string | null;
    }
  | { kind: "user"; address: string; name: string; roomId?: string | null; roomName?: string | null }
  | { kind: "room"; roomId: string; name: string };

/** Who will read the report, for the dialog's explanation. */
function audience(subject: ReportSubject, node: string, t: ReturnType<typeof useT>): string {
  const room = subject.kind === "message" ? subject.roomName : subject.kind === "user" ? subject.roomName : null;
  return room ? t("report.audience_room", { room, node }) : t("report.audience_node", { node });
}

export function ReportDialog({ subject, client, node, onClose }: { subject: ReportSubject; client: TavrnApi; node: string; onClose: () => void }) {
  const t = useT();
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("spam");
  const [detail, setDetail] = useState("");
  const [consent, setConsent] = useState(false);
  const candidates = subject.kind === "message" && subject.encrypted ? subject.candidates : [];
  const [selected, setSelected] = useState<Set<string>>(() => new Set(candidates.map((c) => c.message_id ?? "")));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = audience(subject, node, t);
  const title = subject.kind === "message" ? t("report.title_message") : subject.kind === "user" ? t("report.title_user", { name: subject.name }) : t("report.title_room", { name: subject.name });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const base = { category, detail: detail.trim() };
      const req =
        subject.kind === "message"
          ? {
              ...base,
              kind: "message",
              conversation_id: subject.message.conversation_id,
              message_id: subject.message.id,
              ...(subject.remoteNode ? { node: subject.remoteNode, user: subject.message.author } : {}),
              ...(consent && candidates.length ? { evidence: selectedEvidence(candidates, selected) } : {}),
            }
          : subject.kind === "user"
            ? { ...base, kind: "user", user: subject.address, ...(subject.roomId ? { room_id: subject.roomId } : {}) }
            : { ...base, kind: "room", room_id: subject.roomId };
      const created = await client.reports.create(req);
      useToasts.getState().push({ kind: "info", title: created.merged ? t("report.updated") : t("report.sent") });
      onClose();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={title} open onClose={onClose}>
      <form
        className="space-y-3 text-sm text-fg-1"
        data-testid="report-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-xs text-fg-2">{t("report.intro", { audience: who })}</p>
        <Field label={t("report.category")}>
          <Select value={category} onChange={(e) => setCategory(e.target.value as (typeof CATEGORIES)[number])} data-testid="report-category">
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`report.category.${c}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("report.detail")} hint={t("report.detail_hint", { count: DETAIL_MAX - detail.length })}>
          <Textarea rows={3} maxLength={DETAIL_MAX} value={detail} onChange={(e) => setDetail(e.target.value)} data-testid="report-detail" />
        </Field>
        {subject.kind === "message" && !subject.encrypted && <p className="rounded-md border border-line bg-bg-0 px-3 py-2 text-xs text-fg-2">{t("report.plaintext_linked")}</p>}
        {subject.kind === "message" && subject.encrypted && (
          <fieldset className="space-y-2 rounded-md border border-warn/50 bg-warn/5 p-3" data-testid="report-evidence">
            <legend className="px-1 text-xs font-semibold text-fg-0">{t("report.evidence.title")}</legend>
            <p className="text-xs text-fg-1">{t("report.evidence.explain", { audience: who })}</p>
            {candidates.length === 0 ? (
              <p className="text-xs text-fg-2" data-testid="report-evidence-unavailable">
                {t("report.evidence.unavailable")}
              </p>
            ) : (
              <>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="report-consent" />
                  <span>{t("report.evidence.consent")}</span>
                </label>
                {consent && (
                  <>
                    <p className="text-xs text-fg-2">{t("report.evidence.choose")}</p>
                    <ul className="max-h-60 space-y-1 overflow-y-auto" data-testid="report-evidence-list">
                      {candidates.map((c) => {
                        const id = c.message_id ?? "";
                        const on = c.reported || selected.has(id);
                        return (
                          <li key={id}>
                            <label className={`flex items-start gap-2 rounded-md px-2 py-1 ${c.reported ? "bg-warn/10" : "hover:bg-bg-3/60"}`}>
                              <input
                                type="checkbox"
                                className="mt-0.5 h-5 w-5 shrink-0"
                                checked={on}
                                disabled={c.reported}
                                aria-label={c.reported ? t("report.evidence.reported_message") : t("report.evidence.include", { author: c.author })}
                                onChange={(e) => {
                                  const next = new Set(selected);
                                  if (e.target.checked) next.add(id);
                                  else next.delete(id);
                                  setSelected(next);
                                }}
                                data-testid={c.reported ? "report-evidence-reported" : "report-evidence-context"}
                              />
                              <span className="min-w-0 flex-1 text-xs">
                                <span className="font-medium text-fg-0">{c.author}</span> <time className="text-fg-2">{formatFullTime(c.created_at)}</time>
                                {c.reported && <span className="ml-1 rounded bg-warn/20 px-1 text-[10px] font-semibold uppercase">{t("report.evidence.reported_badge")}</span>}
                                <span className="block whitespace-pre-wrap break-words text-fg-1">{c.text.length > 300 ? `${c.text.slice(0, 299)}…` : c.text}</span>
                                {c.attachments.length > 0 && <span className="block text-fg-2">📎 {c.attachments.join(", ")}</span>}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </>
            )}
          </fieldset>
        )}
        <p className="text-xs text-fg-2">{t("report.not_anonymous")}</p>
        <ErrorText>{error}</ErrorText>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="danger" disabled={busy} data-testid="report-submit">
            {busy ? t("auth.wait") : t("report.submit")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
