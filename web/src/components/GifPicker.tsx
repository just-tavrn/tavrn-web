// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Gif } from "@tavrn/sdk";
import { api } from "../lib/api";
import { useT } from "../i18n";
import { Input } from "./ui";

export function GifPicker({ onPick, onClose }: { onPick: (gif: Gif) => void; onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(h);
  }, [query]);
  const gifs = useQuery({ queryKey: ["gifs", debounced], queryFn: () => api.gifs.search(debounced || undefined), staleTime: 60_000 });
  return (
    <div role="dialog" aria-label={t("composer.gif")} className="mb-2 rounded-lg border border-line bg-bg-1 p-2" data-testid="gif-picker">
      <div className="flex gap-2">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("composer.gif.search")} aria-label={t("composer.gif.search")} autoFocus />
        <button type="button" aria-label={t("common.close")} onClick={onClose} className="min-h-10 min-w-10 rounded-md text-fg-2 hover:bg-bg-3">
          ×
        </button>
      </div>
      <div className="mt-2 grid max-h-64 grid-cols-3 gap-1 overflow-y-auto sm:grid-cols-4">
        {gifs.isPending && <p className="col-span-full text-sm text-fg-2">{t("composer.gif.loading")}</p>}
        {gifs.data?.results.length === 0 && <p className="col-span-full text-sm text-fg-2">{t("composer.gif.none")}</p>}
        {gifs.data?.results.map((g) => (
          <button key={g.id} type="button" onClick={() => onPick(g)} className="overflow-hidden rounded-md border border-line hover:border-accent" aria-label={g.title || "GIF"}>
            <img src={g.preview_url} alt={g.title} loading="lazy" className="h-24 w-full object-cover" />
          </button>
        ))}
      </div>
    </div>
  );
}
