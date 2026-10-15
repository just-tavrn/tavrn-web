// SPDX-License-Identifier: Apache-2.0
/**
 * Localization without a library: flat JSON files per language, `{name}` placeholders,
 * English as the fallback. New language: add a JSON file at `src/i18n/<code>.json` and register it in LOCALES.
 * English is part of the bundle (the fallback); every other language is its own chunk, loaded before the first
 * render (main.tsx, {@link loadLocale}) and when the user switches to it.
 */
import { create } from "zustand";
import en from "./en.json";

export type Messages = Record<string, string>;

export const LOCALES: Record<string, { label: string; load: () => Promise<Messages> }> = {
  en: { label: "English", load: async () => en },
  de: { label: "Deutsch", load: async () => (await import("./de.json")).default },
};

export const DEFAULT_LOCALE = "en";
const KEY = "tavrn.locale";

/** The messages of the languages loaded so far. */
const loaded: Record<string, Messages> = { en };
const loading = new Map<string, Promise<Messages>>();

/** The messages of `locale` if loaded (English always is). */
export function messagesOf(locale: string): Messages | undefined {
  return loaded[locale];
}

/** Loads the messages of `locale` once (its chunk); unknown languages resolve to English. */
export function loadLocale(locale: string): Promise<Messages> {
  const have = loaded[locale];
  if (have) return Promise.resolve(have);
  const entry = LOCALES[locale];
  if (!entry) return Promise.resolve(en);
  let pending = loading.get(locale);
  if (!pending) {
    pending = entry.load().then(
      (messages) => {
        loaded[locale] = messages;
        loading.delete(locale);
        return messages;
      },
      (e: unknown) => {
        loading.delete(locale);
        throw e;
      },
    );
    loading.set(locale, pending);
  }
  return pending;
}

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
  const template = loaded[locale]?.[key] ?? loaded[DEFAULT_LOCALE]?.[key] ?? key;
  return format(template, params);
}

interface LocaleState {
  locale: string;
  /** Switches the language once its messages are loaded (until then the current one stays). */
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
    const apply = () => {
      document.documentElement.lang = locale;
      set({ locale });
    };
    // A language loaded already switches right away; another one once its chunk is there.
    if (loaded[locale]) apply();
    else void loadLocale(locale).then(apply, () => undefined);
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
    if (loaded[locale]?.[key] || loaded[DEFAULT_LOCALE]?.[key]) return translate(locale, key);
  }
  return fallback || t("common.error");
}

/** Date and number formats follow the selected language. */
export function intlLocale(): string {
  return useLocale.getState().locale === "de" ? "de-DE" : "en-US";
}
