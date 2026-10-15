// SPDX-License-Identifier: Apache-2.0
/**
 * "Legal & privacy" in the user settings (design note 4.14): the node's legal documents, the terms status, and the
 * notices about the user's own content with the statement of reasons and the counter-notice (DMCA §512(g), DSA
 * Art. 20).
 */
import { useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UploaderNotice } from "@tavrn/sdk";
import { api } from "../../lib/api";
import { intlLocale, useT } from "../../i18n";
import { describeError, useToasts } from "../../stores/toasts";
import { Button, Dialog, ErrorText, Field, Input } from "../../components/ui";
import { Section, Textarea } from "./common";
import { nodeInfoQuery } from "../../lib/queries";

export function LegalTab() {
  const t = useT();
  const pages = useQuery({ queryKey: ["legal", "pages", "home"], queryFn: () => api.legal.pages() });
  const node = useQuery(nodeInfoQuery(null));
  const terms = useQuery({ queryKey: ["terms-status", "tab"], queryFn: () => api.legal.termsStatus(), retry: false });
  const notices = useQuery({ queryKey: ["my-legal-notices"], queryFn: () => api.legal.myNotices(), retry: false });
  const [counter, setCounter] = useState<UploaderNotice | null>(null);
  const date = (s?: string | null) => (s ? new Date(s).toLocaleString(intlLocale()) : "");
  return (
    <div className="space-y-4">
      <Section title={t("legal.title")} description={t("legal.settings_hint")}>
        <ul className="divide-y divide-line text-sm" data-testid="settings-legal-docs">
          {pages.data?.map((d) => (
            <li key={d.kind} className="flex min-h-10 items-center justify-between gap-2">
              <Link to={`/legal/${d.kind}`} className="text-accent hover:text-accent-hover">
                {t(`legal.kind.${d.kind}`)}
              </Link>
              <span className="text-xs text-fg-2">{t("legal.version_only", { version: d.version })}</span>
            </li>
          ))}
          {pages.data?.length === 0 && <li className="py-2 text-fg-2">{t("legal.none")}</li>}
        </ul>
        {terms.data?.accepted_at && <p className="text-xs text-fg-2">{t("legal.terms.accepted_on", { version: terms.data.accepted_version ?? 0, date: date(terms.data.accepted_at) })}</p>}
        {node.data?.legal?.notices?.enabled && (
          <Link to="/legal/notice" className="inline-block text-sm text-accent hover:text-accent-hover">
            {t("legal.notice.link")}
          </Link>
        )}
      </Section>
      <Section title={t("legal.mine.title")} description={t("legal.mine.hint")}>
        {notices.isError && <ErrorText>{describeError(notices.error)}</ErrorText>}
        {notices.data?.length === 0 && <p className="text-sm text-fg-2">{t("legal.mine.none")}</p>}
        <ul className="space-y-3" data-testid="my-notices">
          {notices.data?.map((n) => (
            <li key={n.case_id} className="space-y-2 rounded-md border border-line bg-bg-0 p-3 text-sm" data-testid="my-notice">
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-xs">{n.case_id}</code>
                <span className="rounded bg-bg-3 px-1.5 text-xs">{t(`legal.state.${n.state}`)}</span>
                <span className="text-xs text-fg-2">{t(`legal.notice.basis.${n.basis}`)}</span>
              </div>
              {n.statement && (
                <div>
                  <p className="text-xs font-medium text-fg-2">{t("legal.mine.statement")}</p>
                  <p className="whitespace-pre-wrap text-fg-1" data-testid="statement-text">
                    {n.statement}
                  </p>
                </div>
              )}
              {n.can_counter && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="ghost" className="border border-line" onClick={() => setCounter(n)} data-testid="counter-open">
                    {t("legal.counter.open")}
                  </Button>
                  <span className="text-xs text-fg-2">{t("legal.counter.until", { date: date(n.counter_deadline) })}</span>
                </div>
              )}
              {n.countered && <p className="text-xs text-fg-2">{t("legal.counter.sent")}</p>}
            </li>
          ))}
        </ul>
      </Section>
      {counter && <CounterNoticeDialog notice={counter} onClose={() => setCounter(null)} />}
    </div>
  );
}

export function CounterNoticeDialog({ notice, onClose }: { notice: UploaderNotice; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [statement, setStatement] = useState("");
  const [consent, setConsent] = useState(false);
  const [signature, setSignature] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const copyright = notice.basis === "copyright";
  const ready = name.trim() && statement.trim().length >= 10 && signature.trim() && (!copyright || (consent && address.trim()));
  return (
    <Dialog title={t("legal.counter.title")} open onClose={onClose}>
      <form
        className="space-y-3 text-sm"
        data-testid="counter-dialog"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.legal.counterNotice(notice.case_id, { name, address, statement, consent, signature });
            await queryClient.invalidateQueries({ queryKey: ["my-legal-notices"] });
            useToasts.getState().push({ kind: "info", title: t("legal.counter.sent") });
            onClose();
          } catch (err) {
            setError(describeError(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-fg-1">{t("legal.counter.text")}</p>
        <Field label={t("legal.notice.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} data-testid="counter-name" />
        </Field>
        <Field label={t("legal.notice.address")} hint={copyright ? t("legal.counter.address_hint") : undefined}>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={500} data-testid="counter-address" />
        </Field>
        <Field label={t("legal.counter.statement")}>
          <Textarea rows={4} value={statement} onChange={(e) => setStatement(e.target.value)} maxLength={5000} data-testid="counter-statement" />
        </Field>
        {copyright && (
          <label className="flex items-start gap-2 text-fg-1">
            <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="counter-consent" />
            <span>{t("legal.counter.consent")}</span>
          </label>
        )}
        <Field label={t("legal.notice.signature")}>
          <Input value={signature} onChange={(e) => setSignature(e.target.value)} maxLength={200} data-testid="counter-signature" />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!ready || busy} data-testid="counter-submit">
            {t("legal.counter.submit")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
