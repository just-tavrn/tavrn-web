// SPDX-License-Identifier: Apache-2.0
/**
 * The desktop app (Tauri shell in `apps/desktop`). Talks to the shell only through its own commands
 * (`src-tauri/src/commands.rs`): the chosen node, opening links in the system browser, the updater. This module
 * is loaded only inside the app (platform/index.ts); nothing here runs in a browser.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { externalUrl } from "./links";
import type { AppUpdater, HotkeyEvent, Platform, PlatformHotkeys } from "./types";

interface ShellConfig {
  node: string | null;
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

/**
 * Global hotkeys: the shell reports presses and releases over one channel (a reloaded page opens a new one, the
 * shell keeps the newest); the bindings themselves are restored by the client (`voice/hotkeys.ts`).
 */
function createHotkeys(): PlatformHotkeys {
  const handlers = new Set<(event: HotkeyEvent) => void>();
  const channel = new Channel<HotkeyEvent>((event) => {
    for (const handler of handlers) handler(event);
  });
  void invoke<void>("listen_hotkeys", { onEvent: channel }).catch((e: unknown) => console.warn("hotkeys: no channel to the shell", e));
  return {
    register: (action, combo) => invoke<string>("register_hotkey", { action, combo }),
    unregister: (action) => invoke<void>("unregister_hotkey", { action }),
    subscribe: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

/** The desktop platform; `doc` receives the link handler (tests pass a detached document). */
export async function createTauriPlatform(doc: Document = document): Promise<Platform> {
  const [config, info] = await Promise.all([invoke<ShellConfig>("get_config"), invoke<AppInfo>("app_info")]);
  let node = config.node;
  const openExternal = async (url: string) => {
    await invoke<void>("open_external", { url: externalUrl(url) });
  };
  const platform: Platform = {
    kind: "desktop",
    isDesktop: true,
    nodeBase: () => node ?? "",
    // A node serves its web client on the URL the user picked (where links shared with others point to).
    webOrigin: () => node ?? location.origin,
    openExternal,
    appVersion: async () => info.version,
    node: {
      current: () => node,
      set: async (url) => {
        node = await invoke<string>("set_node", { url });
      },
    },
    ...(info.updater ? { updater } : {}),
    hotkeys: createHotkeys(),
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
