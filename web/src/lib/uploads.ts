// SPDX-License-Identifier: Apache-2.0
/**
 * Upload categories (PROTOCOL.md §7a), the client half: the same table as the node (`tavrn-node/src/uploads.rs`).
 * Plaintext uploads are classified by the node anyway; encrypted uploads are ciphertext, so the client
 * classifies the file and declares the category (`Tavrn-Upload-Category`). The composer also uses it to
 * filter the file picker and to refuse files the user may not upload before sending anything.
 */

export const UPLOAD_CATEGORIES = ["images", "audio", "video", "documents", "archives", "other"] as const;
export type UploadCategory = (typeof UPLOAD_CATEGORIES)[number];

export interface Classified {
  category: UploadCategory;
  executable: boolean;
}

export const DANGEROUS_EXTENSIONS = new Set(
  (
    "exe msi msix msp appx appxbundle bat cmd com pif scr cpl hta reg lnk url inf ps1 psm1 psd1 vbs vbe js jse mjs wsf wsh wsc sct jar class " +
    "apk aab xapk ipa dmg pkg mpkg app command sh bash zsh csh ksh fish run bin elf deb rpm snap flatpakref appimage iso img vhd vhdx xll docm " +
    "xlsm pptm dotm xltm potm ppam xlam gadget msc application scf dll sys drv ocx py pyw pl rb php desktop workflow action website settingcontent-ms"
  ).split(" "),
);

const EXTENSIONS: Record<Exclude<UploadCategory, "other">, string[]> = {
  images: "png jpg jpeg jfif gif webp avif bmp ico tif tiff heic heif".split(" "),
  audio: "mp3 ogg oga opus wav flac m4a aac weba mid midi".split(" "),
  video: "mp4 m4v mov webm mkv avi ogv wmv flv 3gp".split(" "),
  // SVG can carry scripts: a document (download only), never an image (design note 4.12).
  documents: "pdf txt md markdown csv tsv json xml yaml yml toml ini cfg conf log rtf doc docx odt xls xlsx ods ppt pptx odp epub srt vtt svg svgz".split(" "),
  archives: "zip 7z rar tar gz tgz bz2 tbz2 xz txz zst lz lzma".split(" "),
};

const DANGEROUS_TYPES = [
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-ms-installer",
  "application/x-executable",
  "application/x-sh",
  "application/x-bat",
  "application/java-archive",
  "application/vnd.android.package-archive",
  "application/x-apple-diskimage",
  "application/x-iso9660-image",
  "application/javascript",
  "text/javascript",
  "application/hta",
  "application/x-ms-shortcut",
];

/** Last extension, lowercase (`"a.tar.gz"` → `gz`); trailing dots and spaces are ignored like on Windows. */
export function extensionOf(name: string): string {
  const clean = name.trim().replace(/[. ]+$/, "");
  const dot = clean.lastIndexOf(".");
  if (dot <= 0 || dot === clean.length - 1) return "";
  const ext = clean.slice(dot + 1).toLowerCase();
  return ext.length <= 24 ? ext : "";
}

function categoryOfExtension(ext: string): UploadCategory | null {
  for (const [cat, list] of Object.entries(EXTENSIONS)) if (list.includes(ext)) return cat as UploadCategory;
  return null;
}

function categoryOfType(type: string): UploadCategory | null {
  const t = type.split(";")[0]!.trim().toLowerCase();
  const [top, sub = ""] = t.split("/");
  if (top === "image") return sub === "svg+xml" ? "documents" : "images";
  if (top === "audio") return "audio";
  if (top === "video") return "video";
  if (top === "text") return "documents";
  if (top === "application") {
    if (["pdf", "json", "xml", "rtf", "epub+zip", "msword", "vnd.ms-excel", "vnd.ms-powerpoint"].includes(sub)) return "documents";
    if (sub.startsWith("vnd.openxmlformats-officedocument.") || sub.startsWith("vnd.oasis.opendocument.")) return "documents";
    if (["zip", "x-7z-compressed", "vnd.rar", "x-rar-compressed", "x-tar", "gzip", "x-gzip", "x-bzip2", "x-xz", "zstd"].includes(sub)) return "archives";
  }
  return null;
}

/** Magic bytes of executables (the node checks more; this catches the common renamed binaries). */
export function looksExecutable(head: Uint8Array): boolean {
  const starts = (...b: number[]) => b.every((v, i) => head[i] === v);
  return starts(0x4d, 0x5a) || starts(0x7f, 0x45, 0x4c, 0x46) || starts(0x23, 0x21) || starts(0xca, 0xfe, 0xba, 0xbe) || starts(0xcf, 0xfa, 0xed, 0xfe) || starts(0xce, 0xfa, 0xed, 0xfe);
}

/** Category by name and type (and, if given, the first bytes). */
export function classifyName(name: string, type: string, head?: Uint8Array): Classified {
  const ext = extensionOf(name);
  const t = type.toLowerCase();
  if (DANGEROUS_EXTENSIONS.has(ext) || DANGEROUS_TYPES.some((d) => t.startsWith(d)) || (head && looksExecutable(head))) {
    return { category: "other", executable: true };
  }
  return { category: categoryOfExtension(ext) ?? categoryOfType(type) ?? "other", executable: false };
}

/** Classifies a file, reading its first bytes. */
export async function classifyFile(file: File): Promise<Classified> {
  let head: Uint8Array | undefined;
  try {
    head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  } catch {
    head = undefined;
  }
  return classifyName(file.name, file.type, head);
}

/** The value of `Tavrn-Upload-Category` for an encrypted upload. */
export function declaredCategory(c: Classified): string {
  return c.executable ? "executable" : c.category;
}

/** May this file be uploaded under the policy? */
export function isAllowed(c: Classified, allowed: readonly string[], executablesAllowed: boolean): boolean {
  if (c.executable && !executablesAllowed) return false;
  return allowed.includes(c.category);
}

/** `accept` attribute for a file input: empty (anything) when `other` is allowed. */
export function acceptFor(allowed: readonly string[]): string {
  if (allowed.includes("other")) return "";
  const parts: string[] = [];
  for (const cat of allowed) {
    if (cat === "images") parts.push("image/*");
    if (cat === "audio") parts.push("audio/*");
    if (cat === "video") parts.push("video/*");
    if (cat === "documents") parts.push("text/*", "application/pdf");
    const exts = EXTENSIONS[cat as Exclude<UploadCategory, "other">];
    if (exts) parts.push(...exts.map((e) => `.${e}`));
  }
  return [...new Set(parts)].join(",");
}
