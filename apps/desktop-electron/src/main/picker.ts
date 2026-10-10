// SPDX-License-Identifier: Apache-2.0
/**
 * The shell's own picker for screen sharing (`getDisplayMedia`, docs/DESKTOP.md "The Linux shell (Electron)"): what it
 * shows and what it accepts back. The page is static HTML without any script (`script-src 'none'`); its preload
 * (`src/preload/picker.ts`) builds the list from {@link PickerData} in its own isolated world and answers the chosen
 * source's id, or null (Escape, Cancel, the window closed). `capture.ts` opens the window and hands the choice to
 * Chromium. Linux offers no system audio for a shared screen in Electron (its `loopback` capture is Windows-only), so
 * the picker has no audio switch.
 */

export interface PickerSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  /** A PNG data URL. */
  thumbnail: string;
}

export interface PickerLabels {
  title: string;
  screens: string;
  windows: string;
  cancel: string;
  /** "Share <name>" for a source's button. */
  share: string;
  /** Shown when there is nothing to share. */
  empty: string;
}

export interface PickerData {
  labels: PickerLabels;
  sources: PickerSource[];
}

const EN: PickerLabels = { title: "Share your screen", screens: "Screens", windows: "Windows", cancel: "Cancel", share: "Share {name}", empty: "There is no screen or window to share." };
const DE: PickerLabels = { title: "Bildschirm teilen", screens: "Bildschirme", windows: "Fenster", cancel: "Abbrechen", share: "{name} teilen", empty: "Es gibt keinen Bildschirm und kein Fenster zum Teilen." };

/** The picker's texts in the app's language (English, or German for a German locale). */
export function pickerLabels(locale: string): PickerLabels {
  return /^de\b/i.test(locale) ? DE : EN;
}

/** Desktop sources (`desktopCapturer`) as the picker shows them; ids are `screen:…` or `window:…`. */
export function pickerSources(sources: ReadonlyArray<{ id: string; name: string; thumbnail: string }>): PickerSource[] {
  return sources
    .filter((s) => /^(screen|window):[\w:.-]{1,100}$/.test(s.id))
    .map((s) => ({ id: s.id, name: s.name.slice(0, 200) || s.id, kind: s.id.startsWith("screen:") ? ("screen" as const) : ("window" as const), thumbnail: s.thumbnail.startsWith("data:image/png;base64,") ? s.thumbnail : "" }));
}

/** The answer of the picker: one of the offered ids, or null. Anything else counts as cancelled. */
export function pickerChoice(answer: unknown, offered: readonly PickerSource[]): string | null {
  return typeof answer === "string" && offered.some((s) => s.id === answer) ? answer : null;
}

export const PICKER_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'";

/** The picker's page (a `data:` URL; the preload fills it). Dark and light themes, contrast and focus as in the client. */
export function pickerHtml(lang: string): string {
  return `<!doctype html>
<html lang="${/^de\b/i.test(lang) ? "de" : "en"}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PICKER_CSP}">
<title>tavrn</title>
<style>
:root { color-scheme: dark light; --bg: #15181e; --card: #1f242c; --fg: #f1f3f5; --fg2: #b8bec8; --line: #3a414c; --accent: #2fd6b8; }
@media (prefers-color-scheme: light) { :root { --bg: #f6f7f9; --card: #ffffff; --fg: #15181e; --fg2: #4a515c; --line: #c9ced6; --accent: #0b7a68; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.4 system-ui, sans-serif; }
h1 { font-size: 16px; margin: 0 0 12px; }
p { color: var(--fg2); }
h2 { font-size: 13px; margin: 16px 0 8px; color: var(--fg2); font-weight: 600; }
ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
button { font: inherit; color: inherit; cursor: pointer; }
.source { width: 100%; min-height: 44px; padding: 8px; display: flex; flex-direction: column; gap: 6px; align-items: stretch; text-align: left; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
.source img { width: 100%; aspect-ratio: 16 / 9; object-fit: contain; background: #000; border-radius: 4px; }
.source span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source:hover { border-color: var(--accent); }
button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.actions { margin-top: 16px; display: flex; justify-content: flex-end; }
.cancel { min-height: 44px; min-width: 96px; padding: 0 16px; background: transparent; border: 1px solid var(--line); border-radius: 8px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body><main id="picker"></main></body>
</html>`;
}

/** The page as a URL for `loadURL`. */
export function pickerUrl(lang: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(pickerHtml(lang))}`;
}
