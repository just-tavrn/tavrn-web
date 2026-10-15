// SPDX-License-Identifier: Apache-2.0
import "@testing-library/jest-dom/vitest";

// jsdom has no matchMedia; default: narrow viewport (phone tier). Tests can override it.
// Deliberately via defineProperty instead of vi.stubGlobal, so vi.unstubAllGlobals() does not remove it again.
// Crypto tests run in the node environment (`// @vitest-environment node`) without a window.
if (typeof window !== "undefined") Object.defineProperty(window, "matchMedia", {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});

if (typeof Element !== "undefined" && !("scrollIntoView" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "scrollIntoView", { value: () => {}, writable: true, configurable: true });
}

// Tests run in German; the i18n tests themselves check both languages.
import { loadLocale, useLocale } from "../i18n";
await loadLocale("de");
useLocale.setState({ locale: "de" });
