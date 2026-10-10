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

/** What kind of program a file is (the download warning names it); every kind is `other` + executable for uploads. */
export type ExecutableKind = "windows" | "linux" | "macos" | "java" | "mobile_app" | "script" | "shortcut" | "installer" | "disk_image" | "macro_document" | "library" | "program";

/** Bytes {@link executableKind} looks at: disk images carry their signature at 32–36 KiB. */
export const HEAD_BYTES = 0x9001 + 5;

/** Magic bytes of executables, scripts, shortcuts and disk images (`sniff` of the node's uploads.rs). */
function sniffKind(head: Uint8Array): ExecutableKind | null {
  const at = (offset: number, ...b: number[]) => b.every((v, i) => head[offset + i] === v);
  const text = (offset: number, s: string) => at(offset, ...[...s].map((c) => c.charCodeAt(0)));
  if (text(0, "MZ")) return "windows";
  if (at(0, 0x7f, 0x45, 0x4c, 0x46)) return "linux";
  if (text(0, "#!")) return "script";
  if (text(0, "dex\n")) return "mobile_app";
  // Java class files and universal Mach-O binaries share this one.
  if (at(0, 0xca, 0xfe, 0xba, 0xbe)) return "java";
  if (at(0, 0xfe, 0xed, 0xfa, 0xce) || at(0, 0xfe, 0xed, 0xfa, 0xcf) || at(0, 0xce, 0xfa, 0xed, 0xfe) || at(0, 0xcf, 0xfa, 0xed, 0xfe)) return "macos";
  if (at(0, 0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0x00)) return "shortcut";
  if (text(0x8001, "CD001") || text(0x8801, "CD001") || text(0x9001, "CD001") || text(0, "koly")) return "disk_image";
  return null;
}

const KIND_OF_EXTENSION: Record<string, ExecutableKind> = Object.fromEntries(
  (
    [
      ["windows", "exe com pif scr cpl msc gadget application xll"],
      ["installer", "msi msix msp appx appxbundle deb rpm snap flatpakref appimage pkg mpkg"],
      ["script", "bat cmd ps1 psm1 psd1 vbs vbe js jse mjs wsf wsh wsc sct hta reg inf scf sh bash zsh csh ksh fish command py pyw pl rb php workflow action"],
      ["shortcut", "lnk url website settingcontent-ms desktop"],
      ["java", "jar class"],
      ["mobile_app", "apk aab xapk ipa"],
      ["disk_image", "dmg iso img vhd vhdx"],
      ["macro_document", "docm xlsm pptm dotm xltm potm ppam xlam"],
      ["library", "dll sys drv ocx"],
      ["macos", "app"],
      ["program", "run bin elf"],
    ] as const
  ).flatMap(([kind, list]) => list.split(" ").map((ext) => [ext, kind])),
);

const KIND_OF_TYPE: [string, ExecutableKind][] = [
  ["application/x-msdownload", "windows"],
  ["application/x-msdos-program", "windows"],
  ["application/x-ms-installer", "installer"],
  ["application/x-executable", "program"],
  ["application/x-sh", "script"],
  ["application/x-bat", "script"],
  ["application/java-archive", "java"],
  ["application/vnd.android.package-archive", "mobile_app"],
  ["application/x-apple-diskimage", "disk_image"],
  ["application/x-iso9660-image", "disk_image"],
  ["application/javascript", "script"],
  ["text/javascript", "script"],
  ["application/hta", "script"],
  ["application/x-ms-shortcut", "shortcut"],
];

/**
 * Is a file an executable, a script or another type that runs code when opened, and which kind? The node's rules
 * (uploads.rs): content (magic bytes) first, then the extension, then the type. Archives (zip, 7z, rar, tar.*) are
 * not executables (owner decision); ZIP-based apps (jar, apk) and macro documents are, by their extension.
 */
export function executableKind(name: string, type: string, head?: Uint8Array): ExecutableKind | null {
  const sniffed = head ? sniffKind(head) : null;
  if (sniffed) return sniffed;
  const ext = extensionOf(name);
  const byExt = Object.prototype.hasOwnProperty.call(KIND_OF_EXTENSION, ext) ? KIND_OF_EXTENSION[ext]! : null;
  if (byExt) return byExt;
  const t = type.toLowerCase();
  return KIND_OF_TYPE.find(([prefix]) => t.startsWith(prefix))?.[1] ?? null;
}

export function isExecutable(name: string, type: string, head?: Uint8Array): boolean {
  return executableKind(name, type, head) !== null;
}

/** The first {@link HEAD_BYTES} of a file's content, for {@link executableKind}. */
export async function readHead(data: Blob | Uint8Array): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data.subarray(0, HEAD_BYTES);
  return new Uint8Array(await data.slice(0, HEAD_BYTES).arrayBuffer());
}

/** Category by name and type (and, if given, the first bytes). */
export function classifyName(name: string, type: string, head?: Uint8Array): Classified {
  if (isExecutable(name, type, head)) return { category: "other", executable: true };
  return { category: categoryOfExtension(extensionOf(name)) ?? categoryOfType(type) ?? "other", executable: false };
}

/** Classifies a file, reading its first bytes. */
export async function classifyFile(file: File): Promise<Classified> {
  let head: Uint8Array | undefined;
  try {
    head = await readHead(file);
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
