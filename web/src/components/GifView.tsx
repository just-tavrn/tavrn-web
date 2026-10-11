// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useT } from "../i18n";
import { shouldAutoPreview } from "../lib/preview";
import { usePrivacy } from "../stores/privacy";

/** GIFs loaded by hand stay loaded while the virtualized list re-mounts rows. */
const loadedByHand = new Set<string>();

export interface MessageGif {
  url: string;
  width?: number;
  height?: number;
}

/**
 * A GIF of a message (an allow-listed provider URL, `lib/gifs.ts`). It comes from a third party, so it follows the
 * image preview setting like an attachment (design note 4.12): otherwise a placeholder, and nothing is fetched before
 * the click. Loaded without a referrer.
 */
export function GifView({ gif, author, own, inRoom }: { gif: MessageGif; author?: string; own: boolean; inRoom: boolean }) {
  const t = useT();
  const setting = usePrivacy((s) => s.autoPreview);
  const maxBytes = usePrivacy((s) => s.maxBytes);
  const friend = usePrivacy((s) => !!author && s.friends.has(author));
  const [loaded, setLoaded] = useState(() => loadedByHand.has(gif.url));
  // The size of a provider GIF is unknown: the setting decides (a cap of 0 means "never automatically").
  const auto = shouldAutoPreview({ setting, size: 0, maxBytes, own, inRoom, friend });
  if (!auto && !loaded) {
    return (
      <div className="mt-1 flex w-80 max-w-full items-center gap-2 rounded-md border border-dashed border-line bg-bg-0 px-3 py-2 text-sm" data-testid="gif-placeholder" title={t("media.preview_hint")}>
        <span aria-hidden="true">🖼</span>
        <p className="min-w-0 flex-1 truncate">GIF</p>
        <button
          type="button"
          onClick={() => {
            loadedByHand.add(gif.url);
            setLoaded(true);
          }}
          className="min-h-8 shrink-0 rounded-md bg-bg-3 px-3 text-xs text-fg-0 hover:bg-bg-2"
          aria-label={t("media.load_gif")}
          data-testid="gif-load"
        >
          {t("media.load")}
        </button>
      </div>
    );
  }
  const ratio = typeof gif.width === "number" && typeof gif.height === "number" && gif.width > 0 && gif.height > 0 ? { aspectRatio: `${gif.width} / ${gif.height}` } : undefined;
  return <img src={gif.url} alt="GIF" loading="lazy" referrerPolicy="no-referrer" className="mt-1 max-h-72 max-w-full rounded-md border border-line" style={ratio} data-testid="gif" />;
}
