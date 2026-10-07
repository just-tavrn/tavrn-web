// SPDX-License-Identifier: Apache-2.0
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

/** Renders with a fresh QueryClient without retries and a router, so error cases show up immediately. */
export function renderWithProviders(ui: ReactElement, { route = "/" }: { route?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** fetch mock that answers per URL pattern. */
export function mockFetch(routes: Record<string, { status?: number; body: unknown } | ((init: RequestInit) => { status?: number; body: unknown })>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key ? routes[key]! : { status: 404, body: { code: "route.not_found", status: 404, title: "Not found", detail: "", type: "x" } };
    const resolved = typeof r === "function" ? r(init) : r;
    return new Response(JSON.stringify(resolved.body), { status: resolved.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  globalThis.fetch = impl as unknown as typeof fetch;
  return calls;
}
