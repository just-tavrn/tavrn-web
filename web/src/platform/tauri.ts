// SPDX-License-Identifier: Apache-2.0
/**
 * The desktop app (Tauri shell in `apps/desktop`). Talks to the shell only through its own commands
 * (`src-tauri/src/commands.rs`): the chosen node, opening links in the system browser, the updater. This module
 * is loaded only inside the app (platform/index.ts); nothing here runs in a browser.
 */
import { invoke } from "@tauri-apps/api/core";
import { externalUrl } from "./links";
import { runAppSession } from "./appSession";
import { shellMembers } from "./tauriShell";
import type { AppUpdater, Platform, ResolvedNode } from "./types";

interface ShellConfig {
  node: string | null;
  /** Origin of the node's web client and its identity domain (absent before they were known). */
  web?: string | null;
  domain?: string | null;
}

interface AppInfo {
  version: string;
  /** False while the build carries no updater key (development builds, forks). */
  updater: boolean;
}

interface UpdateInfo {
  version: string;
  notes?: string | null;
}

const updater: AppUpdater = {
  check: async () => {
    const found = await invoke<UpdateInfo | null>("check_update");
    if (!found) return null;
    return { version: found.version, notes: found.notes ?? null, install: () => invoke<void>("install_update") };
  },
};

/** The desktop platform; `doc` receives the link handler (tests pass a detached document). */
export async function createTauriPlatform(doc: Document = document): Promise<Platform> {
  const [config, info] = await Promise.all([invoke<ShellConfig>("get_config"), invoke<AppInfo>("app_info")]);
  let node = config.node;
  let web = config.web ?? null;
  let domain = config.domain ?? null;
  const openExternal = async (url: string) => {
    await invoke<void>("open_external", { url: externalUrl(url) });
  };
  const platform: Platform = {
    kind: "desktop",
    isDesktop: true,
    nodeBase: () => node ?? "",
    // A node serves its web client on the URL the user picked (where links shared with others point to), unless its
    // document names another origin.
    webOrigin: () => web ?? node ?? location.origin,
    openExternal,
    appVersion: async () => info.version,
    node: {
      current: () => node,
      set: async (url, details) => {
        const args = details ? { url, web: details.web ?? null, domain: details.domain ?? null } : { url };
        node = await invoke<string>("set_node", args);
        web = details?.web ? new URL(details.web).origin : null;
        domain = details?.domain ?? null;
      },
      domain: () => domain,
      resolve: (name) => invoke<ResolvedNode>("resolve_node", { domain: name }),
    },
    auth: {
      // The node's page in a window of the shell without any native API (FEDERATION.md §8 step 3, docs/DESKTOP.md).
      signInOnNodePage: (req) =>
        runAppSession({
          api: req.api,
          web: req.endpoints.web,
          domain: req.endpoints.domain,
          deviceName: "Desktop app",
          mode: req.mode,
          open: (url) => invoke<void>("open_connect", { url }),
          close: () => invoke<void>("close_connect"),
          onPage: req.onPage,
          device: req.device,
          signal: req.signal,
        }),
      reopen: (url) => invoke<void>("open_connect", { url }),
    },
    ...(info.updater ? { updater } : {}),
    // OS keychain, native notifications, tray (tauriShell.ts).
    ...shellMembers(),
  };
  installLinkHandler(doc, openExternal, platform.webOrigin);
  return platform;
}

/**
 * Links in the app: other sites open in the system browser (the app never shows remote pages), the app's own
 * pages meant for a new tab (`target="_blank"`, e.g. the terms) open on the node's web client there. In-app
 * navigation, downloads and blob links stay untouched. Returns the uninstaller.
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
