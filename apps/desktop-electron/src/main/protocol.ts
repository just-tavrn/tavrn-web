// SPDX-License-Identifier: Apache-2.0
/**
 * The `app://tavrn` scheme: the bundled client (`web/dist`, inside the app's asar archive) served to the main window.
 * The scheme is registered as standard and secure (a secure context with its own origin, fetch, streaming of media,
 * WebAssembly), so the client runs as on a node; `file://` is never used. Files of the bundle are served with their
 * types; hashed build output under `/assets/` is cached as immutable, everything else is revalidated. A document
 * request (`Accept: text/html`) for a path that is no file gets `index.html` (the client's routes); scripts, fetches and
 * images that are not in the bundle get a 404, never HTML. Every document carries the Content Security Policy
 * (`csp.ts`). Nothing outside the bundle's directory is ever read.
 */
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import type { Protocol } from "electron";
import { contentSecurityPolicy } from "./csp.ts";

export const APP_SCHEME = "app";
export const APP_HOST = "tavrn";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** The privileges of the scheme (`protocol.registerSchemesAsPrivileged`, before the app is ready). */
export const APP_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true,
  codeCache: true,
} as const;

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

/** The type of a file of the bundle by its extension. */
export function contentType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Vite's hashed build output (`assets/<name>-<hash>.<ext>`): its content never changes under that name. */
const HASHED = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;
const IMMUTABLE = "public, max-age=31536000, immutable";

/** True for a URL of the bundled client (`app://tavrn/…`). */
export function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST;
  } catch {
    return false;
  }
}

export type AppResponse = { status: 200; file: string; headers: Record<string, string> } | { status: 400 | 404 | 405; headers: Record<string, string> };

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Decides what a request of `app://tavrn` gets from the bundle in `root`. */
export function resolveAppRequest(url: string, accept: string, root: string): AppResponse {
  const base = { "X-Content-Type-Options": "nosniff" };
  if (!isAppUrl(url)) return { status: 404, headers: base };
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return { status: 400, headers: base };
  }
  if (path.includes("\0") || path.includes("\\") || path.split("/").includes("..")) return { status: 404, headers: base };
  const rootDir = normalize(root);
  const candidate = normalize(join(rootDir, path));
  if (candidate !== rootDir && !candidate.startsWith(rootDir.endsWith(sep) ? rootDir : rootDir + sep)) return { status: 404, headers: base };
  const document = /\btext\/html\b/.test(accept);
  let file: string | null = path !== "/" && isFile(candidate) ? candidate : null;
  if (!file && (document || path === "/")) file = join(rootDir, "index.html");
  if (!file || !isFile(file)) return { status: 404, headers: base };
  const type = contentType(file);
  const headers: Record<string, string> = { ...base, "Content-Type": type, "Cache-Control": HASHED.test(path) && file === candidate ? IMMUTABLE : "no-cache" };
  if (type.startsWith("text/html")) headers["Content-Security-Policy"] = contentSecurityPolicy();
  return { status: 200, file, headers };
}

/** Answers a request of the scheme from the bundle in `root`, streaming the file. */
export async function handleAppRequest(request: Request, root: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const r = resolveAppRequest(request.url, request.headers.get("accept") ?? "", root);
  if (r.status !== 200) return new Response(null, { status: r.status, headers: r.headers });
  const size = statSync(r.file).size;
  const headers = { ...r.headers, "Content-Length": String(size) };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const body = Readable.toWeb(createReadStream(r.file)) as ReadableStream<Uint8Array>;
  return new Response(body, { status: 200, headers });
}

/** Serves the bundle in `root` on the scheme of the session that `protocol` belongs to. */
export function installAppProtocol(protocol: Protocol, root: string): void {
  protocol.handle(APP_SCHEME, (request) => handleAppRequest(request, root));
}
