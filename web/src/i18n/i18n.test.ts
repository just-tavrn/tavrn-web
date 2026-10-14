// SPDX-License-Identifier: Apache-2.0
import { PERMISSION_LABELS } from "@tavrn/sdk";
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

  it("every permission the editors list is translated in every language (perm.<NAME>)", () => {
    for (const [code, { messages }] of Object.entries(LOCALES)) {
      const missing = PERMISSION_LABELS.map((p) => `perm.${p.name}`).filter((k) => !(k in messages));
      expect({ code, missing }).toEqual({ code, missing: [] });
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

  it("writes the product name in lowercase, tavrn (HTTP header names like Tavrn-Signature excepted)", () => {
    const capital = /\bTavrn\b(?!-Signature)/;
    for (const [code, { messages }] of Object.entries(LOCALES)) {
      const hits = Object.entries(messages).filter(([, v]) => capital.test(v)).map(([k]) => k);
      expect({ code, hits }).toEqual({ code, hits: [] });
    }
  });

  it("names no particular authenticator app (generic wording)", () => {
    const apps = /aegis|2fas|google authenticator|authy|microsoft authenticator|freeotp/i;
    for (const [code, { messages }] of Object.entries(LOCALES)) {
      const hits = Object.entries(messages).filter(([, v]) => apps.test(v)).map(([k]) => k);
      expect({ code, hits }).toEqual({ code, hits: [] });
    }
  });
});
