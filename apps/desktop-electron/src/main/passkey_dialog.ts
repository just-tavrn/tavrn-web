// SPDX-License-Identifier: Apache-2.0
/**
 * The shell's passkey dialog (docs/DESKTOP.md "Passkeys on Linux"): what it shows during a ceremony with a security key
 * and what it accepts back. Like the screen-share picker, the page is static HTML without any script (`script-src
 * 'none'`); its preload (`src/preload/passkey.ts`) renders the {@link DialogContent} the main process composes here and
 * answers the PIN, the chosen passkey or a cancel. The web page of the main window never sees any of it: the PIN goes
 * from this dialog to the key's PIN protocol.
 */

/** What the dialog shows: the main process turns the module's events into these (`passkeys.ts`). */
export type DialogView =
  /** The ceremony started: plug in the key (if it is not yet) and touch it. */
  | { view: "waiting" }
  /** The request reached a key: touch it. */
  | { view: "touch" }
  /** Several keys: touch the one to use. */
  | { view: "select_key" }
  /** The key's PIN; `invalid` after a wrong one (with the tries left when the key says), `length` for a PIN it would refuse. */
  | { view: "pin"; invalid: boolean; retries: number | null; length: boolean }
  /** Several passkeys of this site on the key. */
  | { view: "accounts"; names: string[] }
  /** The key's own user verification (a fingerprint on the key) did not match. */
  | { view: "uv_invalid"; retries: number | null }
  /** The key refuses for good (`usb.rs`' problems): the dialog says why and stays until closed. */
  | { view: "problem"; problem: string };

/** The user's answers. */
export type DialogAnswer = { type: "pin"; pin: string } | { type: "account"; index: number } | { type: "cancel" };

/** What the preload renders: texts only, composed in the main process. */
export interface DialogContent {
  title: string;
  message: string;
  /** An error the user should notice (a wrong PIN, a refusal): announced (`role="alert"`). */
  alert: string | null;
  /** The PIN field. */
  pin: { label: string; submit: string } | null;
  /** The passkeys to choose from (button labels). */
  accounts: string[];
  /** The button that cancels (or closes after a problem). */
  cancel: string;
  /** Whether the dialog is over (a problem): the button closes, nothing waits for the key. */
  final: boolean;
}

export interface DialogLabels {
  title_create: string;
  title_get: string;
  waiting: string;
  touch: string;
  select_key: string;
  pin: string;
  pin_label: string;
  pin_submit: string;
  pin_wrong: string;
  pin_wrong_retries: string;
  pin_length: string;
  accounts: string;
  account: string;
  uv_invalid: string;
  problems: Record<string, string>;
  problem_other: string;
  cancel: string;
  close: string;
}

const EN: DialogLabels = {
  title_create: "Create a passkey for {rp}",
  title_get: "Use your passkey for {rp}",
  waiting: "Plug in your security key and touch it when it blinks.",
  touch: "Touch your security key.",
  select_key: "Several security keys are plugged in: touch the one you want to use.",
  pin: "Enter the PIN of your security key.",
  pin_label: "PIN of the security key",
  pin_submit: "Continue",
  pin_wrong: "Wrong PIN. Try again.",
  pin_wrong_retries: "Wrong PIN. {n} tries left before the key locks.",
  pin_length: "The PIN of a security key has at least 4 characters.",
  accounts: "The security key holds several passkeys for {rp}. Choose one.",
  account: "Use the passkey of {name}",
  uv_invalid: "The security key did not recognize you. Try again.",
  problems: {
    pin_blocked: "The PIN of this security key is blocked. Reset the key with its maker's tool; its passkeys are lost then.",
    pin_auth_blocked: "Too many wrong PINs. Unplug the security key, plug it in again and retry.",
    pin_not_set: "This security key has no PIN, but the node asks for one. Set a PIN with the key's tool and try again.",
    uv_blocked: "The security key blocked its fingerprint check. Use the key's PIN instead.",
    pin_length: "The security key refused the PIN's length.",
  },
  problem_other: "The security key refused the request.",
  cancel: "Cancel",
  close: "Close",
};

const DE: DialogLabels = {
  title_create: "Passkey für {rp} erstellen",
  title_get: "Deinen Passkey für {rp} verwenden",
  waiting: "Stecke deinen Sicherheitsschlüssel ein und berühre ihn, wenn er blinkt.",
  touch: "Berühre deinen Sicherheitsschlüssel.",
  select_key: "Mehrere Sicherheitsschlüssel sind eingesteckt: Berühre den, den du verwenden möchtest.",
  pin: "Gib die PIN deines Sicherheitsschlüssels ein.",
  pin_label: "PIN des Sicherheitsschlüssels",
  pin_submit: "Weiter",
  pin_wrong: "Falsche PIN. Versuche es noch einmal.",
  pin_wrong_retries: "Falsche PIN. Noch {n} Versuche, dann sperrt der Schlüssel.",
  pin_length: "Die PIN eines Sicherheitsschlüssels hat mindestens 4 Zeichen.",
  accounts: "Der Sicherheitsschlüssel enthält mehrere Passkeys für {rp}. Wähle einen aus.",
  account: "Passkey von {name} verwenden",
  uv_invalid: "Der Sicherheitsschlüssel hat dich nicht erkannt. Versuche es noch einmal.",
  problems: {
    pin_blocked: "Die PIN dieses Sicherheitsschlüssels ist gesperrt. Setze den Schlüssel mit dem Werkzeug seines Herstellers zurück; seine Passkeys gehen dabei verloren.",
    pin_auth_blocked: "Zu viele falsche PINs. Ziehe den Sicherheitsschlüssel ab, stecke ihn wieder ein und versuche es erneut.",
    pin_not_set: "Dieser Sicherheitsschlüssel hat keine PIN, der Knoten verlangt aber eine. Lege mit dem Werkzeug des Schlüssels eine PIN fest und versuche es erneut.",
    uv_blocked: "Der Sicherheitsschlüssel hat seine Fingerabdruckprüfung gesperrt. Verwende stattdessen die PIN des Schlüssels.",
    pin_length: "Der Sicherheitsschlüssel hat die Länge der PIN abgelehnt.",
  },
  problem_other: "Der Sicherheitsschlüssel hat die Anfrage abgelehnt.",
  cancel: "Abbrechen",
  close: "Schließen",
};

const isGerman = (locale: string) => /^de\b/i.test(locale);

/** The dialog's texts in the app's language (English, or German for a German locale). */
export function dialogLabels(locale: string): DialogLabels {
  return isGerman(locale) ? DE : EN;
}

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);

/** The dialog's content for a view of a ceremony with the relying party `rp`. */
export function dialogContent(view: DialogView, labels: DialogLabels, ceremony: "create" | "get", rp: string): DialogContent {
  const title = fill(ceremony === "create" ? labels.title_create : labels.title_get, { rp });
  const base: DialogContent = { title, message: "", alert: null, pin: null, accounts: [], cancel: labels.cancel, final: false };
  switch (view.view) {
    case "waiting":
      return { ...base, message: labels.waiting };
    case "touch":
      return { ...base, message: labels.touch };
    case "select_key":
      return { ...base, message: labels.select_key };
    case "pin": {
      const alert = view.length
        ? labels.pin_length
        : view.invalid
          ? view.retries !== null
            ? fill(labels.pin_wrong_retries, { n: String(view.retries) })
            : labels.pin_wrong
          : null;
      return { ...base, message: labels.pin, alert, pin: { label: labels.pin_label, submit: labels.pin_submit } };
    }
    case "accounts":
      return { ...base, message: fill(labels.accounts, { rp }), accounts: view.names.map((name) => fill(labels.account, { name: name || "?" })) };
    case "uv_invalid":
      return { ...base, message: labels.touch, alert: labels.uv_invalid };
    case "problem":
      return { ...base, message: "", alert: labels.problems[view.problem] ?? labels.problem_other, cancel: labels.close, final: true };
  }
}

export const DIALOG_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'";

/** The dialog's page (a `data:` URL; the preload fills it): the picker's theme, contrast, focus ring and target sizes. */
export function dialogHtml(locale: string): string {
  return `<!doctype html>
<html lang="${isGerman(locale) ? "de" : "en"}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${DIALOG_CSP}">
<title>tavrn</title>
<style>
:root { color-scheme: dark light; --bg: #15181e; --card: #1f242c; --fg: #f1f3f5; --fg2: #b8bec8; --line: #3a414c; --field: #8b93a1; --accent: #2fd6b8; --accent-fg: #0b0e12; --danger: #ff8a80; }
@media (prefers-color-scheme: light) { :root { --bg: #f6f7f9; --card: #ffffff; --fg: #15181e; --fg2: #4a515c; --line: #c9ced6; --field: #6b7280; --accent: #0b7a68; --accent-fg: #ffffff; --danger: #b3261e; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.4 system-ui, sans-serif; }
h1 { font-size: 16px; margin: 0 0 12px; overflow-wrap: anywhere; }
p { margin: 0 0 12px; color: var(--fg); }
.alert { color: var(--danger); font-weight: 600; }
label { display: block; margin-bottom: 4px; color: var(--fg2); }
input { width: 100%; min-height: 44px; padding: 0 12px; font: inherit; color: var(--fg); background: var(--card); border: 1px solid var(--field); border-radius: 8px; }
ul { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 8px; }
button { font: inherit; color: inherit; cursor: pointer; min-height: 44px; min-width: 96px; padding: 0 16px; border-radius: 8px; border: 1px solid var(--field); background: transparent; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; }
.account { width: 100%; text-align: left; background: var(--card); }
button:focus-visible, input:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.actions { margin-top: 16px; display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body><main id="passkey"></main></body>
</html>`;
}

/** The page as a URL for `loadURL`. */
export function dialogUrl(locale: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(dialogHtml(locale))}`;
}

/** An answer of the dialog's preload, checked: anything else counts as cancel. */
export function dialogAnswer(raw: unknown, accounts: number): DialogAnswer {
  const a = raw as { type?: unknown; pin?: unknown; index?: unknown } | null;
  if (a?.type === "pin" && typeof a.pin === "string" && a.pin.length <= 256) return { type: "pin", pin: a.pin };
  if (a?.type === "account" && Number.isInteger(a.index) && (a.index as number) >= 0 && (a.index as number) < accounts) return { type: "account", index: a.index as number };
  return { type: "cancel" };
}
