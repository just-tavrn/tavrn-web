// SPDX-License-Identifier: Apache-2.0
/**
 * The app's settings in `<config dir>/tavrn-desktop/settings.json` (Linux `~/.config/tavrn-desktop/`), with the schema
 * of the Tauri shell's `config.json` (`apps/desktop/src-tauri/src/config.rs`): the home node chosen in the node picker,
 * with its identity domain and the origin of its web client when they are known (delegation: both may differ from the
 * node's URL), and "close to tray". A missing, unreadable or corrupt file means "no settings" (the node picker asks
 * again); a stored node that no longer passes the validation is dropped.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NodeUrlError, validIdentityDomain, validateNodeUrl } from "./node_url.ts";

export const DIR_NAME = "tavrn-desktop";
export const FILE_NAME = "settings.json";

export interface Config {
  /** Origin of the home node, or null before the first choice. */
  node: string | null;
  /** Origin of the node's web client (its sign-in page), when its document named one. */
  web: string | null;
  /** Identity domain of the node (`alice@<domain>`), when known. */
  domain: string | null;
  /** Closing the window hides it into the tray; absent: the platform's default. */
  close_to_tray?: boolean;
}

const EMPTY: Config = { node: null, web: null, domain: null };

/** The settings file below the user's config directory (`app.getPath("appData")`, `$XDG_CONFIG_HOME` or `~/.config`). */
export function settingsPath(configDir: string): string {
  return join(configDir, DIR_NAME, FILE_NAME);
}

/** The Tauri shell's settings file below the same directory (`config.rs`: `org.tavrn.desktop/config.json`). */
export function tauriSettingsPath(configDir: string): string {
  return join(configDir, "org.tavrn.desktop", "config.json");
}

/**
 * Switching shells: on the first start (no settings file yet) the home node of the Tauri shell's settings is taken
 * over once, the node URL with its web origin and identity domain only, validated as fresh input (an invalid node
 * imports nothing). Returns the imported node, or null.
 */
export function importTauriSettings(path: string, tauriPath: string): string | null {
  if (existsSync(path) || !existsSync(tauriPath)) return null;
  const theirs = loadConfig(tauriPath);
  if (!theirs.node) return null;
  saveConfig(path, { node: theirs.node, web: theirs.web, domain: theirs.domain });
  console.info(`tavrn: took over the home node ${theirs.node} from the Tauri app's settings (${tauriPath})`);
  return theirs.node;
}

const optionalString = (v: unknown): v is string | null | undefined => v === undefined || v === null || typeof v === "string";

function validOrNull(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return validateNodeUrl(url);
  } catch {
    return null;
  }
}

/** Reads the settings; never fails (see the module documentation). */
export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ...EMPTY };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  // As serde does: a known field of the wrong type makes the whole file unreadable; unknown fields are ignored.
  const doc = raw as Record<string, unknown> | undefined;
  const readable =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) && optionalString(doc?.node) && optionalString(doc?.web) && optionalString(doc?.domain) && (doc?.close_to_tray === undefined || doc?.close_to_tray === null || typeof doc?.close_to_tray === "boolean");
  if (!readable || !doc) {
    console.warn(`tavrn: ignoring the corrupt settings file ${path}`);
    return { ...EMPTY };
  }
  const node = validOrNull(doc.node as string | null | undefined);
  // The web origin and the domain belong to the node: without it they mean nothing.
  const web = node ? validOrNull(doc.web as string | null | undefined) : null;
  const domain = node && typeof doc.domain === "string" && validIdentityDomain(doc.domain) ? doc.domain : null;
  const config: Config = { node, web, domain };
  if (typeof doc.close_to_tray === "boolean") config.close_to_tray = doc.close_to_tray;
  return config;
}

/** Writes the settings atomically (temporary file, then rename), creating the directory. */
export function saveConfig(path: string, config: Config): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const out: Record<string, unknown> = { node: config.node, web: config.web, domain: config.domain };
  if (config.close_to_tray !== undefined) out.close_to_tray = config.close_to_tray;
  writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/** The settings file and its current content. */
export class Settings {
  readonly path: string;
  #config: Config;

  constructor(path: string) {
    this.path = path;
    this.#config = loadConfig(path);
  }

  get(): Config {
    return { ...this.#config };
  }

  /** Changes the settings and writes them; the settings in memory change only when the file was written. */
  update(change: (current: Config) => Config): void {
    const next = change(this.get());
    try {
      saveConfig(this.path, next);
    } catch (e) {
      throw new Error(`config.write_failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.#config = next;
  }

  /**
   * Validates and persists the home node (with the origin of its web client and its identity domain when the client
   * knows them from the node's document); returns its normalized origin. Throws a {@link NodeUrlError}.
   */
  setNode(url: string, web?: string | null, domain?: string | null): string {
    const node = validateNodeUrl(url);
    const webOrigin = web == null ? null : validateNodeUrl(web);
    const identity = domain == null ? null : domain.trim().toLowerCase();
    if (identity !== null && !validIdentityDomain(identity)) throw new NodeUrlError("node_url.domain");
    this.update((c) => ({ ...c, node, web: webOrigin, domain: identity }));
    return node;
  }
}
