// SPDX-License-Identifier: Apache-2.0
/**
 * Cards below a message's text (design note 4.13 item 7): the embeds of the content (APPLICATIONS.md §6.4, from bots and
 * webhooks), click-to-play embeds of allow-listed providers, recognised from the URL alone, and the link preview the
 * sender stored in the content. Nothing is fetched to build them; a provider thumbnail loads only with the
 * "thumbnail" setting and once the card is on screen, the player only after a click. Content embeds never load
 * anything: no images, their description goes through the message Markdown sanitizer, links show their full host.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { readEmbeds, type MessageEmbed } from "@tavrn/e2ee";
import { intlLocale, useT } from "../i18n";
import { renderMarkdown } from "../lib/markdown";
import { PROVIDER_NAMES, type Embed } from "../lib/embeds";
import { cardsOf, readPreview, type LinkPreview } from "../lib/linkPreview";
import { useContentPrivacy } from "../stores/contentPrivacy";
import { originUrl } from "../platform";

/** `true` once the element has been near the viewport (always `true` without IntersectionObserver). */
function useSeen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (seen || !ref.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
        io.disconnect();
      }
    }, { rootMargin: "200px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

const FRAME: Record<Embed["shape"], string> = {
  wide: "aspect-video w-full max-w-md",
  tall: "aspect-[9/16] w-full max-w-[240px]",
  strip: "h-[152px] w-full max-w-md",
  panel: "h-[352px] w-full max-w-md",
};

export function EmbedCard({ embed, thumbnails }: { embed: Embed; thumbnails: boolean }) {
  const t = useT();
  const [playing, setPlaying] = useState(false);
  const [ref, seen] = useSeen<HTMLDivElement>();
  const [thumbFailed, setThumbFailed] = useState(false);
  const label = `${PROVIDER_NAMES[embed.provider]} · ${t(`embed.kind.${embed.kind}`)}`;
  const title = embed.kind === "channel" ? `${label}: ${embed.id}` : label;
  const thumb = thumbnails && seen && !thumbFailed ? embed.thumbnail : undefined;
  return (
    <div ref={ref} className={`mt-1 overflow-hidden rounded-md border border-line bg-bg-1 ${FRAME[embed.shape]}`} data-testid="embed-card" data-provider={embed.provider}>
      {playing ? (
        <iframe
          src={embed.embedUrl}
          title={title}
          className="h-full w-full"
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
          data-testid="embed-frame"
        />
      ) : (
        <button type="button" onClick={() => setPlaying(true)} className="group relative flex h-full w-full items-center justify-center bg-bg-2 text-left" aria-label={t("embed.play", { title })} data-testid="embed-play">
          {/* No loading="lazy": the IntersectionObserver above already defers it, and lazy loading delays it again on phones. */}
          {thumb && <img src={thumb} alt="" referrerPolicy="no-referrer" onError={() => setThumbFailed(true)} className="absolute inset-0 h-full w-full object-cover" data-testid="embed-thumbnail" />}
          <span className="relative flex h-12 w-12 items-center justify-center rounded-full bg-black/70 text-xl text-white group-hover:bg-accent" aria-hidden="true">
            ▶
          </span>
          <span className="absolute bottom-0 left-0 right-0 truncate bg-black/60 px-2 py-1 text-xs text-white">{title}</span>
        </button>
      )}
    </div>
  );
}

export function PreviewCard({ preview, onRemove }: { preview: LinkPreview; onRemove?: () => void }) {
  const t = useT();
  return (
    <div className="mt-1 flex max-w-md gap-3 rounded-md border border-line border-l-4 border-l-accent bg-bg-1 p-2" data-testid={onRemove ? "compose-preview" : "link-preview"}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-fg-2">{preview.site}</p>
        <a href={preview.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="line-clamp-2 break-words text-sm font-semibold text-accent hover:underline" data-testid="link-preview-title">
          {preview.title || preview.url}
        </a>
        {preview.description && <p className="line-clamp-3 break-words text-xs text-fg-1">{preview.description}</p>}
      </div>
      {preview.image && <img src={preview.image} alt="" className="h-16 w-16 shrink-0 rounded object-cover sm:h-20 sm:w-20" data-testid="link-preview-image" />}
      {onRemove && (
        <button type="button" onClick={onRemove} className="min-h-6 min-w-6 self-start text-fg-2 hover:text-fg-0" aria-label={t("preview.remove")} data-testid="compose-preview-remove">
          ×
        </button>
      )}
    </div>
  );
}

/** `#rrggbb` of an embed colour. */
export function embedColor(color: number | undefined): string | undefined {
  return color === undefined ? undefined : `#${color.toString(16).padStart(6, "0")}`;
}

/** The host of an embed link, shown in full next to it (`ci.example`, `xn--…` stays as it is). */
export function embedHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** One embed of a message's content (APPLICATIONS.md §6.4): colour bar, title (link), description, fields, footer. */
export function MessageEmbedCard({ embed }: { embed: MessageEmbed }) {
  const t = useT();
  const description = useMemo(() => (embed.description ? renderMarkdown(embed.description) : ""), [embed.description]);
  const color = embedColor(embed.color);
  const time = embed.timestamp ? new Date(embed.timestamp) : null;
  return (
    <div
      className="mt-1 w-full max-w-lg overflow-hidden rounded-md border border-line border-l-4 border-l-accent bg-bg-1 p-3"
      style={color ? { borderLeftColor: color } : undefined}
      role="group"
      aria-label={embed.title ?? t("richembed.label")}
      data-testid="message-embed"
      data-color={color}
    >
      {embed.title &&
        (embed.url ? (
          <a href={embed.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="block break-words text-sm font-semibold text-accent hover:underline" data-testid="message-embed-title">
            {embed.title}
          </a>
        ) : (
          <p className="break-words text-sm font-semibold text-fg-0" data-testid="message-embed-title">
            {embed.title}
          </p>
        ))}
      {embed.url && (
        <a href={embed.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="block break-all text-xs text-fg-2 hover:underline" title={embed.url} data-testid="message-embed-host">
          {embedHost(embed.url)}
        </a>
      )}
      {description && <div className="markdown mt-1 break-words text-sm text-fg-1" data-testid="message-embed-description" dangerouslySetInnerHTML={{ __html: description }} />}
      {embed.fields && embed.fields.length > 0 && (
        <dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {embed.fields.map((f, i) => (
            <div key={i} className={`min-w-0 ${f.inline ? "" : "sm:col-span-3"}`} data-testid="message-embed-field" data-inline={f.inline ? "true" : undefined}>
              <dt className="break-words text-xs font-semibold text-fg-0">{f.name}</dt>
              <dd className="whitespace-pre-wrap break-words text-sm text-fg-1">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {(embed.footer || (time && !Number.isNaN(time.getTime()))) && (
        <p className="mt-2 break-words text-xs text-fg-2" data-testid="message-embed-footer">
          {embed.footer}
          {embed.footer && time && " · "}
          {time && !Number.isNaN(time.getTime()) && <time dateTime={embed.timestamp}>{time.toLocaleString(intlLocale(), { dateStyle: "medium", timeStyle: "short" })}</time>}
        </p>
      )}
    </div>
  );
}

/** Content embeds, provider embeds and the stored preview of one message (at most three link cards). */
export const LinkPreviews = memo(function LinkPreviews({ body, content }: { body: string; content: unknown }) {
  const embeds = useContentPrivacy((s) => s.embeds);
  const showPreviews = useContentPrivacy((s) => s.showPreviews);
  const raw = content && typeof content === "object" ? (content as Record<string, unknown>).preview : undefined;
  const rich = useMemo(() => readEmbeds(content), [content]);
  const cards = useMemo(() => {
    if (!body.includes("http")) return null;
    const preview = readPreview(raw, body);
    return cardsOf(body, preview, new URL(originUrl()).hostname, { embeds: embeds !== "off", previews: showPreviews });
  }, [body, raw, embeds, showPreviews]);
  const hasCards = !!cards && (cards.embeds.length > 0 || !!cards.preview);
  if (rich.length === 0 && !hasCards) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="link-previews">
      {rich.map((e, i) => (
        <MessageEmbedCard key={i} embed={e} />
      ))}
      {cards?.embeds.map((e) => (
        <EmbedCard key={e.embedUrl} embed={e} thumbnails={embeds === "thumbnail"} />
      ))}
      {cards?.preview && <PreviewCard preview={cards.preview} />}
    </div>
  );
});
