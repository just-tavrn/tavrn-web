// SPDX-License-Identifier: Apache-2.0
import { useMemo } from "react";
import { renderDocument } from "../../lib/markdown";

/**
 * A rendered legal document (`.legal-doc` styles headings, lists and tables). Its own module: the terms gate shows it
 * at startup, the legal pages themselves load on first use.
 */
export function LegalDocumentView({ markdown }: { markdown: string }) {
  const html = useMemo(() => renderDocument(markdown), [markdown]);
  return <article className="legal-doc markdown text-sm leading-relaxed text-fg-1" data-testid="legal-document" dangerouslySetInnerHTML={{ __html: html }} />;
}
