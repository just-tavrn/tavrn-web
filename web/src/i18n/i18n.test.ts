// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, LOCALES, errorMessage, format, translate, useLocale } from "./index";

describe("i18n", () => {
  it("all languages have the same keys as English", () => {
    const base = Object.keys(LOCALES[DEFAULT_LOCALE]!.messages).sort();
    for (const [code, { messages }] of Object.entries(LOCALES)) {
      const keys = Object.keys(messages).sort();
      const missing = base.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !base.includes(k));
      expect({ code, missing, extra }).toEqual({ code, missing: [], extra: [] });
    }
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
    for (const [code, { messages }] of Object.entries(LOCALES)) {
      const hits = Object.entries(messages).filter(([, v]) => roadmap.test(v)).map(([k]) => k);
      expect({ code, hits }).toEqual({ code, hits: [] });
    }
  });
});
