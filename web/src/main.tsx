// SPDX-License-Identifier: Apache-2.0
/// <reference types="vite/client" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import "./styles.css";
import { loadLocale, useLocale } from "./i18n";
import { registerServiceWorker } from "./lib/push";
import { initPlatform } from "./platform";
import { startHotkeys } from "./voice/hotkeys";
import { startWakeLock } from "./voice/wakeLock";
import { queryClient } from "./lib/queryClient";
import { polyfillFlagEmojis } from "./lib/flagEmoji";
// The flag-only emoji font for platforms without flag glyphs (tavrn-web#118), bundled: no CDN (CSP font-src 'self').
import flagFontUrl from "country-flag-emoji-polyfill/dist/TwemojiCountryFlags.woff2?url";

document.documentElement.lang = useLocale.getState().locale;
// Windows renders country flags as letter pairs: register the bundled flag font where the platform needs it.
polyfillFlagEmojis(flagFontUrl);

const root = document.getElementById("root");
if (!root) throw new Error("#root fehlt in index.html");

// The platform first (browser, or the desktop app with the node the user picked): every API call depends on it.
// The chosen language's messages load at the same time (English is in the bundle, the others are chunks of their own).
void Promise.all([initPlatform().catch((e: unknown) => console.error("platform detection failed", e)), loadLocale(useLocale.getState().locale).catch(() => undefined)])
  .then(() => {
    // Web push only (no caching, no offline mode): the worker shows pushes of the home node while no tab is open.
    void registerServiceWorker();
    // Hotkeys: the window's keys, and in the desktop app the shell's system-wide key listener, wired to the voice session.
    startHotkeys();
    // The screen stays on while in a voice channel or call (the voice setting `keepScreenOn`).
    startWakeLock();
    createRoot(root).render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </StrictMode>,
    );
  });
