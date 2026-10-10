// SPDX-License-Identifier: Apache-2.0
/**
 * The `shell` namespace of the bridge (the Tauri shell's `commands.rs`): the settings with the chosen home node, the
 * app's version, opening web links in the system browser. Node resolution and the sign-in window follow (`resolve.ts`,
 * `connect.ts`); until then they answer "not implemented".
 */
import type { Settings } from "./config.ts";
import { externalLink } from "./guard.ts";
import { check, type IpcRegistry } from "./ipc.ts";

/** Longest node URL, web origin and identity domain the shell looks at (the validation refuses more anyway). */
const URL_MAX = 300;
const DOMAIN_MAX = 253;
/** Longest link handed to the system browser. */
const LINK_MAX = 8192;

export interface ShellDeps {
  settings: Settings;
  /** The installed app's version (`web/package.json`'s). */
  version: string;
  /** Opens a validated web link in the system browser (`shell.openExternal`). */
  openExternal: (url: string) => Promise<void>;
}

export function registerShellHandlers(registry: IpcRegistry, deps: ShellDeps): void {
  const none = check.args([]);
  registry.handle("shell", "getConfig", none, () => deps.settings.get());
  registry.handle("shell", "setNode", check.args([check.string(URL_MAX)], [check.nullableString(URL_MAX), check.nullableString(DOMAIN_MAX)]), (url: string, web?: string | null, domain?: string | null) =>
    deps.settings.setNode(url, web, domain),
  );
  registry.handle("shell", "appInfo", none, () => ({ version: deps.version, updater: false }));
  registry.handle("shell", "openExternal", check.args([check.string(LINK_MAX)]), async (url: string) => {
    const link = externalLink(url);
    if (!link) throw "link.refused";
    await deps.openExternal(link);
  });
}
