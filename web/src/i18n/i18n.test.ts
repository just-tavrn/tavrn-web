// SPDX-License-Identifier: Apache-2.0
import type { DecryptFailure, E2eeErrorCode } from "@tavrn/e2ee";
import { PERMISSION_LABELS } from "@tavrn/sdk";
import { act, renderHook } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, LOCALES, errorMessage, format, loadLocale, messagesOf, translate, useLocale, useT, type Messages } from "./index";

/** Every language with its messages (each one its own chunk, loaded here). */
let all: Array<[string, { messages: Messages }]> = [];
beforeAll(async () => {
  for (const code of Object.keys(LOCALES)) await loadLocale(code);
  all = Object.keys(LOCALES).map((code) => [code, { messages: messagesOf(code)! }]);
});

describe("i18n", () => {
  it("all languages have the same keys as English", () => {
    const base = Object.keys(messagesOf(DEFAULT_LOCALE)!).sort();
    for (const [code, { messages }] of all) {
      const keys = Object.keys(messages).sort();
      const missing = base.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !base.includes(k));
      expect({ code, missing, extra }).toEqual({ code, missing: [], extra: [] });
    }
  });

  it("every permission the editors list is translated in every language (perm.<NAME>)", () => {
    for (const [code, { messages }] of all) {
      const missing = PERMISSION_LABELS.map((p) => `perm.${p.name}`).filter((k) => !(k in messages));
      expect({ code, missing }).toEqual({ code, missing: [] });
    }
  });

  it("every decrypt failure and every encryption error code of @tavrn/e2ee is translated in every language", () => {
    // `satisfies Record<…>`: a new reason or code in @tavrn/e2ee fails the typecheck until it is listed here.
    const reasons = Object.keys({ missing_key: 1, bad_signature: 1, unknown_device: 1, replay: 1, invalid: 1, locked: 1, envelope_mismatch: 1, retry: 1 } satisfies Record<DecryptFailure, 1>);
    const codes = Object.keys({
      recovery_key_invalid: 1,
      recovery_key_wrong: 1,
      passkey_wrong: 1,
      no_recovery_entry: 1,
      no_passkey_entry: 1,
      identity_mismatch: 1,
      rotation_devices: 1,
      locked: 1,
      already_set_up: 1,
      device_key_lost: 1,
      state_unreadable: 1,
    } satisfies Record<E2eeErrorCode, 1>);
    const wanted = [...reasons.flatMap((r) => [`messages.undecryptable.${r}`, `messages.undecryptable_short.${r}`]), ...codes.map((c) => `e2ee.error.${c}`)];
    for (const [code, { messages }] of all) {
      const missing = wanted.filter((k) => !(k in messages));
      expect({ code, missing }).toEqual({ code, missing: [] });
    }
  });

  it("useT returns the same function until the language changes (usable as a memo or effect dependency)", () => {
    const before = useLocale.getState().locale;
    act(() => useLocale.getState().setLocale("en"));
    const { result, rerender } = renderHook(() => useT());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(first("auth.login")).toBe("Sign in");
    act(() => useLocale.getState().setLocale("de"));
    expect(result.current).not.toBe(first);
    expect(result.current("auth.login")).toBe("Anmelden");
    const german = result.current;
    rerender();
    expect(result.current).toBe(german);
    act(() => useLocale.getState().setLocale(before));
  });

  it("replaces placeholders and falls back to English", () => {
    expect(format("Hallo {name}, {n} neu", { name: "Alice", n: 3 })).toBe("Hallo Alice, 3 neu");
    expect(translate("de", "auth.login")).toBe("Anmelden");
    expect(translate("en", "auth.login")).toBe("Sign in");
    expect(translate("xx", "auth.login")).toBe("Sign in");
    expect(translate("de", "gibt.es.nicht")).toBe("gibt.es.nicht");
  });

  it("translates known error codes, otherwise the server text", () => {
    useLocale.setState({ locale: "de" });
    expect(errorMessage("auth.invalid_credentials", "Wrong")).toBe("Benutzername oder Passwort falsch");
    expect(errorMessage("unbekannt.code", "Server sagt nein")).toBe("Server sagt nein");
    expect(errorMessage(undefined, "")).toBe("Etwas ist schiefgelaufen");
    useLocale.setState({ locale: "en" });
  });

  it("user-visible strings carry no roadmap talk (phases, coming soon)", () => {
    const roadmap = /\b(phase \d|coming (soon|in)|roadmap|todo)\b|\b(kommt|kommen) (bald|in phase)|demnächst/i;
    for (const [code, { messages }] of all) {
      const hits = Object.entries(messages).filter(([, v]) => roadmap.test(v)).map(([k]) => k);
      expect({ code, hits }).toEqual({ code, hits: [] });
    }
  });

  it("writes the product name in lowercase, tavrn (HTTP header names like Tavrn-Signature excepted)", () => {
    const capital = /\bTavrn\b(?!-Signature)/;
    for (const [code, { messages }] of all) {
      const hits = Object.entries(messages).filter(([, v]) => capital.test(v)).map(([k]) => k);
      expect({ code, hits }).toEqual({ code, hits: [] });
    }
  });

  it("names no particular authenticator app (generic wording)", () => {
    const apps = /aegis|2fas|google authenticator|authy|microsoft authenticator|freeotp/i;
    for (const [code, { messages }] of all) {
      const hits = Object.entries(messages).filter(([, v]) => apps.test(v)).map(([k]) => k);
      expect({ code, hits }).toEqual({ code, hits: [] });
    }
  });
});

describe("language loading", () => {
  it("English is there from the start, another language once loaded; switching waits for its messages", async () => {
    expect(messagesOf("en")?.["auth.login"]).toBe("Sign in");
    await loadLocale("de");
    useLocale.getState().setLocale("en");
    expect(useLocale.getState().locale).toBe("en");
    useLocale.getState().setLocale("de");
    // Loaded already: the switch is immediate.
    expect(useLocale.getState().locale).toBe("de");
    expect(translate("de", "auth.login")).toBe("Anmelden");
    useLocale.getState().setLocale("xx");
    expect(useLocale.getState().locale).toBe("de");
  });
  it("names the node's device and key rotation limits in every language (ENCRYPTION.md §3)", () => {
    for (const code of ["auth.device_limit", "e2ee.rotation_limit"]) {
      for (const [lang, { messages }] of all) expect({ lang, code, has: !!messages[`errors.${code}`] }).toEqual({ lang, code, has: true });
      expect(errorMessage(code, "fallback")).not.toBe("fallback");
    }
  });
});
