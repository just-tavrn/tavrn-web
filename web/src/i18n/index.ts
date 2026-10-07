// SPDX-License-Identifier: Apache-2.0
/**
 * Localization without a library: flat JSON files per language, `{name}` placeholders,
 * English as the fallback. New language: add a JSON file at `src/i18n/<code>.json` and register it in LOCALES.
 */
import { create } from "zustand";
import en from "./en.json";
import de from "./de.json";

export type Messages = Record<string, string>;

export const LOCALES: Record<string, { label: string; messages: Messages }> = {
  en: { label: "English", messages: en },
  de: { label: "Deutsch", messages: de },
};

export const DEFAULT_LOCALE = "en";
const KEY = "tavrn.locale";

export function detectLocale(): string {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored && LOCALES[stored]) return stored;
  } catch {
    /* no storage */
  }
  const candidates = typeof navigator !== "undefined" ? [...(navigator.languages ?? []), navigator.language] : [];
  for (const c of candidates) {
    const short = (c ?? "").toLowerCase().split("-")[0] ?? "";
    if (LOCALES[short]) return short;
  }
  return DEFAULT_LOCALE;
}

export function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (params[k] === undefined ? `{${k}}` : String(params[k])));
}

export function translate(locale: string, key: string, params?: Record<string, string | number>): string {
  const template = LOCALES[locale]?.messages[key] ?? LOCALES[DEFAULT_LOCALE]?.messages[key] ?? key;
  return format(template, params);
}

interface LocaleState {
  locale: string;
  setLocale: (locale: string) => void;
}

export const useLocale = create<LocaleState>((set) => ({
  locale: detectLocale(),
  setLocale: (locale) => {
    if (!LOCALES[locale]) return;
    try {
      localStorage.setItem(KEY, locale);
    } catch {
      /* ignorieren */
    }
    document.documentElement.lang = locale;
    set({ locale });
  },
}));

/** Translation function for components; re-renders when the language changes. */
export function useT() {
  const locale = useLocale((s) => s.locale);
  return (key: string, params?: Record<string, string | number>) => translate(locale, key, params);
}

/** Outside of components (stores, hooks without rendering). */
export function t(key: string, params?: Record<string, string | number>): string {
  return translate(useLocale.getState().locale, key, params);
}

/** API error code → localized message; otherwise the server's description. */
export function errorMessage(code: string | undefined, fallback: string | undefined): string {
  if (code) {
    const key = `errors.${code}`;
    const locale = useLocale.getState().locale;
    if (LOCALES[locale]?.messages[key] || LOCALES[DEFAULT_LOCALE]?.messages[key]) return translate(locale, key);
  }
  return fallback || t("common.error");
}

/** Date and number formats follow the selected language. */
export function intlLocale(): string {
  return useLocale.getState().locale === "de" ? "de-DE" : "en-US";
}
