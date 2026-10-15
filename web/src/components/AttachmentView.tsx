// SPDX-License-Identifier: Apache-2.0
/**
 * Attachments in chat (design note 4.11): images inline (a click opens the viewer, never a download), videos
 * with a poster that play inline and enlarge into the viewer, audio with an inline player, other files
 * with an explicit download icon. Encrypted attachments are downloaded, checked and decrypted in the
 * browser into object URLs (cached per blob, within a byte budget); audio and video only when the user starts them.
 *
 * Safety (design note 4.12): SVG is never shown inline (a file row, download only); object URLs only keep the
 * type of raster images, audio and video. Image previews load by themselves only where the user's
 * `auto_preview` setting allows it for the author and the image is within the node's size cap; otherwise
 * a placeholder with name, size and a "load" button (and "load all" for several in one message).
 */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Attachment } from "@tavrn/sdk";
import { useNode } from "./NodeScope";
import { useT } from "../i18n";
import { AttachmentIntegrityError, decryptAttachment, verifyPlainAttachment, type ContentAttachment } from "@tavrn/e2ee";
import { isSvg, safeBlobType, shouldAutoPreview } from "../lib/preview";
import { stripBidi } from "../lib/untrusted";
import { usePrivacy } from "../stores/privacy";
import { toastError } from "../stores/toasts";
import { saveDownload } from "../lib/download";
import { AttachmentCache } from "./attachmentCache";

const MediaViewer = lazy(() => import("./MediaViewer"));

/** An attachment as the views need it, plaintext or encrypted. */
export interface ViewAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Key and hash of an attachment of an encrypted message (null: plaintext blob). */
  encrypted: ContentAttachment | null;
  /** The node deleted the file after the retention period (design note 4.13): no preview, no download. */
  expired?: boolean;
  /** Hidden behind a "spoiler" cover until clicked (design note 4.13). */
  spoiler?: boolean;
  /** Loads the content from elsewhere than `/blobs/{id}` (files channels, design note 4.13 item 9). */
  load?: () => Promise<Blob>;
  /**
   * SHA-256 (base64url) of a plaintext attachment, covered by the message's device signature (FEDERATION.md §10.3):
   * downloaded bytes that do not match are never shown or saved.
   */
  sha256?: string | null;
}

export const fromPlain = (a: Attachment): ViewAttachment => ({ id: a.id, name: stripBidi(a.name), mime: a.mime, size: a.size, encrypted: null, expired: !!a.expired, spoiler: !!a.spoiler, sha256: a.sha256 || null });
/** An attachment of an encrypted message; `listed` are the node's rows of the message (they carry `expired`). */
export const fromEncrypted = (a: ContentAttachment, listed?: Attachment[] | null): ViewAttachment => ({
  id: a.id,
  // Shown and saved without bidi controls: the name the sender declared can otherwise display in another order.
  name: stripBidi(a.name),
  mime: a.mime,
  size: a.size,
  encrypted: a,
  expired: !!listed?.find((x) => x.id === a.id)?.expired,
  spoiler: !!a.spoiler,
});

export type MediaKind = "image" | "video" | "audio" | "file";

/** How an attachment is shown; SVG (by type or name) is always a plain file. */
export function mediaKind(mime: string, name = ""): MediaKind {
  if (isSvg(mime, name)) return "file";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

type NodeApi = ReturnType<typeof useNode>["api"];

/** Plaintext kept for attachments nothing shows at the moment; entries in use are never dropped. */
export const ATTACHMENT_CACHE_BYTES = 192 * 1024 * 1024;
const cache = new AttachmentCache({ budget: ATTACHMENT_CACHE_BYTES, maxEntries: 400 });

const cacheKey = (a: ViewAttachment) => (a.load ? `file:${a.id}` : a.encrypted ? `${a.id}|${a.encrypted.sha256}|${a.encrypted.key}` : a.id);

/**
 * The content of an attachment (downloaded with the token, decrypted when encrypted) as a blob of a safe type, cached
 * per blob: the preview, the player and the download share one download.
 */
export function loadAttachment(api: NodeApi, a: ViewAttachment): Promise<Blob> {
  return cache.blob(cacheKey(a), a.size, () => fetchAttachment(api, a));
}

function fetchAttachment(api: NodeApi, a: ViewAttachment): Promise<Blob> {
  const enc = a.encrypted;
  return a.load
    ? a.load().then((blob) => blob.slice(0, blob.size, safeBlobType(a.mime, a.name)))
    : enc
    ? api.attachments
        .download(a.id)
        .then(async (blob) => decryptAttachment(new Uint8Array(await blob.arrayBuffer()), enc))
        .then((plain) => new Blob([plain as Uint8Array<ArrayBuffer>], { type: safeBlobType(enc.mime, enc.name) }))
    : api.attachments.download(a.id).then(async (blob) => {
        if (a.sha256) await verifyPlainAttachment(new Uint8Array(await blob.arrayBuffer()), a.sha256);
        return blob.slice(0, blob.size, safeBlobType(a.mime, a.name));
      });
}

/** Sign-out: drops the downloaded and decrypted attachments of this session and revokes their object URLs. */
export function forgetAttachments(): void {
  cache.clear();
}

/** Object URL of an attachment, cached per blob; `tampered`: the bytes do not match the attachment's hash. */
export function useAttachmentUrl(a: ViewAttachment, enabled: boolean): { url: string | null; failed: boolean; loading: boolean; tampered: boolean } {
  const [state, setState] = useState<{ url: string | null; failed: boolean; tampered?: boolean }>({ url: null, failed: false });
  // Blobs live on the node of the conversation.
  const { api } = useNode();
  const key = cacheKey(a);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // Held while mounted: the cache drops (and revokes) only what no view shows.
    const held = cache.acquireUrl(key, a.size, () => fetchAttachment(api, a));
    held.url.then((url) => !cancelled && setState({ url, failed: false })).catch((e: unknown) => !cancelled && setState({ url: null, failed: true, tampered: e instanceof AttachmentIntegrityError }));
    return () => {
      cancelled = true;
      held.release();
    };
    // `key` identifies the attachment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return { url: state.url, failed: state.failed, tampered: !!state.tampered, loading: enabled && !state.url && !state.failed };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

/**
 * A download icon button; fetches (and decrypts) on demand and saves through the platform (saveFile.ts), asking first
 * when the file is an executable or a script (lib/download.ts).
 */
export function DownloadButton({ a, className = "" }: { a: ViewAttachment; className?: string }) {
  const t = useT();
  const { api } = useNode();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const blob = await loadAttachment(api, a).catch((e: unknown) => {
        setFailed(true);
        throw e;
      });
      setFailed(false);
      await saveDownload({ name: a.name || "download", data: blob, mime: blob.type }, a.mime);
    } catch (e) {
      toastError(e, t("attachment.download_failed", { name: a.name }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      aria-label={t("media.download", { name: a.name })}
      title={failed ? t("attachment.decrypt_failed", { name: a.name }) : t("media.download", { name: a.name })}
      onClick={(e) => {
        e.stopPropagation();
        if (!busy) void download();
      }}
      aria-busy={busy || undefined}
      className={`flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded text-fg-2 hover:bg-bg-3 hover:text-fg-0 ${className}`}
      data-testid="attachment-download"
    >
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 2v8M4.5 6.8 8 10.3l3.5-3.5M3 13.5h10" />
      </svg>
    </button>
  );
}

function Failed({ a }: { a: ViewAttachment }) {
  const t = useT();
  // A plaintext file whose bytes do not match its signed hash, or an encrypted one that does not decrypt.
  const key = a.encrypted ? "attachment.decrypt_failed" : "attachment.tampered";
  return (
    <p className="mt-1 text-sm italic text-fg-2" data-testid="attachment-failed" title={t(`${key}_hint`)}>
      ⚠ {t(key, { name: a.name })} <span className="sr-only">({t(`${key}_hint`)})</span>
    </p>
  );
}

function Caption({ a }: { a: ViewAttachment }) {
  return (
    <figcaption className="mt-0.5 flex items-center gap-1 text-xs text-fg-2">
      <span className="min-w-0 truncate">
        {a.encrypted ? "🔒 " : ""}
        {a.name} · {formatSize(a.size)}
      </span>
      <DownloadButton a={a} />
    </figcaption>
  );
}

function ImageThumb({ a, onOpen }: { a: ViewAttachment; onOpen: () => void }) {
  const t = useT();
  const { url, failed, tampered } = useAttachmentUrl(a, true);
  if (failed && (a.encrypted || tampered)) return <Failed a={a} />;
  return (
    <figure className="mt-1 w-fit max-w-full" data-testid="attachment-image">
      {url ? (
        <button type="button" onClick={onOpen} className="block max-w-full rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={t("media.open", { name: a.name })}>
          <img src={url} alt={a.name} className="max-h-80 max-w-full cursor-zoom-in rounded-md border border-line" />
        </button>
      ) : (
        <div role="status" className="h-40 w-64 max-w-full animate-pulse rounded-md bg-bg-3" aria-label={t("attachment.loading", { name: a.name })} />
      )}
      <Caption a={a} />
    </figure>
  );
}

function VideoInline({ a, onEnlarge }: { a: ViewAttachment; onEnlarge: () => void }) {
  const t = useT();
  const [started, setStarted] = useState(false);
  const { url, failed, loading, tampered } = useAttachmentUrl(a, started);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (started && url) void video.current?.play().catch(() => undefined);
  }, [started, url]);
  if (failed && (a.encrypted || tampered)) return <Failed a={a} />;
  return (
    <figure className="mt-1 w-fit max-w-full" data-testid="attachment-video">
      <div className="relative w-80 max-w-full overflow-hidden rounded-md border border-line bg-black">
        {url ? (
          <video ref={video} src={url} controls playsInline preload="metadata" className="aspect-video w-full" data-testid="inline-video" />
        ) : (
          <button type="button" onClick={() => setStarted(true)} className="flex aspect-video w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-bg-3 to-bg-0 text-fg-1 hover:text-fg-0" aria-label={t("media.play_video", { name: a.name })} data-testid="video-poster">
            <span aria-hidden="true" className="flex h-12 w-12 items-center justify-center rounded-full bg-black/50 text-xl">
              {loading ? "…" : "▶"}
            </span>
            <span className="max-w-[90%] truncate text-xs">{a.name}</span>
          </button>
        )}
        <button type="button" onClick={onEnlarge} className="absolute right-1 top-1 min-h-8 min-w-8 rounded bg-black/50 text-sm text-white hover:bg-black/70" aria-label={t("media.enlarge", { name: a.name })} title={t("media.enlarge", { name: a.name })} data-testid="video-enlarge">
          ⤢
        </button>
      </div>
      <Caption a={a} />
    </figure>
  );
}

/** The inline audio player: play/pause, progress (seekable), time, volume, download. */
export function AudioPlayer({ a }: { a: ViewAttachment }) {
  const t = useT();
  const [wanted, setWanted] = useState(false);
  const { url, failed, loading, tampered } = useAttachmentUrl(a, wanted);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  useEffect(() => {
    if (wanted && url) void audio.current?.play().catch(() => undefined);
  }, [wanted, url]);
  const toggle = () => {
    const el = audio.current;
    if (!url || !el) return setWanted(true);
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  };
  if (failed && (a.encrypted || tampered)) return <Failed a={a} />;
  return (
    <div className="mt-1 flex w-80 max-w-full items-center gap-2 rounded-md border border-line bg-bg-0 px-2 py-1.5" data-testid="audio-player" data-playing={playing || undefined}>
      <button type="button" onClick={toggle} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-text hover:bg-accent-hover" aria-label={playing ? t("media.pause") : t("media.play", { name: a.name })} data-testid="audio-play">
        {loading ? "…" : playing ? "❚❚" : "▶"}
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-fg-1" title={a.name}>
          {a.encrypted ? "🔒 " : ""}
          {a.name}
        </p>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(time, duration || 0)}
            disabled={!url}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (audio.current) audio.current.currentTime = v;
              setTime(v);
            }}
            aria-label={t("media.progress")}
            aria-valuetext={`${formatDuration(time)} / ${duration ? formatDuration(duration) : "?"}`}
            className="h-1 min-w-0 flex-1"
            data-testid="audio-progress"
          />
          <span className="shrink-0 text-[11px] tabular-nums text-fg-2" data-testid="audio-time">
            {formatDuration(time)} / {duration ? formatDuration(duration) : formatSize(a.size)}
          </span>
        </div>
      </div>
      <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => { const v = Number(e.target.value); setVolume(v); if (audio.current) audio.current.volume = v; }} aria-label={t("media.volume")} aria-valuetext={`${Math.round(volume * 100)} %`} className="hidden h-1 w-16 sm:block" />
      <DownloadButton a={a} />
      {url && (
        <audio
          ref={audio}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
          onDurationChange={(e) => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
          data-testid="audio-element"
        />
      )}
    </div>
  );
}

function FileRow({ a }: { a: ViewAttachment }) {
  return (
    <div className="mt-1 flex min-h-10 max-w-full items-center gap-2 rounded-md border border-line bg-bg-0 px-3 text-sm" data-testid="attachment-file">
      <span aria-hidden="true">{a.encrypted ? "🔒" : "📎"}</span>
      <span className="min-w-0 truncate">{a.name}</span>
      <span className="shrink-0 text-xs text-fg-2">{formatSize(a.size)}</span>
      <DownloadButton a={a} className="ml-auto" />
    </div>
  );
}

/** An attachment whose file the node deleted after the retention period: name and size only. */
export function ExpiredRow({ a }: { a: ViewAttachment }) {
  const t = useT();
  return (
    <div className="mt-1 flex min-h-10 max-w-full items-center gap-2 rounded-md border border-dashed border-line bg-bg-0 px-3 text-sm text-fg-2" data-testid="attachment-expired" title={t("attachment.expired_hint")}>
      <span aria-hidden="true">⌛</span>
      <span className="min-w-0 truncate line-through">{a.name || t("attachment.unnamed")}</span>
      <span className="shrink-0 text-xs">{formatSize(a.size)}</span>
      <span className="ml-auto shrink-0 text-xs italic">{t("attachment.expired")}</span>
    </div>
  );
}

/** Spoilers revealed in this tab (blob ids): they stay revealed while the virtualized list re-mounts rows. */
const revealedSpoilers = new Set<string>();

/**
 * A spoiler attachment (design note 4.13): images and videos are rendered blurred under an overlay; other files
 * (also their names) are hidden behind the same overlay until clicked. Nothing behind it can be activated.
 */
function SpoilerCover({ a, onReveal, children }: { a: ViewAttachment; onReveal: () => void; children: React.ReactNode }) {
  const t = useT();
  const kind = mediaKind(a.mime, a.name);
  const visual = kind === "image" || kind === "video";
  return (
    <div className="relative mt-1 w-fit max-w-full" data-testid="attachment-spoiler" data-kind={kind}>
      {visual ? (
        <div className="pointer-events-none select-none overflow-hidden rounded-md blur-xl" aria-hidden="true" inert>
          {children}
        </div>
      ) : (
        <div className="h-12 w-64 max-w-full rounded-md border border-line bg-bg-3" aria-hidden="true" />
      )}
      <button type="button" onClick={onReveal} className="absolute inset-0 flex items-center justify-center rounded-md bg-black/55 px-3 text-sm font-semibold text-white hover:bg-black/45" data-testid="spoiler-reveal">
        {t("attachment.spoiler_reveal")}
      </button>
    </div>
  );
}

/** Previews the user loaded by hand in this tab (blob ids). */
const loadedByHand = new Set<string>();

/** An image whose preview waits for a click: name, size, "load" and the download icon. */
function PreviewPlaceholder({ a, onLoad }: { a: ViewAttachment; onLoad: () => void }) {
  const t = useT();
  return (
    <div className="mt-1 flex w-80 max-w-full items-center gap-2 rounded-md border border-dashed border-line bg-bg-0 px-3 py-2 text-sm" data-testid="preview-placeholder" title={t("media.preview_hint")}>
      <span aria-hidden="true">🖼</span>
      <div className="min-w-0 flex-1">
        <p className="truncate" title={a.name}>
          {a.encrypted ? "🔒 " : ""}
          {a.name}
        </p>
        <p className="text-xs text-fg-2">{formatSize(a.size)}</p>
      </div>
      <button type="button" onClick={onLoad} className="min-h-8 shrink-0 rounded-md bg-bg-3 px-3 text-xs text-fg-0 hover:bg-bg-2" aria-label={t("media.load_named", { name: a.name })} data-testid="preview-load">
        {t("media.load")}
      </button>
      <DownloadButton a={a} />
    </div>
  );
}

/**
 * All attachments of one message; images and videos share one viewer (previous/next within the message).
 * `own`, `inRoom` and `author` decide whether image previews load by themselves (design note 4.12).
 */
export function MessageAttachments({ items, author, own = false, inRoom = false }: { items: ViewAttachment[]; author?: string; own?: boolean; inRoom?: boolean }) {
  const t = useT();
  const [viewer, setViewer] = useState<number | null>(null);
  // Kept across re-mounts (the message list is virtualized): a loaded preview stays loaded while scrolling.
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set(items.filter((a) => loadedByHand.has(a.id)).map((a) => a.id)));
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set(items.filter((a) => revealedSpoilers.has(a.id)).map((a) => a.id)));
  const reveal = (id: string) => {
    revealedSpoilers.add(id);
    setRevealed((old) => new Set([...old, id]));
  };
  const setting = usePrivacy((s) => s.autoPreview);
  const maxBytes = usePrivacy((s) => s.maxBytes);
  const friend = usePrivacy((s) => !!author && s.friends.has(author));
  const visual = items.filter((a) => {
    if (a.expired) return false;
    const k = mediaKind(a.mime, a.name);
    return k === "image" || k === "video";
  });
  const waiting = items.filter((a) => !a.expired && mediaKind(a.mime, a.name) === "image" && !loaded.has(a.id) && !shouldAutoPreview({ setting, size: a.size, maxBytes, own, inRoom, friend }));
  const load = (ids: string[]) => {
    for (const id of ids) loadedByHand.add(id);
    setLoaded((old) => new Set([...old, ...ids]));
  };
  return (
    <>
      {waiting.length > 1 && (
        <button type="button" onClick={() => load(waiting.map((a) => a.id))} className="mt-1 block min-h-8 rounded-md px-2 text-xs text-accent hover:bg-bg-3" data-testid="preview-load-all">
          {t("media.load_all", { count: waiting.length })}
        </button>
      )}
      {items.map((a) => {
        if (a.expired) return <ExpiredRow key={a.id} a={a} />;
        const kind = mediaKind(a.mime, a.name);
        const view =
          kind === "image" && waiting.includes(a) ? (
            <PreviewPlaceholder a={a} onLoad={() => load([a.id])} />
          ) : kind === "image" ? (
            <ImageThumb a={a} onOpen={() => setViewer(visual.indexOf(a))} />
          ) : kind === "video" ? (
            <VideoInline a={a} onEnlarge={() => setViewer(visual.indexOf(a))} />
          ) : kind === "audio" ? (
            <AudioPlayer a={a} />
          ) : (
            <FileRow a={a} />
          );
        if (a.spoiler && !revealed.has(a.id)) {
          return (
            <SpoilerCover key={a.id} a={a} onReveal={() => reveal(a.id)}>
              {view}
            </SpoilerCover>
          );
        }
        return <div key={a.id} className="contents">{view}</div>;
      })}
      {viewer !== null && (
        <Suspense fallback={null}>
          <MediaViewer items={visual} start={viewer} onClose={() => setViewer(null)} />
        </Suspense>
      )}
    </>
  );
}

/** A single plaintext attachment (kept for callers that render one). */
export function AttachmentView({ attachment }: { attachment: Attachment }) {
  return <MessageAttachments items={[fromPlain(attachment)]} />;
}

/** A single encrypted attachment. */
export function EncryptedAttachmentView({ attachment }: { attachment: ContentAttachment }) {
  return <MessageAttachments items={[fromEncrypted(attachment)]} />;
}
