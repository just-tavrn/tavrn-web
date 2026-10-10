// SPDX-License-Identifier: Apache-2.0
/**
 * Updates (docs/DESKTOP.md "Updates"): electron-updater against the GitHub releases of tavrn-web, with the feed signed
 * by the same key as the Tauri updater. electron-builder writes the feed's settings into the package
 * (`resources/app-update.yml`, from the `publish` entry of electron-builder.config.mjs) and the release carries the feed
 * (`latest-linux.yml` on Linux, `latest.yml` on Windows) with the SHA-512 of every package, which electron-updater
 * checks after the download. electron-updater has no signature of its own on Linux (and the Windows build is not
 * code-signed yet), so the release also carries `<feed>.minisig`, a minisign signature of the feed made with the
 * Tauri updater's key (release workflow), and the shell refuses an update unless:
 *
 * - the signature verifies with the public key of `plugins.updater.pubkey` in tauri.conf.json (electron-builder.config.mjs
 *   writes it into the package's package.json as `tavrn.updaterPubkey`; minisign.ts), its trusted comment names this
 *   feed file and the feed's version,
 * - the signed feed announces the version electron-updater found, and lists every file electron-updater would download
 *   with the same SHA-512.
 *
 * That check runs before an update is offered and again right before the download, so electron-updater downloads and
 * installs only files whose SHA-512 the key vouches for. A refusal is logged with its reason and answers
 * `update.signature_invalid` (Settings → App shows it). A development run, a package without the feed's settings and a
 * build whose key is missing or the placeholder offer no updates (`updater: false` in `appInfo`). While the repository
 * is private the check fails (GitHub answers 404) and the client stays quiet, as with the Tauri updater. The AppImage
 * replaces itself; the `.deb` is installed with the system's package tools (an administrator password is asked); on
 * Windows the NSIS installer runs.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check, type IpcRegistry } from "./ipc.ts";
import { MinisignError, parsePublicKey, verifyMinisign, type MinisignPublicKey } from "./minisign.ts";

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

/** The error code of a refused update (the client: `errors.update.signature_invalid`). */
export const SIGNATURE_INVALID = "update.signature_invalid";

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
  files?: readonly { url: string; sha512: string }[];
}

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
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo: FoundUpdate & { releaseNotes?: unknown } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** electron-updater, loaded on first use (it needs Electron at import time). */
async function autoUpdater(): Promise<AutoUpdater> {
  const mod = (await import("electron-updater")) as unknown as { autoUpdater?: AutoUpdater; default?: { autoUpdater: AutoUpdater } };
  const updater = mod.autoUpdater ?? mod.default?.autoUpdater;
  if (!updater) throw new Error("update.unavailable");
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  return updater;
}

/** The `updater` namespace of the bridge (the Tauri shell's `check_update` and `install_update`). */
export function registerUpdaterHandlers(registry: IpcRegistry, feed: FeedCheck | null, load: () => Promise<AutoUpdater> = autoUpdater): void {
  const newer = async () => {
    if (!feed) throw "update.not_configured";
    const updater = await load();
    const found = await updater.checkForUpdates();
    const info = found?.isUpdateAvailable ? found.updateInfo : null;
    // Before anything is offered or downloaded: the feed must be signed with the app's key and match.
    if (info) await verifyFeed(feed, info);
    return { updater, found: info };
  };
  registry.handle("updater", "checkUpdate", check.args([]), async (): Promise<UpdateInfo | null> => {
    const { found } = await newer();
    return found ? { version: found.version, notes: notesText(found.releaseNotes) } : null;
  });
  registry.handle("updater", "installUpdate", check.args([]), async () => {
    const { updater, found } = await newer();
    if (!found) throw "update.none";
    await updater.downloadUpdate();
    updater.quitAndInstall(false, true);
  });
}
