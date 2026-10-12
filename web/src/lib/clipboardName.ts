// SPDX-License-Identifier: Apache-2.0
/**
 * Names for files pasted from the clipboard. A pasted screenshot arrives with the name the browser or the operating
 * system made up (`image.png` in Chromium, `{GUID}.png` on Windows, `unknown.png` …); a file copied from a file
 * manager keeps its real name. Only the made-up names are replaced, by "<word> <local date> <time>.<ext>", so the
 * user is never asked and real names survive (tavrn-web #95).
 */

const GENERIC = /^(?:image|unknown|blob|pasted[-_ ]?image|clipboard|grafik|bild)(?:[-_ ]?\d+)?\.[a-z0-9]+$|^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?\.[a-z0-9]+$/i;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

/** True for the names browsers and operating systems make up for clipboard images. */
export function isGenericClipboardName(name: string): boolean {
  return name === "" || GENERIC.test(name);
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The name to upload a pasted file under: the original when it looks like a real file name, otherwise
 * `${word} YYYY-MM-DD HH-MM.ext` with the extension from the MIME type (the original extension as the fallback).
 */
export function clipboardFileName(file: Pick<File, "name" | "type">, word: string, now = new Date()): string {
  if (!isGenericClipboardName(file.name)) return file.name;
  const fromName = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase() : "";
  const ext = EXTENSIONS[file.type] ?? (fromName || "bin");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
  return `${word} ${stamp}.${ext}`;
}

/** The pasted files with their names fixed; a `File` with a new name shares the bytes of the original. */
export function renameClipboardFiles(files: File[], word: string, now = new Date()): File[] {
  return files.map((f) => {
    const name = clipboardFileName(f, word, now);
    return name === f.name ? f : new File([f], name, { type: f.type, lastModified: f.lastModified });
  });
}
