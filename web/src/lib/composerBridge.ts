// SPDX-License-Identifier: Apache-2.0
/**
 * Inserting text into the open composer from elsewhere (the "Mention" menu item, design note 4.11). The
 * composer is a controlled React textarea, so the value is set through the native setter and an `input`
 * event lets React pick it up, exactly as typing would.
 */
import { t } from "../i18n";

export function composerTextarea(): HTMLTextAreaElement | null {
  const label = t("composer.message");
  return Array.from(document.querySelectorAll<HTMLTextAreaElement>("textarea")).find((el) => el.getAttribute("aria-label") === label && !el.disabled) ?? null;
}

/** Appends `text` (with a separating space) and focuses the composer; false when there is none. */
export function insertIntoComposer(text: string): boolean {
  const el = composerTextarea();
  if (!el) return false;
  const current = el.value;
  const next = current && !/\s$/.test(current) ? `${current} ${text}` : `${current}${text}`;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  el.setSelectionRange(next.length, next.length);
  return true;
}

/** How a user is mentioned: `@name` for users of the room's node, `@name@domain` otherwise. */
export function mentionToken(address: string, localDomain: string): string {
  const [name, domain] = address.split("@");
  return domain && domain !== localDomain ? `@${address} ` : `@${name} `;
}
