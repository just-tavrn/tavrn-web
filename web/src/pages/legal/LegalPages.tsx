// SPDX-License-Identifier: Apache-2.0
/**
 * Public legal pages (design note 4.14, tavrn-protocol/LEGAL.md): the overview `/legal` (every document within two clicks of
 * every screen), a document `/legal/<kind>` rendered with the message sanitizer, the takedown form `/legal/notice`
 * and the reporter's status page `/legal/notice/<case>?token=`. They work signed out.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router";
import type { NoticeRequest } from "@tavrn/sdk";
import { publicApi } from "../../lib/api";
import { renderDocument } from "../../lib/markdown";
import { intlLocale, useT } from "../../i18n";
import { describeError } from "../../stores/toasts";
import { Button, ErrorText, Field, Input } from "../../components/ui";
import { Select, Textarea } from "../settings/common";
import { Captcha } from "../../components/Captcha";
import { LocaleSwitch } from "../../components/LocaleSwitch";

export const LEGAL_KINDS = ["imprint", "privacy", "terms", "cookies"] as const;

/** Frame of the public legal pages: node name, links back to the app and to the overview. */
export function LegalShell({ title, children }: { title: string; children: ReactNode }) {
  const t = useT();
  const node = useQuery({ queryKey: ["node", "origin"], queryFn: () => publicApi.node.info() });
  return (
    <div className="min-h-full bg-bg-2">
      <div className="brand-line" aria-hidden="true" />
      <div className="mx-auto max-w-3xl px-4 py-6">
        <nav className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-2" aria-label={t("legal.nav")}>
          <Link to="/" className="text-accent hover:text-accent-hover">
            {node.data ? node.data.name : t("legal.back")}
          </Link>
          <span aria-hidden="true">·</span>
          <Link to="/legal" className="hover:text-fg-0">
            {t("legal.title")}
          </Link>
          <span className="flex-1" />
          <LocaleSwitch />
        </nav>
        <h1 className="mt-4 text-xl font-semibold">{title}</h1>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

/** `/legal`: the published documents and the notice form. */
export function LegalIndexPage() {
  const t = useT();
  const pages = useQuery({ queryKey: ["legal", "pages"], queryFn: () => publicApi.legal.pages() });
  const node = useQuery({ queryKey: ["node", "origin"], queryFn: () => publicApi.node.info() });
  const notices = node.data?.legal?.notices;
  return (
    <LegalShell title={t("legal.title")}>
      {pages.isError && <ErrorText>{describeError(pages.error)}</ErrorText>}
      <ul className="divide-y divide-line rounded-lg border border-line bg-bg-1" data-testid="legal-index">
        {pages.data?.map((d) => (
          <li key={d.kind}>
            <Link to={`/legal/${d.kind}`} className="flex min-h-12 items-center justify-between gap-3 px-4 text-sm hover:bg-bg-3/60">
              <span className="font-medium">{t(`legal.kind.${d.kind}`)}</span>
              <span className="text-xs text-fg-2">{t("legal.version", { version: d.version, date: new Date(d.published_at).toLocaleDateString(intlLocale()) })}</span>
            </Link>
          </li>
        ))}
        {notices?.enabled && (
          <li>
            <Link to="/legal/notice" className="flex min-h-12 items-center px-4 text-sm hover:bg-bg-3/60" data-testid="legal-notice-link">
              <span className="font-medium">{t("legal.notice.link")}</span>
            </Link>
          </li>
        )}
        {pages.data?.length === 0 && !notices?.enabled && <li className="px-4 py-3 text-sm text-fg-2">{t("legal.none")}</li>}
      </ul>
      {notices?.contact && (
        <p className="mt-4 whitespace-pre-line text-xs text-fg-2" data-testid="legal-contact">
          {t("legal.contact")}: {[notices.contact.name, notices.contact.address, notices.contact.email].filter(Boolean).join(" · ")}
        </p>
      )}
    </LegalShell>
  );
}

/** A rendered legal document (`.legal-doc` styles headings, lists and tables). */
export function LegalDocumentView({ markdown }: { markdown: string }) {
  const html = useMemo(() => renderDocument(markdown), [markdown]);
  return <article className="legal-doc markdown text-sm leading-relaxed text-fg-1" data-testid="legal-document" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** `/legal/<kind>`. */
export function LegalDocumentPage() {
  const t = useT();
  const { kind = "" } = useParams();
  const doc = useQuery({ queryKey: ["legal", "page", kind], queryFn: () => publicApi.legal.page(kind), retry: false, enabled: (LEGAL_KINDS as readonly string[]).includes(kind) });
  const title = (LEGAL_KINDS as readonly string[]).includes(kind) ? t(`legal.kind.${kind}`) : t("legal.title");
  return (
    <LegalShell title={title}>
      {doc.isPending && doc.fetchStatus !== "idle" && <p className="text-sm text-fg-2">{t("common.loading")}</p>}
      {(doc.isError || doc.fetchStatus === "idle") && <p className="text-sm text-fg-2">{t("legal.not_published")}</p>}
      {doc.data && (
        <>
          <div lang={doc.data.lang || undefined}>
            <LegalDocumentView markdown={doc.data.markdown} />
          </div>
          <p className="mt-6 text-xs text-fg-2">{t("legal.version", { version: doc.data.version, date: new Date(doc.data.published_at).toLocaleDateString(intlLocale()) })}</p>
        </>
      )}
    </LegalShell>
  );
}

type LocationKind = "message" | "attachment" | "room" | "profile" | "other";
const LOCATION_KINDS: LocationKind[] = ["message", "attachment", "room", "profile", "other"];
type Basis = "copyright" | "illegal" | "terms";

/** Fields of the notice form as the user types them; {@link noticeRequest} builds the request. */
export interface NoticeDraft {
  basis: Basis;
  name: string;
  email: string;
  address: string;
  phone: string;
  work: string;
  explanation: string;
  locations: { kind: LocationKind; value: string }[];
  goodFaith: boolean;
  accuracy: boolean;
  perjury: boolean;
  signature: string;
}

export const EMPTY_DRAFT: NoticeDraft = { basis: "copyright", name: "", email: "", address: "", phone: "", work: "", explanation: "", locations: [{ kind: "message", value: "" }], goodFaith: false, accuracy: false, perjury: false, signature: "" };

/** The request of a draft, or the i18n key of the first problem. The perjury statement only counts for copyright. */
export function noticeRequest(d: NoticeDraft, captcha: string | null): { ok: true; req: NoticeRequest } | { ok: false; error: string } {
  const locations = d.locations.map((l) => ({ kind: l.kind, value: l.value.trim() })).filter((l) => l.value);
  if (!d.name.trim() || !d.email.trim()) return { ok: false, error: "legal.notice.err_contact" };
  if (!d.work.trim()) return { ok: false, error: "legal.notice.err_work" };
  if (d.basis !== "copyright" && !d.explanation.trim()) return { ok: false, error: "legal.notice.err_explanation" };
  if (!locations.length) return { ok: false, error: "legal.notice.err_locations" };
  if (!d.goodFaith || !d.accuracy || (d.basis === "copyright" && !d.perjury)) return { ok: false, error: "legal.notice.err_statements" };
  if (!d.signature.trim()) return { ok: false, error: "legal.notice.err_signature" };
  return {
    ok: true,
    req: {
      basis: d.basis,
      reporter_name: d.name.trim(),
      reporter_email: d.email.trim(),
      reporter_address: d.address.trim(),
      reporter_phone: d.phone.trim(),
      work: d.work.trim(),
      explanation: d.explanation.trim(),
      locations,
      good_faith: d.goodFaith,
      accuracy: d.accuracy,
      perjury: d.basis === "copyright" && d.perjury,
      signature: d.signature.trim(),
      captcha_token: captcha,
    },
  };
}

function Check({ checked, onChange, children, testId }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; testId: string }) {
  return (
    <label className="flex items-start gap-2 text-sm text-fg-1">
      <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span>{children}</span>
    </label>
  );
}

/** `/legal/notice`: the takedown form (DMCA §512(c)(3), DSA Art. 16) and its confirmation. */
export function NoticeFormPage() {
  const t = useT();
  const [params] = useSearchParams();
  const node = useQuery({ queryKey: ["node", "origin"], queryFn: () => publicApi.node.info() });
  const [draft, setDraft] = useState<NoticeDraft>(() => ({ ...EMPTY_DRAFT, locations: [{ kind: "message", value: params.get("location") ?? "" }] }));
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const set = (patch: Partial<NoticeDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const captchaInfo = node.data?.captcha ?? null;
  const enabled = node.data?.legal?.notices?.enabled;

  if (done) {
    return (
      <LegalShell title={t("legal.notice.title")}>
        <div role="status" className="space-y-2 rounded-lg border border-line bg-bg-1 p-4 text-sm" data-testid="notice-confirmation">
          <p className="font-medium text-ok">{t("legal.notice.received")}</p>
          <p>
            {t("legal.notice.case")}: <code data-testid="notice-case-id">{done}</code>
          </p>
          <p className="text-fg-2">{t("legal.notice.received_hint")}</p>
        </div>
      </LegalShell>
    );
  }
  if (node.data && !enabled) {
    return (
      <LegalShell title={t("legal.notice.title")}>
        <p className="text-sm text-fg-2">{t("legal.notice.disabled")}</p>
      </LegalShell>
    );
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const built = noticeRequest(draft, captcha);
    if (!built.ok) return setError(t(built.error));
    if (captchaInfo && !captcha) return setError(t("auth.captcha_required"));
    setBusy(true);
    try {
      const created = await publicApi.legal.submitNotice(built.req);
      setDone(created.case_id);
    } catch (err) {
      setError(describeError(err));
      if (captchaInfo) setCaptchaReset((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };
  const contact = node.data?.legal?.notices?.contact;
  return (
    <LegalShell title={t("legal.notice.title")}>
      <p className="text-sm text-fg-2">{t("legal.notice.intro")}</p>
      {contact && <p className="mt-2 text-xs text-fg-2">{t("legal.contact")}: {[contact.name, contact.address, contact.email].filter(Boolean).join(" · ")}</p>}
      <form onSubmit={submit} className="mt-4 space-y-4" data-testid="notice-form" noValidate>
        <Field label={t("legal.notice.basis")}>
          <Select value={draft.basis} onChange={(e) => set({ basis: e.target.value as Basis })} data-testid="notice-basis">
            {(["copyright", "illegal", "terms"] as Basis[]).map((b) => (
              <option key={b} value={b}>
                {t(`legal.notice.basis.${b}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("legal.notice.work")} hint={t(draft.basis === "copyright" ? "legal.notice.work_hint_copyright" : "legal.notice.work_hint")}>
          <Textarea rows={3} value={draft.work} onChange={(e) => set({ work: e.target.value })} maxLength={5000} data-testid="notice-work" />
        </Field>
        {draft.basis !== "copyright" && (
          <Field label={t("legal.notice.explanation")}>
            <Textarea rows={3} value={draft.explanation} onChange={(e) => set({ explanation: e.target.value })} maxLength={5000} data-testid="notice-explanation" />
          </Field>
        )}
        <fieldset className="space-y-2">
          <legend className="text-sm text-fg-1">{t("legal.notice.locations")}</legend>
          <p className="text-xs text-fg-2">{t("legal.notice.locations_hint")}</p>
          {draft.locations.map((l, i) => (
            <div key={i} className="flex flex-col gap-2 sm:flex-row">
              <Select className="sm:w-40" value={l.kind} aria-label={t("legal.notice.location_kind")} onChange={(e) => set({ locations: draft.locations.map((x, j) => (j === i ? { ...x, kind: e.target.value as LocationKind } : x)) })}>
                {LOCATION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`legal.notice.location.${k}`)}
                  </option>
                ))}
              </Select>
              <Input value={l.value} maxLength={500} aria-label={t("legal.notice.location_value")} onChange={(e) => set({ locations: draft.locations.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} data-testid="notice-location" />
              {draft.locations.length > 1 && (
                <Button variant="ghost" aria-label={t("common.delete")} onClick={() => set({ locations: draft.locations.filter((_, j) => j !== i) })}>
                  ✕
                </Button>
              )}
            </div>
          ))}
          {draft.locations.length < 20 && (
            <Button variant="ghost" onClick={() => set({ locations: [...draft.locations, { kind: "message", value: "" }] })}>
              {t("legal.notice.add_location")}
            </Button>
          )}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("legal.notice.name")}>
            <Input value={draft.name} autoComplete="name" maxLength={200} onChange={(e) => set({ name: e.target.value })} data-testid="notice-name" />
          </Field>
          <Field label={t("legal.notice.email")}>
            <Input type="email" value={draft.email} autoComplete="email" maxLength={254} onChange={(e) => set({ email: e.target.value })} data-testid="notice-email" />
          </Field>
          <Field label={t("legal.notice.address")}>
            <Input value={draft.address} autoComplete="street-address" maxLength={500} onChange={(e) => set({ address: e.target.value })} />
          </Field>
          <Field label={t("legal.notice.phone")}>
            <Input value={draft.phone} autoComplete="tel" maxLength={50} onChange={(e) => set({ phone: e.target.value })} />
          </Field>
        </div>
        <div className="space-y-2 rounded-lg border border-line bg-bg-1 p-3">
          <Check checked={draft.goodFaith} onChange={(v) => set({ goodFaith: v })} testId="notice-good-faith">
            {t(draft.basis === "copyright" ? "legal.notice.good_faith_copyright" : "legal.notice.good_faith")}
          </Check>
          <Check checked={draft.accuracy} onChange={(v) => set({ accuracy: v })} testId="notice-accuracy">
            {t("legal.notice.accuracy")}
          </Check>
          {draft.basis === "copyright" && (
            <Check checked={draft.perjury} onChange={(v) => set({ perjury: v })} testId="notice-perjury">
              {t("legal.notice.perjury")}
            </Check>
          )}
        </div>
        <Field label={t("legal.notice.signature")} hint={t("legal.notice.signature_hint")}>
          <Input value={draft.signature} maxLength={200} onChange={(e) => set({ signature: e.target.value })} data-testid="notice-signature" />
        </Field>
        <p className="text-xs text-fg-2">{t("legal.notice.privacy_hint")}</p>
        {captchaInfo && <Captcha siteKey={captchaInfo.site_key} onToken={setCaptcha} resetKey={captchaReset} />}
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={busy} data-testid="notice-submit">
          {busy ? t("auth.wait") : t("legal.notice.submit")}
        </Button>
      </form>
    </LegalShell>
  );
}

/** `/legal/notice/<case>?token=`: the reporter's status page (the token comes from the confirmation mail). */
export function NoticeStatusPage() {
  const t = useT();
  const { caseId = "" } = useParams();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const status = useQuery({ queryKey: ["legal", "status", caseId, token], queryFn: () => publicApi.legal.noticeStatus(caseId, token), retry: false });
  return (
    <LegalShell title={t("legal.notice.status_title")}>
      {status.isError && <ErrorText>{describeError(status.error)}</ErrorText>}
      {status.data && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border border-line bg-bg-1 p-4 text-sm" data-testid="notice-status">
          <dt className="text-fg-2">{t("legal.notice.case")}</dt>
          <dd>
            <code>{status.data.case_id}</code>
          </dd>
          <dt className="text-fg-2">{t("legal.notice.state")}</dt>
          <dd data-testid="notice-state">{t(`legal.state.${status.data.state}`)}</dd>
          <dt className="text-fg-2">{t("legal.notice.updated")}</dt>
          <dd>{new Date(status.data.updated_at).toLocaleString(intlLocale())}</dd>
          {status.data.decision_reason && (
            <>
              <dt className="text-fg-2">{t("legal.notice.reason")}</dt>
              <dd className="whitespace-pre-wrap">{status.data.decision_reason}</dd>
            </>
          )}
        </dl>
      )}
    </LegalShell>
  );
}
