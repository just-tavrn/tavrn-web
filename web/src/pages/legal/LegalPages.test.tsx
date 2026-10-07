// SPDX-License-Identifier: Apache-2.0
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Route, Routes } from "react-router";
import { EMPTY_DRAFT, LegalDocumentPage, LegalIndexPage, NoticeFormPage, noticeRequest } from "./LegalPages";
import { mockFetch, renderWithProviders } from "../../test/render";

const node = (enabled: boolean) => ({ name: "Testknoten", domain: "t.local", registration: "open", legal: { notices: { enabled, contact: { name: "Op GmbH", address: "", email: "legal@t.local" } }, pages: {}, terms_mode: "notice" } });

const valid = { ...EMPTY_DRAFT, name: "Rita", email: "rita@example.org", work: "My photo", locations: [{ kind: "message" as const, value: "https://t.local/x?message=1" }], goodFaith: true, accuracy: true, perjury: true, signature: "Rita" };

describe("noticeRequest", () => {
  it("builds the request and checks the required fields", () => {
    const ok = noticeRequest(valid, "cap");
    expect(ok).toMatchObject({ ok: true, req: { basis: "copyright", reporter_name: "Rita", perjury: true, captcha_token: "cap", locations: [{ kind: "message", value: "https://t.local/x?message=1" }] } });
    expect(noticeRequest({ ...valid, perjury: false }, null)).toEqual({ ok: false, error: "legal.notice.err_statements" });
    expect(noticeRequest({ ...valid, basis: "illegal", perjury: false }, null)).toEqual({ ok: false, error: "legal.notice.err_explanation" });
    const illegal = noticeRequest({ ...valid, basis: "illegal", perjury: true, explanation: "Insult" }, null);
    expect(illegal.ok && illegal.req.perjury).toBe(false);
    expect(noticeRequest({ ...valid, locations: [{ kind: "message", value: "  " }] }, null)).toEqual({ ok: false, error: "legal.notice.err_locations" });
    expect(noticeRequest({ ...valid, email: "" }, null)).toEqual({ ok: false, error: "legal.notice.err_contact" });
    expect(noticeRequest({ ...valid, signature: " " }, null)).toEqual({ ok: false, error: "legal.notice.err_signature" });
  });
});

function renderAt(route: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/legal" element={<LegalIndexPage />} />
      <Route path="/legal/notice" element={<NoticeFormPage />} />
      <Route path="/legal/:kind" element={<LegalDocumentPage />} />
    </Routes>,
    { route },
  );
}

describe("legal pages", () => {
  it("lists the documents and renders one without markup from the author", async () => {
    mockFetch({
      "/api/v1/legal/pages/imprint": { body: { kind: "imprint", version: 2, published_at: "2026-10-06T10:00:00Z", lang: "de", url: "/legal/imprint", markdown: "# Impressum\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![t](https://tracker.example/p.gif)", html: "" } },
      "/api/v1/legal/pages": { body: [{ kind: "imprint", version: 2, published_at: "2026-10-06T10:00:00Z", lang: "de", url: "/legal/imprint", markdown: "", html: "" }] },
      "/api/v1/node": { body: node(true) },
    });
    const view = renderAt("/legal");
    expect(await screen.findByRole("link", { name: /Impressum/ })).toHaveAttribute("href", "/legal/imprint");
    expect(screen.getByTestId("legal-notice-link")).toBeInTheDocument();
    expect(await screen.findByTestId("legal-contact")).toHaveTextContent("legal@t.local");
    view.unmount();
    renderAt("/legal/imprint");
    const doc = await screen.findByTestId("legal-document");
    expect(doc.querySelector("h1")?.textContent).toBe("Impressum");
    expect(doc.innerHTML).not.toContain("<script");
    expect(doc.innerHTML).not.toContain("javascript:");
    expect(doc.querySelector("img")).toBeNull();
  });

  it("the notice form asks the perjury statement only for copyright and shows the case id", async () => {
    const calls = mockFetch({ "/api/v1/legal/notices": { status: 201, body: { case_id: "01JCASE0000000000000000000", state: "received", mailed: true } }, "/api/v1/node": { body: node(true) } });
    renderAt("/legal/notice");
    const u = userEvent.setup();
    expect(await screen.findByTestId("notice-perjury")).toBeInTheDocument();
    await u.selectOptions(screen.getByTestId("notice-basis"), "illegal");
    expect(screen.queryByTestId("notice-perjury")).toBeNull();
    expect(screen.getByTestId("notice-explanation")).toBeInTheDocument();
    await u.selectOptions(screen.getByTestId("notice-basis"), "copyright");
    await u.type(screen.getByTestId("notice-work"), "My photo");
    await u.type(screen.getByTestId("notice-location"), "https://t.local/rooms/a/channels/b?message=c");
    await u.type(screen.getByTestId("notice-name"), "Rita");
    await u.type(screen.getByTestId("notice-email"), "rita@example.org");
    await u.click(screen.getByTestId("notice-good-faith"));
    await u.click(screen.getByTestId("notice-accuracy"));
    await u.type(screen.getByTestId("notice-signature"), "Rita");
    await u.click(screen.getByTestId("notice-submit"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/legal/notices"))).toBe(false);
    await u.click(screen.getByTestId("notice-perjury"));
    await u.click(screen.getByTestId("notice-submit"));
    expect(await screen.findByTestId("notice-case-id")).toHaveTextContent("01JCASE0000000000000000000");
    const sent = JSON.parse(calls.find((c) => c.url.includes("/legal/notices"))!.init.body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({ basis: "copyright", perjury: true, good_faith: true, accuracy: true, reporter_email: "rita@example.org" });
  });

  it("says so when the node has no notice form", async () => {
    mockFetch({ "/api/v1/node": { body: node(false) } });
    renderAt("/legal/notice");
    await waitFor(() => expect(screen.queryByTestId("notice-form")).toBeNull());
    expect(await screen.findByText(/nimmt über dieses Formular keine Meldungen an/)).toBeInTheDocument();
  });
});
