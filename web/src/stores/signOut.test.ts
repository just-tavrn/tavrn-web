// SPDX-License-Identifier: Apache-2.0
// The logout revokes the session at once, so the socket (closed for authentication) and requests in flight can see
// the refusal before the logout's own answer arrives. An explicit sign-out must still finish in order: the provider's
// logout URL is kept and the local keys are deleted before the account counts as signed out (the login page shows).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthResponse, UserPrivate } from "@tavrn/sdk";

const wiped: string[] = [];
vi.mock("../crypto/e2ee", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../crypto/e2ee")>()),
  wipeLocal: vi.fn(async (address: string) => {
    await new Promise((r) => setTimeout(r, 5));
    wiped.push(address);
  }),
}));
vi.mock("../search/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../search/local")>()),
  wipeLocalIndex: vi.fn(async () => {}),
}));

import { refreshHome } from "../lib/api";
import { forgetSsoLogout, peekSsoLogout } from "../lib/sso";
import { beginSignOut, onAccountChange, useAuth } from "./auth";
import { signOut } from "./e2ee";

const user = { id: "u1", username: "sso", address: "sso@home.test", domain: "home.test" } as unknown as UserPrivate;
const session = { access_token: "a-1", refresh_token: "r-1", user, device_id: "dev1", reauth_token: null } as unknown as AuthResponse;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const refused = { type: "x", title: "Unauthorized", status: 401, code: "auth.refresh_invalid", detail: "" };
const END_SESSION = "https://idp.test/logout?client_id=tavrn";

describe("explicit sign-out", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    forgetSsoLogout();
    wiped.length = 0;
    useAuth.getState().setSession(session);
  });

  it("stays signed in until the provider's logout URL is kept and the local keys are gone, even when the node refuses the session first", async () => {
    // The logout's answer comes late; meanwhile the refused session triggers a refresh, which the node refuses too.
    globalThis.fetch = (async (url: string) => {
      if (url.includes("/auth/logout")) {
        await refreshHome();
        return json(200, { end_session_url: END_SESSION });
      }
      if (url.includes("/auth/refresh")) return json(401, refused);
      return json(404, { type: "x", title: "Not found", status: 404, code: "route.not_found", detail: "" });
    }) as unknown as typeof fetch;
    const seen: Array<{ wiped: number; logoutUrl: string | null }> = [];
    const off = useAuth.subscribe((s, prev) => {
      if (prev.user && !s.user) seen.push({ wiped: wiped.length, logoutUrl: peekSsoLogout() });
    });
    await signOut();
    off();
    expect(useAuth.getState().user).toBeNull();
    expect(seen).toEqual([{ wiped: 1, logoutUrl: END_SESSION }]);
  });

  it("a refused session outside a sign-out still signs out", async () => {
    globalThis.fetch = (async () => json(401, refused)) as unknown as typeof fetch;
    const end = beginSignOut();
    expect(await refreshHome()).toBeNull();
    expect(useAuth.getState().user).not.toBeNull();
    end();
    end();
    useAuth.getState().sessionRefused();
    expect(useAuth.getState().user).toBeNull();
  });

  it("a refusal that arrives after the sign-out finished does not end the account a second time", async () => {
    // A request of the signed-in page got 401 after the logout revoked the session; its refresh is answered only once
    // the sign-out is done and the login page shows. Ending the account again would empty the query cache under the
    // login page's queries in flight (web #167).
    let answerRefresh!: () => void;
    const refreshAnswered = new Promise<void>((r) => (answerRefresh = r));
    globalThis.fetch = (async (url: string) => {
      if (url.includes("/auth/logout")) return json(200, {});
      if (url.includes("/auth/refresh")) {
        await refreshAnswered;
        return json(401, refused);
      }
      return json(404, { type: "x", title: "Not found", status: 404, code: "route.not_found", detail: "" });
    }) as unknown as typeof fetch;
    const late = refreshHome();
    const ended: Array<string | null> = [];
    const off = onAccountChange((previous) => ended.push(previous));
    await signOut();
    expect(ended).toEqual(["sso@home.test"]);
    answerRefresh();
    expect(await late).toBeNull();
    off();
    expect(ended).toEqual(["sso@home.test"]);
    expect(useAuth.getState().user).toBeNull();
  });
});
