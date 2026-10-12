// SPDX-License-Identifier: Apache-2.0
/**
 * Updates (docs/DESKTOP.md "Updates"): electron-updater against the website's per-channel feed
 * (`https://tavrn.org/updates/desktop/<channel>/`, electron-updater's generic provider, set before every check), which
 * redirects `latest-linux.yml` / `latest.yml` and the packages next to them to the right GitHub release of tavrn-web
 * (GitHub's own "latest" never points at a pre-release). The channel is a setting (`config.ts` `update_channel`): beta
 * by default when this version is a pre-release (`-rc.`, `-beta.`), else stable; an explicit choice sticks, and
 * electron-updater only offers a higher version (0.4.0 > 0.4.0-rc.4), so stable from an rc waits for the release.
 * The feed is signed by the same key as the Tauri updater. electron-builder writes the package's repository into
 * `resources/app-update.yml` (the `publish` entry of electron-builder.config.mjs), and the release carries the feed
 * (`latest-linux.yml` on Linux, `latest.yml` on Windows) with the SHA-512 of every package, which electron-updater
 * checks after the download. electron-updater has no signature of its own on Linux (and the Windows build is not
 * code-signed yet), so the release also carries `<feed>.minisig`, a minisign signature of the feed made with the
 * Tauri updater's key (release workflow), and the shell refuses an update unless:
 *
 * - the signature verifies with the public key of `plugins.updater.pubkey` in tauri.conf.json (electron-builder.config.mjs
 *   writes it into the package's package.json as `tavrn.updaterPubkey`; minisign.ts), its trusted comment names this
 *   feed file and the feed's version,
 * - the signed feed announces the version electron-updater found, and lists every file electron-updater would download
 *   with the same SHA-512;
 * - everything else electron-updater parsed from its own (unsigned) copy of the feed equals the signed feed: every
 *   top-level field (path, sha512, release date, administrator rights, staged rollout, …) and every field of every file
 *   (size, block map size, …); only the release name and notes the GitHub provider adds are exempt (shown as text).
 *   A feed with web-installer `packages` is refused outright, and electron-updater's web installer is switched off.
 *
 * That check reads the feed and its signature straight from the release of the found version on GitHub
 * (`releases/download/v<version>/`), independent of the website. It runs before an update is offered and again right
 * before the download, so electron-updater downloads and installs only files whose SHA-512 the key vouches for. A
 * refusal is logged with its reason and answers `update.signature_invalid` (Settings → App shows it); other failures
 * answer `update.unreachable` (no network, the website's 503), `update.no_release` (the website's 404: no release in
 * this channel) or `update.failed` ({@link updateErrorCode}). A development run, a package without the feed's settings
 * and a build whose key is missing or the placeholder offer no updates (`updater: false` in `appInfo`). The AppImage
 * replaces itself; the `.deb` is installed with the system's package tools (an administrator password is asked); on
 * Windows the NSIS installer runs.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Settings } from "./config.ts";
import { check, type IpcRegistry } from "./ipc.ts";
import { MinisignError, parsePublicKey, verifyMinisign, type MinisignPublicKey } from "./minisign.ts";

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

/** The error code of a refused update (the client: `errors.update.signature_invalid`). */
export const SIGNATURE_INVALID = "update.signature_invalid";
/** The update server could not be reached, or has no release list right now. */
export const UNREACHABLE = "update.unreachable";
/** The chosen channel has no release (the website's 404 `no_release`). */
export const NO_RELEASE = "update.no_release";
/** Anything else (logged with its reason). */
export const FAILED = "update.failed";

/** Where the website serves the update feeds, one directory per channel. */
export const FEED_BASE = "https://tavrn.org/updates/desktop";

/** `stable` offers releases only, `beta` pre-releases too. */
export type UpdateChannel = "stable" | "beta";
export const UPDATE_CHANNELS: readonly UpdateChannel[] = ["stable", "beta"];

/** Without a choice: a pre-release (`-rc.`, `-beta.`) follows beta, a release stable (the Tauri shell's rule). */
export function defaultChannel(version: string): UpdateChannel {
  return version.includes("-rc.") || version.includes("-beta.") ? "beta" : "stable";
}

/** The stored choice when it is a channel, else the default for this version. */
export function effectiveChannel(stored: unknown, version: string): UpdateChannel {
  return stored === "stable" || stored === "beta" ? stored : defaultChannel(version);
}

/** The generic provider's URL of a channel: electron-updater reads `<url>latest-linux.yml` (or `latest.yml`) there. */
export function feedUrl(channel: UpdateChannel, base: string = FEED_BASE): string {
  return `${base.replace(/\/+$/, "")}/${channel}/`;
}

/** The update channel in the settings file, with the default of this version. */
export interface ChannelSetting {
  get(): UpdateChannel;
  set(channel: UpdateChannel): void;
}

export function channelSetting(settings: Settings, version: string): ChannelSetting {
  return {
    get: () => effectiveChannel(settings.get().update_channel, version),
    set: (channel) => settings.update((c) => ({ ...c, update_channel: channel })),
  };
}

const NETWORK_CODES = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE|ERR_NETWORK)/;

/** The client's code for a failed check or download (electron-updater's errors, Chromium's network errors). */
export function updateErrorCode(e: unknown): string {
  if (typeof e === "string" && e.startsWith("update.")) return e;
  const err = (e ?? {}) as { code?: unknown; statusCode?: unknown; message?: unknown };
  const code = typeof err.code === "string" ? err.code : "";
  const status = typeof err.statusCode === "number" ? err.statusCode : 0;
  const message = typeof err.message === "string" ? err.message : String(e);
  // The website's 404 (no release in the channel): electron-updater's generic provider names it like this.
  if (code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" || status === 404) return NO_RELEASE;
  if (status >= 500 || NETWORK_CODES.test(code) || /net::ERR_|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/.test(message)) return UNREACHABLE;
  return FAILED;
}

/** A response of `fetch` as the check reads it (Electron's `net.fetch` in the app). */
export interface FeedResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Where the signed feed is and the key that must have signed it. */
export interface FeedCheck {
  source: { owner: string; repo: string };
  /** The feed file of this platform (`channelFile`). */
  channel: string;
  publicKey: MinisignPublicKey;
  fetch: (url: string) => Promise<FeedResponse>;
  log?: (message: string) => void;
}

/** What the check compares with the signed feed: electron-updater's `updateInfo` (the GitHub provider adds `tag`). */
export interface FoundUpdate {
  version: string;
  tag?: string;
  files?: readonly ({ url: string; sha512: string } & Record<string, unknown>)[];
  [field: string]: unknown;
}

/** Fields of `updateInfo` the GitHub provider adds from the release page (not from the feed); shown as text only. */
const PROVIDER_FIELDS = new Set(["tag", "releaseName", "releaseNotes"]);

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_FEED = 256 * 1024;
const MAX_SIGNATURE = 4 * 1024;

function scalar(value: string): string {
  const v = value.trim();
  return /^'.*'$|^".*"$/.test(v) ? v.slice(1, -1) : v;
}

/** The GitHub repository of `app-update.yml` (electron-builder's `publish` entry); null for anything else. */
export function feedSource(appUpdateYml: string): { owner: string; repo: string } | null {
  const fields: Record<string, string> = {};
  for (const line of appUpdateYml.split(/\r?\n/)) {
    const m = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (m) fields[m[1]!] = scalar(m[2]!);
  }
  const { provider, owner, repo } = fields;
  return provider === "github" && owner && repo && NAME.test(owner) && NAME.test(repo) && !owner.includes("..") && !repo.includes("..") ? { owner, repo } : null;
}

/** The feed file electron-updater reads on this platform (its `Provider.getChannelFilePrefix`). */
export function channelFile(platform: NodeJS.Platform, arch: string): string {
  if (platform === "linux") return `latest-linux${arch === "x64" ? "" : `-${arch}`}.yml`;
  return platform === "darwin" ? "latest-mac.yml" : "latest.yml";
}

/** The version and the files of an electron-builder feed (its fixed YAML layout: `files:` with `- url:` and `sha512:`). */
export function parseFeed(text: string): { version: string; files: { url: string; sha512: string }[] } {
  let version = "";
  const files: { url: string; sha512: string }[] = [];
  let inFiles = false;
  let current: { url: string; sha512: string } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const top = /^([A-Za-z0-9]+):\s*(.*)$/.exec(line);
    if (top) {
      inFiles = top[1] === "files";
      current = null;
      if (top[1] === "version") version = scalar(top[2]!);
      continue;
    }
    if (!inFiles) continue;
    const url = /^\s+-\s+url:\s*(.+)$/.exec(line);
    if (url) {
      current = { url: scalar(url[1]!), sha512: "" };
      files.push(current);
      continue;
    }
    const sha = /^\s+sha512:\s*(.+)$/.exec(line);
    if (sha && current) current.sha512 = scalar(sha[1]!);
  }
  return { version, files };
}

/**
 * Every field of an electron-builder feed: the top-level scalars, the scalar fields of each `files` entry, and the names
 * of all top-level keys (also those with nested values, like `packages`).
 */
export function parseFeedFields(text: string): { top: Record<string, string>; files: Record<string, string>[]; keys: Set<string> } {
  const top: Record<string, string> = {};
  const files: Record<string, string>[] = [];
  const keys = new Set<string>();
  let inFiles = false;
  let current: Record<string, string> | null = null;
  for (const line of text.split(/\r?\n/)) {
    const key = /^([A-Za-z0-9]+):\s*(.*)$/.exec(line);
    if (key) {
      keys.add(key[1]!);
      inFiles = key[1] === "files";
      current = null;
      if (key[2]!.trim() !== "") top[key[1]!] = scalar(key[2]!);
      continue;
    }
    if (!inFiles) continue;
    const item = /^\s+-\s+([A-Za-z0-9]+):\s*(.*)$/.exec(line);
    if (item) {
      current = { [item[1]!]: scalar(item[2]!) };
      files.push(current);
      continue;
    }
    const field = /^\s+([A-Za-z0-9]+):\s*(.*)$/.exec(line);
    if (field && current) current[field[1]!] = scalar(field[2]!);
  }
  return { top, files, keys };
}

/** A parsed scalar as the feed's text has it (dates as electron-builder writes them). */
function same(found: unknown, signed: string | undefined): boolean {
  if (signed === undefined) return false;
  if (found instanceof Date) return !Number.isNaN(Date.parse(signed)) && found.getTime() === Date.parse(signed);
  if (typeof found === "string" || typeof found === "number" || typeof found === "boolean") return String(found) === signed;
  return false;
}

/** Throws unless every field electron-updater parsed (apart from the provider's) equals the signed feed's. */
function compareWholeInfo(found: FoundUpdate, signed: ReturnType<typeof parseFeedFields>): void {
  if (signed.keys.has("packages") || found.packages !== undefined) throw new MinisignError("the feed lists web-installer packages, which this app never installs");
  for (const [field, value] of Object.entries(found)) {
    if (PROVIDER_FIELDS.has(field) || field === "files" || value === undefined || value === null) continue;
    if (!same(value, signed.top[field])) throw new MinisignError(`${field} differs from the signed feed`);
  }
  for (const file of found.files ?? []) {
    const match = signed.files.find((f) => f.url === file.url && f.sha512 === file.sha512);
    if (!match) continue; // reported by the files check
    for (const [field, value] of Object.entries(file)) {
      if (value === undefined || value === null) continue;
      if (!same(value, match[field])) throw new MinisignError(`${field} of ${file.url} differs from the signed feed`);
    }
  }
}

/** The feed's settings and the update key of a package, or null: no updates (development, no feed, no valid key). */
export function updaterSetup(opts: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform: NodeJS.Platform;
  arch: string;
  fetch: FeedCheck["fetch"];
  log?: (message: string) => void;
}): FeedCheck | null {
  const feedSettings = join(opts.resourcesPath, "app-update.yml");
  if (!opts.packaged || !existsSync(feedSettings)) return null;
  try {
    const source = feedSource(readFileSync(feedSettings, "utf8"));
    const pubkey = (JSON.parse(readFileSync(join(opts.appPath, "package.json"), "utf8")) as { tavrn?: { updaterPubkey?: unknown } }).tavrn?.updaterPubkey;
    if (!source || typeof pubkey !== "string") return null;
    return { source, channel: channelFile(opts.platform, opts.arch), publicKey: parsePublicKey(pubkey), fetch: opts.fetch, log: opts.log };
  } catch {
    return null;
  }
}

async function download(check: FeedCheck, url: string, limit: number): Promise<Buffer> {
  const name = url.slice(url.lastIndexOf("/") + 1);
  let response: FeedResponse;
  try {
    response = await check.fetch(url);
  } catch (e) {
    throw new MinisignError(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!response.ok) throw new MinisignError(`${name}: HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > limit) throw new MinisignError(`${name}: larger than ${limit} bytes`);
  return body;
}

/**
 * Fetches the feed of the found release and its `.minisig`, verifies the signature and compares the signed feed with
 * what electron-updater found. Resolves when the update may be offered and downloaded; otherwise logs the reason and
 * rejects with `update.signature_invalid`.
 */
export async function verifyFeed(check: FeedCheck, found: FoundUpdate): Promise<void> {
  try {
    const tag = found.tag ?? `v${found.version}`;
    if (!TAG.test(tag)) throw new MinisignError(`the release tag ${JSON.stringify(tag)} is not a version tag`);
    const base = `https://github.com/${check.source.owner}/${check.source.repo}/releases/download/${encodeURIComponent(tag)}/${check.channel}`;
    const feed = await download(check, base, MAX_FEED);
    const signature = (await download(check, `${base}.minisig`, MAX_SIGNATURE)).toString("utf8");
    const { fields } = verifyMinisign(feed, signature, check.publicKey);
    const signedFeed = parseFeed(feed.toString("utf8"));
    if (fields.file !== check.channel) throw new MinisignError(`the signature was signed for ${fields.file ?? "no file name"}, not ${check.channel}`);
    if (fields.version !== signedFeed.version) throw new MinisignError(`the signature was signed for version ${fields.version ?? "(none)"}, the feed says ${signedFeed.version}`);
    if (signedFeed.version !== found.version) throw new MinisignError(`the signed feed announces ${signedFeed.version}, electron-updater found ${found.version}`);
    const files = found.files ?? [];
    if (files.length === 0) throw new MinisignError("electron-updater found no files to download");
    for (const file of files) {
      if (!signedFeed.files.some((f) => f.url === file.url && f.sha512 === file.sha512)) throw new MinisignError(`${file.url} is not in the signed feed with this SHA-512`);
    }
    compareWholeInfo(found, parseFeedFields(feed.toString("utf8")));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    (check.log ?? ((m: string) => console.error(m)))(`tavrn: refused the update to ${found.version}: ${reason}`);
    throw SIGNATURE_INVALID;
  }
}

/** Release notes as plain text (the GitHub feed answers HTML, several releases as a list). */
export function notesText(notes: unknown): string | null {
  const text = typeof notes === "string" ? notes : Array.isArray(notes) ? notes.map((n) => (typeof n?.note === "string" ? n.note : "")).join("\n\n") : "";
  const plain = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h\d)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return plain ? plain.slice(0, 10_000) : null;
}

interface AutoUpdater {
  autoDownload: boolean;
  /** The feed of the chosen channel (the generic provider replaces the package's `app-update.yml` settings). */
  setFeedURL(options: { provider: "generic"; url: string }): void;
  autoInstallOnAppQuit: boolean;
  /** NSIS web installer packages (`packages` in the feed): never used by this app. */
  disableWebInstaller?: boolean;
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo: FoundUpdate & { releaseNotes?: unknown } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** electron-updater, loaded on first use (it needs Electron at import time). */
async function autoUpdater(): Promise<AutoUpdater> {
  const mod = (await import("electron-updater")) as unknown as { autoUpdater?: AutoUpdater; default?: { autoUpdater: AutoUpdater } };
  const updater = mod.autoUpdater ?? mod.default?.autoUpdater;
  if (!updater) throw new Error("update.unavailable");
  return updater;
}

/** Nothing happens on electron-updater's own initiative, and never through a web installer. */
function configure(updater: AutoUpdater): AutoUpdater {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.disableWebInstaller = true;
  return updater;
}

/** A failure as the client receives it: one of the codes, the reason logged. */
function failure(e: unknown, log: (message: string) => void): never {
  const code = updateErrorCode(e);
  if (code !== SIGNATURE_INVALID && code !== "update.none" && code !== "update.not_configured") log(`tavrn: the update failed (${code}): ${e instanceof Error ? e.message : String(e)}`);
  throw code;
}

/**
 * The `updater` namespace of the bridge (the Tauri shell's `check_update`, `install_update`, `get_update_channel` and
 * `set_update_channel`).
 */
export function registerUpdaterHandlers(
  registry: IpcRegistry,
  feed: FeedCheck | null,
  load: () => Promise<AutoUpdater> = autoUpdater,
  channel: ChannelSetting = { get: () => "stable", set: () => undefined },
  base: string = FEED_BASE,
): void {
  const log = feed?.log ?? ((m: string) => console.error(m));
  const newer = async () => {
    if (!feed) throw "update.not_configured";
    const updater = configure(await load());
    updater.setFeedURL({ provider: "generic", url: feedUrl(channel.get(), base) });
    const found = await updater.checkForUpdates();
    const info = found?.isUpdateAvailable ? found.updateInfo : null;
    // Before anything is offered or downloaded: the feed must be signed with the app's key and match.
    if (info) await verifyFeed(feed, info);
    return { updater, found: info };
  };
  registry.handle("updater", "checkUpdate", check.args([]), async (): Promise<UpdateInfo | null> => {
    try {
      const { found } = await newer();
      return found ? { version: found.version, notes: notesText(found.releaseNotes) } : null;
    } catch (e) {
      failure(e, log);
    }
  });
  registry.handle("updater", "installUpdate", check.args([]), async () => {
    try {
      const { updater, found } = await newer();
      if (!found) throw "update.none";
      await updater.downloadUpdate();
      updater.quitAndInstall(false, true);
    } catch (e) {
      failure(e, log);
    }
  });
  registry.handle("updater", "getUpdateChannel", check.args([]), (): UpdateChannel => channel.get());
  registry.handle("updater", "setUpdateChannel", check.args([check.oneOf(...UPDATE_CHANNELS)]), (next: UpdateChannel) => channel.set(next));
}
