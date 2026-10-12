// SPDX-License-Identifier: Apache-2.0
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { Route, Routes } from "react-router";
import { VerifyEmailPage } from "./VerifyEmailPage";
import { useAuth } from "../stores/auth";
import { mockFetch, renderWithProviders } from "../test/render";

const user = { id: "u1", username: "alice", domain: "t.local", address: "alice@t.local", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: "alice@example.org", email_verified: false, has_identity_key: true };

function renderPage(route: string) {
  return renderWithProviders(
    <StrictMode>
      <Routes>
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/login" element={<p>Anmeldeseite</p>} />
        <Route path="/" element={<p>Startseite</p>} />
      </Routes>
    </StrictMode>,
    { route },
  );
}

const invalid = { status: 400, body: { type: "x", title: "Bad Request", status: 400, code: "auth.verification_invalid", detail: "Verification link invalid or expired" } };

beforeEach(() => {
  useAuth.getState().logout();
});

describe("VerifyEmailPage", () => {
  it("confirms the address once (also under StrictMode) and leads to the sign-in", async () => {
    const calls = mockFetch({ "/api/v1/auth/verify-email": { body: {} } });
    renderPage("/verify-email?token=tok-1");
    expect(await screen.findByRole("heading", { name: "Deine E-Mail-Adresse ist bestätigt" })).toBeInTheDocument();
    const verify = calls.filter((c) => c.url.endsWith("/api/v1/auth/verify-email"));
    expect(verify).toHaveLength(1);
    expect(JSON.parse(verify[0]!.init.body as string)).toEqual({ token: "tok-1" });
    expect(screen.queryByRole("button", { name: "Weiter" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("link", { name: "Anmelden" }));
    expect(await screen.findByText("Anmeldeseite")).toBeInTheDocument();
  });

  it("with a session: Continue leads into the app", async () => {
    mockFetch({ "/api/v1/auth/verify-email": { body: {} } });
    useAuth.setState({ token: "acc", user });
    renderPage("/verify-email?token=tok-2");
    await screen.findByRole("heading", { name: "Deine E-Mail-Adresse ist bestätigt" });
    await userEvent.setup().click(screen.getByRole("link", { name: "Weiter" }));
    expect(await screen.findByText("Startseite")).toBeInTheDocument();
  });

  it("an invalid or expired link says so and points to the sign-in for a new one", async () => {
    mockFetch({ "/api/v1/auth/verify-email": invalid });
    renderPage("/verify-email?token=old");
    expect(await screen.findByRole("heading", { name: "Link ungültig" })).toBeInTheDocument();
    expect(screen.getByText("Der Link ist ungültig oder abgelaufen. Melde dich an, um einen neuen anzufordern.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Anmelden" })).toHaveAttribute("href", "/login");
    expect(screen.queryByRole("button", { name: "Erneut versuchen" })).toBeNull();
  });

  it("a network error offers a retry that confirms the address", async () => {
    let fail = true;
    const calls = mockFetch({});
    const ok = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (fail) {
        calls.push({ url, init: init ?? {} });
        throw new TypeError("Failed to fetch");
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    renderPage("/verify-email?token=tok-3");
    expect(await screen.findByRole("heading", { name: "Bestätigung fehlgeschlagen" })).toBeInTheDocument();
    fail = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByRole("heading", { name: "Deine E-Mail-Adresse ist bestätigt" })).toBeInTheDocument();
    globalThis.fetch = ok;
  });

  it("without a token: explains where the link comes from and asks nothing of the node", async () => {
    const calls = mockFetch({});
    renderPage("/verify-email");
    expect(await screen.findByRole("heading", { name: "E-Mail-Adresse bestätigen" })).toBeInTheDocument();
    expect(screen.getByText(/Öffne den Link aus der Bestätigungsmail/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Anmelden" })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url.includes("/verify-email"))).toBe(false));
  });
});
