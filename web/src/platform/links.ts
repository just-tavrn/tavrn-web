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

/** The client's own link that a click may follow inside the page: same origin, not a download, not a blob or data URL. */
function ownLink(e: MouseEvent): HTMLAnchorElement | null {
  const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a || a.hasAttribute("download")) return null;
  try {
    const url = new URL(a.href, location.href);
    return url.origin === location.origin && url.protocol !== "blob:" && url.protocol !== "data:" ? a : null;
  } catch {
    return null;
  }
}

/**
 * Links in the apps (desktop Tauri, Electron, Android): other sites open in the system browser (the app never shows
 * remote pages), the app's own pages meant for a new tab (`target="_blank"`, e.g. the terms) open on the node's web
 * client there. In-app navigation, downloads and blob links stay untouched. A Ctrl/Shift/Meta-click or a middle click
 * on the app's own link acts as a plain click: an app has no tabs, and the webview would otherwise ask the shell for a
 * new window with the app's own URL. Returns the uninstaller.
 */
export function installLinkHandler(doc: Document, open: (url: string) => Promise<void>, web: () => string): () => void {
  // Capture phase, before the page's handlers: the original event stops here, the link gets a plain click instead
  // (a router link navigates in the client; its other handlers run once).
  const onModified = (e: MouseEvent) => {
    if (e.defaultPrevented) return;
    const modified = e.type === "click" ? e.button === 0 && (e.ctrlKey || e.metaKey || e.shiftKey) : e.button === 1;
    if (!modified) return;
    const a = ownLink(e);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    a.click();
  };
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
  doc.addEventListener("click", onModified, true);
  doc.addEventListener("auxclick", onModified, true);
  doc.addEventListener("click", onClick);
  return () => {
    doc.removeEventListener("click", onModified, true);
    doc.removeEventListener("auxclick", onModified, true);
    doc.removeEventListener("click", onClick);
  };
}
