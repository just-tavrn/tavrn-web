// SPDX-License-Identifier: Apache-2.0
/**
 * Admin "Legal" tab (design note 4.14 item 2): the designated contact for notices and the legal documents — a Markdown
 * editor with preview per kind, "Insert template" (non-binding, not legal advice), publish and unpublish. Every
 * publish is a new version; a new terms version asks every user again.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { LegalContact } from "@tavrn/sdk";
import { api } from "../../lib/api";
import { intlLocale, useLocale, useT } from "../../i18n";
import { describeError, toastError, useToasts } from "../../stores/toasts";
import { Button, ErrorText, Field, Input } from "../../components/ui";
import { Section, Select, Textarea } from "../settings/common";
import { LegalDocumentView, LEGAL_KINDS } from "../legal/LegalPages";

type Kind = (typeof LEGAL_KINDS)[number];
const TEMPLATES: Kind[] = ["imprint", "privacy", "terms"];

function ContactSection() {
  const t = useT();
  const contact = useQuery({ queryKey: ["admin", "legal", "contact"], queryFn: () => api.legal.contact() });
  const [draft, setDraft] = useState<LegalContact>({ name: "", address: "", email: "" });
  useEffect(() => {
    if (contact.data) setDraft(contact.data);
  }, [contact.data]);
  return (
    <Section title={t("admin.legal.contact")} description={t("admin.legal.contact_hint")}>
      <form
        className="grid gap-3 sm:grid-cols-3 sm:items-end"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.legal.setContact(draft);
            useToasts.getState().push({ kind: "info", title: t("common.saved") });
          } catch (err) {
            toastError(err);
          }
        }}
      >
        <Field label={t("legal.notice.name")}>
          <Input value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={200} data-testid="legal-contact-name" />
        </Field>
        <Field label={t("legal.notice.address")}>
          <Input value={draft.address ?? ""} onChange={(e) => setDraft({ ...draft, address: e.target.value })} maxLength={500} />
        </Field>
        <Field label={t("legal.notice.email")}>
          <Input type="email" value={draft.email ?? ""} onChange={(e) => setDraft({ ...draft, email: e.target.value })} maxLength={254} data-testid="legal-contact-email" />
        </Field>
        <Button type="submit" className="sm:col-span-3 sm:justify-self-start">
          {t("common.save")}
        </Button>
      </form>
    </Section>
  );
}

function DocumentEditor({ kind }: { kind: Kind }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const queryClient = useQueryClient();
  const docs = useQuery({ queryKey: ["admin", "legal", "documents"], queryFn: () => api.legal.documents() });
  const current = docs.data?.find((d) => d.kind === kind);
  const [markdown, setMarkdown] = useState("");
  const [lang, setLang] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setMarkdown(current?.markdown ?? "");
    setLang(current?.lang ?? "");
    setPreview(false);
  }, [kind, current?.version, current?.markdown, current?.lang]);
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["admin", "legal", "documents"] }), queryClient.invalidateQueries({ queryKey: ["legal"] }), queryClient.invalidateQueries({ queryKey: ["node"] })]);
  const publish = async () => {
    setBusy(true);
    try {
      const doc = await api.legal.publish(kind, markdown, lang);
      await refresh();
      useToasts.getState().push({ kind: "info", title: t("admin.legal.published", { version: doc.version }) });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const template = async () => {
    try {
      const tpl = await api.legal.template(kind, locale === "de" ? "de" : "en");
      if (markdown.trim() && !window.confirm(t("admin.legal.template_replace"))) return;
      setMarkdown(tpl.markdown);
      setPreview(false);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="space-y-3" data-testid={`legal-editor-${kind}`}>
      <p className="text-xs text-fg-2" data-testid="legal-doc-version">
        {current ? t("legal.version", { version: current.version, date: new Date(current.published_at).toLocaleString(intlLocale()) }) : t("admin.legal.unpublished")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" className="border border-line" aria-pressed={!preview} onClick={() => setPreview(false)}>
          {t("admin.legal.edit")}
        </Button>
        <Button variant="ghost" className="border border-line" aria-pressed={preview} onClick={() => setPreview(true)} data-testid="legal-preview">
          {t("admin.legal.preview")}
        </Button>
        {TEMPLATES.includes(kind) && (
          <Button variant="ghost" className="border border-line" onClick={() => void template()} data-testid="legal-template">
            {t("admin.legal.template")}
          </Button>
        )}
      </div>
      {preview ? (
        <div className="min-h-40 rounded-md border border-line bg-bg-0 p-3">
          <LegalDocumentView markdown={markdown} />
        </div>
      ) : (
        <Textarea rows={16} value={markdown} onChange={(e) => setMarkdown(e.target.value)} className="font-mono" aria-label={t(`legal.kind.${kind}`)} data-testid="legal-markdown" />
      )}
      {TEMPLATES.includes(kind) && <p className="text-xs text-warn">{t("admin.legal.template_disclaimer")}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex items-center gap-2 text-xs text-fg-2">
          {t("admin.legal.lang")}
          <Input value={lang} onChange={(e) => setLang(e.target.value)} placeholder="de" className="w-24" maxLength={35} />
        </label>
        <span className="flex-1" />
        {current && (
          <Button
            variant="ghost"
            onClick={async () => {
              if (!window.confirm(t("admin.legal.unpublish_confirm"))) return;
              try {
                await api.legal.unpublish(kind);
                await refresh();
              } catch (e) {
                toastError(e);
              }
            }}
          >
            {t("admin.legal.unpublish")}
          </Button>
        )}
        <Button onClick={() => void publish()} disabled={busy || !markdown.trim()} data-testid="legal-publish">
          {t("admin.legal.publish")}
        </Button>
      </div>
      {kind === "terms" && <p className="text-xs text-fg-2">{t("admin.legal.terms_hint")}</p>}
    </div>
  );
}

export function LegalDocumentsTab() {
  const t = useT();
  const [kind, setKind] = useState<Kind>("imprint");
  const docs = useQuery({ queryKey: ["admin", "legal", "documents"], queryFn: () => api.legal.documents() });
  return (
    <div className="space-y-4">
      <Section title={t("admin.legal.documents")} description={t("admin.legal.documents_hint")}>
        {docs.isError && <ErrorText>{describeError(docs.error)}</ErrorText>}
        <Field label={t("admin.legal.kind")}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)} data-testid="legal-kind">
            {LEGAL_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`legal.kind.${k}`)}
                {docs.data?.some((d) => d.kind === k) ? " ✓" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <DocumentEditor kind={kind} />
      </Section>
      <ContactSection />
    </div>
  );
}
