// SPDX-License-Identifier: Apache-2.0
// The page's query cache is emptied when the signed-in account ends (lib/queryClient.ts). A query whose fetch is in
// flight at that moment must still settle for the component that shows it: `clear()` alone cancels the fetch silently
// and leaves the mounted observer `pending` for good (the login page's node queries after a sign-out, web #167).
import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthResponse, UserPrivate } from "@tavrn/sdk";
import { queryClient } from "./queryClient";
import { useAuth } from "../stores/auth";

const user = { id: "u1", username: "alice", address: "alice@home.test", domain: "home.test" } as unknown as UserPrivate;
const session = { access_token: "a-1", refresh_token: "r-1", user, device_id: "dev1", reauth_token: null } as unknown as AuthResponse;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

describe("query cache at an account change", () => {
  beforeEach(() => {
    localStorage.clear();
    queryClient.clear();
    useAuth.getState().setSession(session);
  });

  it("a mounted query in flight when the account ends settles with its answer", async () => {
    let calls = 0;
    const answers: Array<(v: string) => void> = [];
    const { result } = renderHook(
      () =>
        useQuery({
          queryKey: ["node", "origin"],
          queryFn: () => {
            calls++;
            return new Promise<string>((r) => answers.push(r));
          },
          retry: false,
        }),
      { wrapper },
    );
    await waitFor(() => expect(calls).toBe(1));
    useAuth.getState().logout();
    for (const answer of answers) answer("node info");
    await waitFor(() => expect(result.current.data).toBe("node info"));
    expect(result.current.isPending).toBe(false);
  });

  it("the data of the previous account is gone", async () => {
    queryClient.setQueryData(["rooms"], [{ id: "r1" }]);
    useAuth.getState().logout();
    expect(queryClient.getQueryData(["rooms"])).toBeUndefined();
  });
});
