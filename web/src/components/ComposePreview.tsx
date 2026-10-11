// SPDX-License-Identifier: Apache-2.0
/**
 * The link preview while composing (design note 4.13 item 7): the first link that is not an embed is unfurled
 * by the user's home node (debounced; a newer text discards older answers), shown as a card with an X, and
 * sent with the message. Only with the "Create link previews when sending" setting and a home node that
 * offers `unfurl`; in end-to-end encrypted conversations only with "Fetch link previews in encrypted conversations"
 * too (off by default: the home node learns every link it unfurls).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { fromUnfurl, unfurlCandidate, type LinkPreview } from "../lib/linkPreview";
import { useContentPrivacy } from "../stores/contentPrivacy";
import { PreviewCard } from "./LinkPreviews";
import { originUrl } from "../platform";

export const UNFURL_DEBOUNCE_MS = 700;

let offered: Promise<boolean> | null = null;
/** Whether the home node offers `unfurl` (asked once per page load; asked again after a failure). */
function unfurlOffered(): Promise<boolean> {
  offered ??= api.node.info().then(
    (n) => !!n.capabilities?.includes("unfurl"),
    () => {
      offered = null;
      return false;
    },
  );
  return offered;
}

export function useComposePreview(text: string, enabled: boolean, encrypted = false): { preview: LinkPreview | null; card: ReactNode; reset: () => void } {
  const create = useContentPrivacy((s) => s.createPreviews && (!encrypted || s.encryptedPreviews));
  const candidate = enabled && create ? unfurlCandidate(text, new URL(originUrl()).hostname) : null;
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = useState<{ url: string; preview: LinkPreview | null } | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    if (!candidate || dismissed.has(candidate) || result?.url === candidate) return;
    const current = () => gen === generation.current;
    const timer = setTimeout(() => {
      unfurlOffered()
        .then(async (yes) => {
          if (!yes || !current()) return;
          const r = await api.unfurl.get(candidate);
          // The preview keeps the link as written (readers show it only for links in the text).
          if (current()) setResult({ url: candidate, preview: fromUnfurl({ ...r, url: candidate }) });
        })
        .catch(() => current() && setResult({ url: candidate, preview: null }));
    }, UNFURL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidate, dismissed]);

  const preview = candidate && result?.url === candidate && !dismissed.has(candidate) ? result.preview : null;
  const card = preview ? <PreviewCard preview={preview} onRemove={() => setDismissed((d) => new Set(d).add(preview.url))} /> : null;
  return { preview, card, reset: () => setDismissed(new Set()) };
}
