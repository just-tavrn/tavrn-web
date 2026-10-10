// SPDX-License-Identifier: Apache-2.0
/**
 * The `shell` namespace of the bridge (the Tauri shell's `commands.rs`): the settings with the chosen home node, the
 * app's version, opening web links in the system browser, finding the node of an address (`resolve.ts`) and the
 * sign-in window (`connect.ts`).
 */
import type { Settings } from "./config.ts";
import { connectUrl, externalLink } from "./guard.ts";
import { check, type IpcRegistry } from "./ipc.ts";
import type { Resolved } from "./resolve.ts";

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
  /** Whether this build updates itself (`updater.ts`). */
  updater: boolean;
  /** The node of an identity domain; rejects with a resolve failure. */
  resolve: (domain: string) => Promise<Resolved>;
  /** The sign-in window: shows a validated URL, closes. */
  connect: { open: (url: string) => Promise<void>; close: () => void };
}

/** The longest sign-in page URL (session, state, mode, method and the key fragment fit easily). */
const CONNECT_MAX = 2048;

export function registerShellHandlers(registry: IpcRegistry, deps: ShellDeps): void {
  const none = check.args([]);
  registry.handle("shell", "getConfig", none, () => deps.settings.get());
  registry.handle("shell", "setNode", check.args([check.string(URL_MAX)], [check.nullableString(URL_MAX), check.nullableString(DOMAIN_MAX)]), (url: string, web?: string | null, domain?: string | null) =>
    deps.settings.setNode(url, web, domain),
  );
  registry.handle("shell", "appInfo", none, () => ({ version: deps.version, updater: deps.updater }));
  registry.handle("shell", "openExternal", check.args([check.string(LINK_MAX)]), async (url: string) => {
    const link = externalLink(url);
    if (!link) throw "link.refused";
    await deps.openExternal(link);
  });
  registry.handle("shell", "resolveNode", check.args([check.string(URL_MAX)]), (domain: string) => deps.resolve(domain));
  registry.handle("shell", "openConnect", check.args([check.string(CONNECT_MAX)]), async (url: string) => {
    const { web, node } = deps.settings.get();
    const origin = web ?? node;
    if (!origin) throw "connect.no_node";
    const checked = connectUrl(url, origin);
    if (!checked.ok) throw `connect.url_refused: ${checked.error}`;
    await deps.connect.open(checked.url);
  });
  registry.handle("shell", "closeConnect", none, () => deps.connect.close());
}
