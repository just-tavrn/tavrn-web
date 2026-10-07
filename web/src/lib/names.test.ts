// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { useLocale } from "../i18n";
import { categoryName, channelName } from "./names";

describe("localized default names", () => {
  it("translates system names per language and leaves renamed channels alone", () => {
    useLocale.setState({ locale: "de" });
    expect(channelName({ name: "general", system_name: "general" })).toBe("allgemein");
    expect(channelName({ name: "Voice", system_name: "voice" })).toBe("Sprache");
    expect(channelName({ name: "welcome", system_name: "welcome" })).toBe("willkommen");
    expect(categoryName({ name: "General", system_name: "general" })).toBe("Allgemein");
    useLocale.setState({ locale: "en" });
    expect(channelName({ name: "general", system_name: "general" })).toBe("general");
    expect(channelName({ name: "lobby", system_name: null })).toBe("lobby");
    expect(channelName({ name: "x", system_name: "unbekannt" })).toBe("x");
    useLocale.setState({ locale: "de" });
  });
});
