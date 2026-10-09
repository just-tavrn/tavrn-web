// SPDX-License-Identifier: Apache-2.0
import { LOCALES, useLocale } from "../i18n";

export function LocaleSwitch({ className = "" }: { className?: string }) {
  const locale = useLocale((s) => s.locale);
  const setLocale = useLocale((s) => s.setLocale);
  return (
    <select aria-label="Language" value={locale} onChange={(e) => setLocale(e.target.value)} className={`min-h-9 rounded-md border border-line-strong bg-bg-0 px-2 text-xs text-fg-1 ${className}`} data-testid="locale-switch">
      {Object.entries(LOCALES).map(([code, { label }]) => (
        <option key={code} value={code}>
          {label}
        </option>
      ))}
    </select>
  );
}
