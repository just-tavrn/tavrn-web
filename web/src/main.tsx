// SPDX-License-Identifier: Apache-2.0
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import "./styles.css";
import { useLocale } from "./i18n";
import { registerServiceWorker } from "./lib/push";

document.documentElement.lang = useLocale.getState().locale;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

const root = document.getElementById("root");
if (!root) throw new Error("#root fehlt in index.html");

// Web push only (no caching, no offline mode): the worker shows pushes of the home node while no tab is open.
void registerServiceWorker();

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
