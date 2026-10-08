// SPDX-License-Identifier: Apache-2.0
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import "./styles.css";
import { useLocale } from "./i18n";
import { registerServiceWorker } from "./lib/push";
import { initPlatform } from "./platform";
import { startDesktopHotkeys } from "./voice/hotkeys";

document.documentElement.lang = useLocale.getState().locale;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

const root = document.getElementById("root");
if (!root) throw new Error("#root fehlt in index.html");

// The platform first (browser, or the desktop app with the node the user picked): every API call depends on it.
void initPlatform()
  .catch((e: unknown) => console.error("platform detection failed", e))
  .then(() => {
    // Web push only (no caching, no offline mode): the worker shows pushes of the home node while no tab is open.
    void registerServiceWorker();
    // Desktop app: global hotkeys restored and wired to the voice session (no-op in the browser).
    startDesktopHotkeys();
    createRoot(root).render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </StrictMode>,
    );
  });
