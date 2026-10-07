// SPDX-License-Identifier: Apache-2.0
import { t } from "../i18n";

/** Default channels and categories carry a system name; the client shows it localized until someone renames them. */
export function channelName(c: { name: string; system_name?: string | null }): string {
  if (c.system_name) {
    const key = `channel.default.${c.system_name}`;
    const translated = t(key);
    if (translated !== key) return translated;
  }
  return c.name;
}

export function categoryName(c: { name: string; system_name?: string | null }): string {
  if (c.system_name) {
    const key = `category.default.${c.system_name}`;
    const translated = t(key);
    if (translated !== key) return translated;
  }
  return c.name;
}
