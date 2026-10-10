// SPDX-License-Identifier: Apache-2.0
/** Schemes a link outside the client may have; everything else (javascript:, file:, data:, …) is refused. */
const EXTERNAL = new Set(["https:", "http:", "mailto:"]);

/** `url` when it is an absolute link the client may hand to a browser or the system, otherwise an error. */
export function externalUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Not an absolute URL");
  }
  if (!EXTERNAL.has(parsed.protocol)) throw new Error(`Links with ${parsed.protocol} are not opened`);
  return parsed.href;
}

/**
 * Links in the desktop app (both shells): other sites open in the system browser (the app never shows remote pages),
 * the app's own pages meant for a new tab (`target="_blank"`, e.g. the terms) open on the node's web client there.
 * In-app navigation, downloads and blob links stay untouched. Returns the uninstaller.
 */
export function installLinkHandler(doc: Document, open: (url: string) => Promise<void>, web: () => string): () => void {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || a.hasAttribute("download")) return;
    let url: URL;
    try {
      url = new URL(a.href, location.href);
    } catch {
      return;
    }
    if (url.protocol === "blob:" || url.protocol === "data:") return;
    if (url.origin === location.origin) {
      if (a.target !== "_blank") return;
      e.preventDefault();
      void open(`${web()}${url.pathname}${url.search}${url.hash}`).catch(() => {});
      return;
    }
    e.preventDefault();
    void open(url.href).catch(() => {});
  };
  doc.addEventListener("click", onClick);
  return () => doc.removeEventListener("click", onClick);
}
