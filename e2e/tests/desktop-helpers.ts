// SPDX-License-Identifier: Apache-2.0
/**
 * A simulated desktop shell for Playwright (docs/DESKTOP.md "Tests"): an init script answers the shell's commands
 * like `src-tauri` does, with the chosen node in sessionStorage, the OS keychain in localStorage (both survive reloads
 * like the real config file and keychain), and records of the native notifications and the tray. Its event channel
 * works like Tauri's (`transformCallback` + `Channel`), so tests can click a notification or a tray menu item.
 */
import type { Page } from "@playwright/test";

export interface ShellRecord {
  notices: Array<{ title: string; body: string; path: string | null }>;
  tray: Array<{ state: string; labels: Record<string, string> }>;
  closeToTray: boolean;
  quit: number;
}

/** The fake shell; `keychain: "unavailable"` simulates a session without a Secret Service. */
export async function asDesktopShell(page: Page, opts: { node: string; keychain?: "available" | "unavailable" }) {
  await page.addInitScript(
    ({ node, keychain }) => {
      const NODE = "e2e.desktop.node";
      const KEYS = "e2e.desktop.keychain";
      const MODE = "e2e.desktop.keychain.mode";
      if (sessionStorage.getItem(NODE) === null) sessionStorage.setItem(NODE, node);
      if (localStorage.getItem(MODE) === null) localStorage.setItem(MODE, keychain);
      const keys = (): Record<string, number[]> => JSON.parse(localStorage.getItem(KEYS) ?? "{}");
      const available = () => localStorage.getItem(MODE) === "available";
      const record = { notices: [], tray: [], closeToTray: true, quit: 0 } as {
        notices: unknown[];
        tray: unknown[];
        closeToTray: boolean;
        quit: number;
      };
      const callbacks = new Map<number, (m: unknown) => void>();
      let nextId = 1;
      let channel: number | null = null;
      let index = 0;
      const w = window as unknown as Record<string, unknown>;
      // The window's focus decides between in-app and native notifications; tests switch it.
      Document.prototype.hasFocus = () => w.__e2eFocused !== false;
      w.__e2eShell = {
        record,
        emit: (event: unknown) => channel !== null && callbacks.get(channel)?.({ index: index++, message: event }),
      };
      w.isTauri = true;
      w.__TAURI_INTERNALS__ = {
        transformCallback: (cb: (m: unknown) => void) => {
          const id = nextId++;
          callbacks.set(id, cb);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (cmd: string, args: Record<string, unknown>) => {
          const account = String(args?.account ?? "");
          switch (cmd) {
            case "get_config":
              return { node: sessionStorage.getItem(NODE) };
            case "app_info":
              return { version: "0.2.0", updater: false };
            case "set_node":
              sessionStorage.setItem(NODE, String(args.url));
              return args.url;
            case "open_external":
              return null;
            case "keychain_status":
              return { backend: available() ? "secret-service" : "none", available: available() };
            case "keychain_get":
              if (!available()) throw "keychain.unavailable";
              return keys()[account] ?? null;
            case "keychain_set": {
              if (!available()) throw "keychain.unavailable";
              const secret = args.secret as number[];
              if (secret.length !== 32) throw "keychain.invalid";
              localStorage.setItem(KEYS, JSON.stringify({ ...keys(), [account]: secret }));
              return null;
            }
            case "keychain_delete": {
              if (!available()) throw "keychain.unavailable";
              const k = keys();
              delete k[account];
              localStorage.setItem(KEYS, JSON.stringify(k));
              return null;
            }
            case "notify":
              record.notices.push(args.notice);
              return null;
            case "shell_events":
              channel = (args.onEvent as { id: number }).id;
              return null;
            case "tray_set":
              record.tray.push({ state: args.state, labels: args.labels });
              return null;
            case "tray_status": {
              const last = record.tray.at(-1) as { state: string; labels: { tooltip: string } } | undefined;
              return { state: last?.state ?? "disconnected", tooltip: last?.labels.tooltip ?? "Tavrn", available: true, close_to_tray: record.closeToTray };
            }
            case "set_close_to_tray":
              record.closeToTray = !!args.on;
              return null;
            case "quit_app":
              record.quit++;
              return null;
          }
          throw `unknown command ${cmd}`;
        },
      };
    },
    { node: opts.node, keychain: opts.keychain ?? "available" },
  );
}

/** What the fake shell recorded so far. */
export function shellRecord(page: Page): Promise<ShellRecord> {
  return page.evaluate(() => (window as unknown as { __e2eShell: { record: ShellRecord } }).__e2eShell.record);
}

/** An event of the shell: a notification click (`open`) or a tray menu item (`tray`). */
export function shellEmit(page: Page, event: { kind: "open"; path: string } | { kind: "tray"; action: "mute" | "deafen" | "leave" }) {
  return page.evaluate((e) => (window as unknown as { __e2eShell: { emit: (e: unknown) => void } }).__e2eShell.emit(e), event);
}

/** The simulated keychain's entries (account → 32 bytes). */
export function keychainEntries(page: Page): Promise<Record<string, number[]>> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("e2e.desktop.keychain") ?? "{}"));
}

/** Makes the simulated keychain (un)available, as if the Secret Service came or went. */
export function setKeychain(page: Page, mode: "available" | "unavailable") {
  return page.evaluate((m) => localStorage.setItem("e2e.desktop.keychain.mode", m), mode);
}

/** The IndexedDB record of the account in the local key store (the persisted key, if any, is a CryptoKey there). */
export function keyStoreRecord(page: Page, account: string): Promise<{ hasKey: boolean; keychain: boolean } | null> {
  return page.evaluate(
    (acc) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("tavrn-crypto", 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const get = req.result.transaction("accounts").objectStore("accounts").get(acc);
          get.onsuccess = () => {
            const r = get.result as { key?: unknown; keychain?: boolean } | undefined;
            req.result.close();
            resolve(r ? { hasKey: !!r.key, keychain: !!r.keychain } : null);
          };
        };
      }),
    account,
  );
}
