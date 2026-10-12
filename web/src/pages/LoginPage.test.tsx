// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router";
import { LoginPage } from "./LoginPage";
import { useAuth } from "../stores/auth";
import { useAuthFlow } from "../stores/authFlow";
import { mockFetch, renderWithProviders } from "../test/render";

const user = { id: "u1", username: "alice", domain: "t.local", address: "alice@t.local", display_name: "Alice", kind: "user", is_node_admin: true, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: false };
const session = { status: "ok", user, access_token: "acc", refresh_token: "ref", expires_in: 3600, device_id: "01J9ZK3G5M8Q2W4E6R8T0Y2VA1", recovery_code_used: false };
const verifyStep = { status: "second_factor_required", preauth_token: "pre-v", methods: ["totp", "recovery_code"], expires_in: 600 };
const enrollStep = { status: "enrollment_required", preauth_token: "pre-e", methods: ["totp", "webauthn"], expires_in: 600 };
const codes = Array.from({ length: 10 }, (_, i) => `aaaa-bbbb-000${i}`);

function renderLogin(route = "/login") {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/encryption" element={<p>Verschlüsselungsseite</p>} />
      <Route path="/" element={<p>Startseite</p>} />
    </Routes>,
    { route },
  );
}

const body = (c: { init: RequestInit }) => JSON.parse(c.init.body as string) as Record<string, unknown>;
const auth = (c: { init: RequestInit }) => (c.init.headers as Record<string, string>).Authorization;

beforeEach(() => {
  useAuth.getState().logout();
  useAuthFlow.getState().clearPreauth();
  useAuthFlow.getState().setSetup(null);
  sessionStorage.clear();
});

describe("LoginPage: sign-in with the second factor", () => {
  it("password, then TOTP code, stores the session and continues to the encryption step", async () => {
    const calls = mockFetch({ "/api/v1/node": { body: { name: "Testknoten", domain: "t.local", registration: "open" } }, "/api/v1/auth/login": { body: verifyStep }, "/api/v1/auth/second-factor/verify": { body: session } });
    renderLogin("/login?next=%2Frooms%2Fx");
    expect(await screen.findByText("Testknoten (t.local)")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "tavrn" })).toHaveAttribute("src", "/logo.png");
    const u = userEvent.setup();
    await u.type(screen.getByLabelText("Benutzername"), "alice");
    await u.type(screen.getByLabelText("Passwort"), "passwort-alice-123");
    await u.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("heading", { name: "Anmeldung bestätigen" })).toBeInTheDocument();
    expect(useAuth.getState().token).toBeNull();
    // The pre-auth token (and nothing secret) is kept for a reload.
    expect(JSON.parse(sessionStorage.getItem("tavrn.preauth")!)).toMatchObject({ token: "pre-v", status: "second_factor_required", username: "alice" });
    expect(sessionStorage.getItem("tavrn.preauth")).not.toContain("passwort");
    await u.type(screen.getByLabelText("6-stelliger Code"), "123 456");
    await u.click(screen.getByRole("button", { name: "Bestätigen" }));
    expect(await screen.findByText("Verschlüsselungsseite")).toBeInTheDocument();
    expect(useAuth.getState().token).toBe("acc");
    expect(useAuth.getState().deviceId).toBe(session.device_id);
    expect(sessionStorage.getItem("tavrn.preauth")).toBeNull();
    const verify = calls.find((c) => c.url.includes("/second-factor/verify"))!;
    expect(body(verify)).toEqual({ preauth_token: "pre-v", totp_code: "123456" });
  });

  it("switches to a recovery code and warns after using one", async () => {
    const calls = mockFetch({ "/api/v1/node": { body: {} }, "/api/v1/auth/login": { body: verifyStep }, "/api/v1/auth/second-factor/verify": { body: { ...session, recovery_code_used: true } } });
    renderLogin();
    const u = userEvent.setup();
    await u.type(screen.getByLabelText("Benutzername"), "alice");
    await u.type(screen.getByLabelText("Passwort"), "passwort-alice-123");
    await u.click(screen.getByRole("button", { name: "Anmelden" }));
    await u.click(await screen.findByRole("button", { name: "Wiederherstellungscode verwenden" }));
    await u.type(screen.getByLabelText("Wiederherstellungscode"), "aaaa-bbbb-cccc");
    await u.click(screen.getByRole("button", { name: "Bestätigen" }));
    expect(await screen.findByText("Verschlüsselungsseite")).toBeInTheDocument();
    expect(body(calls.find((c) => c.url.includes("/second-factor/verify"))!)).toEqual({ preauth_token: "pre-v", recovery_code: "aaaa-bbbb-cccc" });
  });

  it("shows Problem Details errors of both steps", async () => {
    mockFetch({
      "/api/v1/node": { body: {} },
      "/api/v1/auth/login": { body: verifyStep },
      "/api/v1/auth/second-factor/verify": { status: 401, body: { code: "auth.second_factor_invalid", status: 401, title: "x", detail: "wrong", type: "x" } },
    });
    renderLogin();
    const u = userEvent.setup();
    await u.type(screen.getByLabelText("Benutzername"), "alice");
    await u.type(screen.getByLabelText("Passwort"), "passwort-alice-123");
    await u.click(screen.getByRole("button", { name: "Anmelden" }));
    await u.type(await screen.findByLabelText("6-stelliger Code"), "000000");
    await u.click(screen.getByRole("button", { name: "Bestätigen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Der Code ist falsch oder wurde schon verwendet");
    await u.click(screen.getByRole("button", { name: "Abbrechen und neu beginnen" }));
    expect(await screen.findByRole("tab", { name: "Anmelden" })).toBeInTheDocument();
  });

  it("wrong password shows the error and keeps no pre-auth state", async () => {
    mockFetch({ "/api/v1/node": { body: {} }, "/api/v1/auth/login": { status: 401, body: { code: "auth.invalid_credentials", status: 401, title: "Nicht angemeldet", detail: "x", type: "x" } } });
    renderLogin();
    const u = userEvent.setup();
    await u.type(screen.getByLabelText("Benutzername"), "alice");
    await u.type(screen.getByLabelText("Passwort"), "falsch-falsch");
    await u.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Benutzername oder Passwort falsch");
    expect(useAuthFlow.getState().preauth).toBeNull();
  });

  it("restores the second-factor step after a reload and drops an expired one", async () => {
    sessionStorage.setItem("tavrn.preauth", JSON.stringify({ token: "pre-v", status: "second_factor_required", methods: ["totp"], expiresAt: Date.now() + 60_000, kind: "login", username: "alice" }));
    useAuthFlow.getState().refresh();
    mockFetch({ "/api/v1/node": { body: {} } });
    const { unmount } = renderLogin();
    expect(await screen.findByRole("heading", { name: "Anmeldung bestätigen" })).toBeInTheDocument();
    expect(screen.getByTestId("flow-account")).toHaveTextContent("alice");
    unmount();
    sessionStorage.setItem("tavrn.preauth", JSON.stringify({ token: "pre-v", status: "second_factor_required", methods: ["totp"], expiresAt: Date.now() - 1, kind: "login", username: "alice" }));
    act(() => useAuthFlow.getState().refresh());
    renderLogin();
    expect(await screen.findByRole("tab", { name: "Anmelden" })).toBeInTheDocument();
  });

  it("an account without a factor (e.g. after an admin reset) enrolls at sign-in", async () => {
    mockFetch({ "/api/v1/node": { body: {} }, "/api/v1/auth/login": { body: enrollStep } });
    renderLogin();
    const u = userEvent.setup();
    await u.type(screen.getByLabelText("Benutzername"), "alice");
    await u.type(screen.getByLabelText("Passwort"), "passwort-alice-123");
    await u.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("heading", { name: "Zweiten Faktor einrichten" })).toBeInTheDocument();
    expect(screen.queryByTestId("wizard-steps")).not.toBeInTheDocument();
  });
});

describe("LoginPage: registration wizard", () => {
  it("account → TOTP enrollment with QR code and secret → recovery codes → encryption step", async () => {
    const calls = mockFetch({
      "/api/v1/node": { body: { registration: "open" } },
      "/api/v1/auth/register": { status: 201, body: enrollStep },
      "/api/v1/auth/totp/enroll": { body: { secret: "JBSWY3DPEHPK3PXP", otpauth_url: "otpauth://totp/t.local:alice?secret=JBSWY3DPEHPK3PXP&issuer=t.local", issuer: "t.local" } },
      "/api/v1/auth/totp/confirm": { body: { recovery_codes: codes, session } },
    });
    renderLogin("/login?next=%2Finvite%2Fabc");
    const u = userEvent.setup();
    await u.click(await screen.findByRole("tab", { name: "Registrieren" }));
    expect(screen.getByTestId("wizard-steps")).toHaveTextContent("Schritt 1 von 4");
    await u.type(screen.getByLabelText("Benutzername"), "alice");
    await u.type(screen.getByLabelText("Passwort"), "passwort-alice-123");
    await u.type(screen.getByLabelText("Passwort wiederholen"), "passwort-alice-123");
    fireEvent.change(screen.getByLabelText("Geburtsdatum"), { target: { value: "1990-05-17" } });
    await u.type(screen.getByLabelText("Anzeigename (optional)"), "Alice");
    await u.click(screen.getByRole("button", { name: "Konto erstellen" }));

    expect(await screen.findByRole("heading", { name: "Zweiten Faktor einrichten" })).toBeInTheDocument();
    expect(screen.getByTestId("wizard-steps")).toHaveTextContent("Schritt 2 von 4");
    await u.click(screen.getByTestId("choose-totp"));
    expect(await screen.findByTestId("totp-secret")).toHaveTextContent("JBSWY3DPEHPK3PXP");
    expect(screen.getByRole("img", { name: "QR-Code für die Authenticator-App" })).toBeInTheDocument();
    await u.type(screen.getByLabelText("6-stelliger Code"), "654321");
    await u.click(screen.getByRole("button", { name: "Aktivieren" }));

    expect(await screen.findByRole("heading", { name: "Deine Wiederherstellungscodes" })).toBeInTheDocument();
    expect(screen.getByTestId("wizard-steps")).toHaveTextContent("Schritt 3 von 4");
    expect(screen.getByTestId("recovery-codes").querySelectorAll("li")).toHaveLength(10);
    expect(useAuth.getState().token).toBe("acc");
    const next = screen.getByRole("button", { name: "Weiter" });
    expect(next).toBeDisabled();
    await u.click(screen.getByLabelText("Ich habe die Codes sicher aufbewahrt"));
    await u.click(next);
    expect(await screen.findByText("Verschlüsselungsseite")).toBeInTheDocument();
    expect(useAuthFlow.getState().setup).toEqual({ kind: "register" });

    const reg = calls.find((c) => c.url.includes("/auth/register"))!;
    expect(body(reg)).toMatchObject({ username: "alice", display_name: "Alice", date_of_birth: "1990-05-17" });
    expect(auth(calls.find((c) => c.url.includes("/totp/enroll"))!)).toBe("Bearer pre-e");
    expect(body(calls.find((c) => c.url.includes("/totp/confirm"))!)).toEqual({ code: "654321" });
  });

  it("requires a plausible date of birth and the node's minimum age before asking the node", async () => {
    const calls = mockFetch({ "/api/v1/node": { body: { registration: "open", age: { self_declared: true, gates: ["adults_only"], minimum_age: 18 } } }, "/api/v1/auth/register": { status: 201, body: enrollStep } });
    renderLogin();
    const u = userEvent.setup();
    await u.click(await screen.findByRole("tab", { name: "Registrieren" }));
    await u.type(screen.getByLabelText("Benutzername"), "alice");
    await u.type(screen.getByLabelText("Passwort"), "passwort-alice-123");
    await u.type(screen.getByLabelText("Passwort wiederholen"), "passwort-alice-123");
    const dob = screen.getByLabelText("Geburtsdatum");
    expect(dob).toHaveAttribute("type", "date");
    expect(dob).toHaveAttribute("aria-required", "true");
    expect(dob).toHaveAccessibleDescription(/nur auf diesem Knoten/);
    await u.click(screen.getByRole("button", { name: "Konto erstellen" }));
    expect(await screen.findByTestId("date-of-birth-error")).toHaveTextContent("gültiges Geburtsdatum");
    expect(dob).toHaveAttribute("aria-invalid", "true");
    expect(dob).toHaveAccessibleDescription(/gültiges Geburtsdatum/);
    const seventeen = new Date();
    seventeen.setUTCFullYear(seventeen.getUTCFullYear() - 17);
    fireEvent.change(dob, { target: { value: seventeen.toISOString().slice(0, 10) } });
    await u.click(screen.getByRole("button", { name: "Konto erstellen" }));
    expect(await screen.findByTestId("date-of-birth-error")).toHaveTextContent("mindestens 18 Jahre");
    expect(calls.some((c) => c.url.includes("/auth/register"))).toBe(false);
    fireEvent.change(dob, { target: { value: "2000-02-29" } });
    expect(screen.queryByTestId("date-of-birth-error")).toBeNull();
    await u.click(screen.getByRole("button", { name: "Konto erstellen" }));
    expect(await screen.findByRole("heading", { name: "Zweiten Faktor einrichten" })).toBeInTheDocument();
    expect(body(calls.find((c) => c.url.includes("/auth/register"))!)).toMatchObject({ date_of_birth: "2000-02-29" });
  });

  it("blocks the closed registration", async () => {
    mockFetch({ "/api/v1/node": { body: { name: "Zu", domain: "t.local", registration: "closed" } } });
    renderLogin();
    await screen.findByText("Zu (t.local)");
    await userEvent.setup().click(screen.getByRole("tab", { name: "Registrieren" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Konto erstellen" })).toBeDisabled());
    expect(screen.getByRole("alert")).toHaveTextContent("keine neuen Konten");
  });

  it("requires matching passwords without asking the node", async () => {
    const calls = mockFetch({ "/api/v1/node": { body: { registration: "open" } } });
    renderLogin();
    const u = userEvent.setup();
    await u.click(screen.getByRole("tab", { name: "Registrieren" }));
    await u.type(screen.getByLabelText("Benutzername"), "alice");
    await u.type(screen.getByLabelText("Passwort"), "passwort-alice-123");
    await u.type(screen.getByLabelText("Passwort wiederholen"), "passwort-alice-124");
    await u.click(screen.getByRole("button", { name: "Konto erstellen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("stimmen nicht überein");
    expect(calls.some((c) => c.url.includes("/auth/register"))).toBe(false);
  });

  it("takes ?invite= from the URL and sends it", async () => {
    const calls = mockFetch({ "/api/v1/node": { body: { registration: "invite" } }, "/api/v1/auth/register": { status: 201, body: enrollStep } });
    renderLogin("/login?invite=ABC123");
    expect(await screen.findByLabelText("Einladungscode")).toHaveValue("ABC123");
    const u = userEvent.setup();
    await u.type(screen.getByLabelText("Benutzername"), "alice");
    await u.type(screen.getByLabelText("Passwort", { exact: true }), "passwort-alice-123");
    await u.type(screen.getByLabelText("Passwort wiederholen"), "passwort-alice-123");
    fireEvent.change(screen.getByLabelText("Geburtsdatum"), { target: { value: "1990-05-17" } });
    await u.click(screen.getByRole("button", { name: "Konto erstellen" }));
    expect(await screen.findByRole("heading", { name: "Zweiten Faktor einrichten" })).toBeInTheDocument();
    expect(body(calls.find((c) => c.url.includes("/auth/register"))!)).toMatchObject({ invite: "ABC123" });
  });
});

describe("LoginPage: the node's e-mail policy", () => {
  // `email` of the discovery document: none | optional | required (TAVRN_EMAIL).
  const nodeWith = (email: string | null, extra: Record<string, unknown> = {}) => ({
    "/api/v1/node": { body: { registration: "invite", ...extra } },
    "/.well-known/tavrn": email === null ? { status: 503, body: {} } : { body: { domain: "t.local", registration: "invite", email } },
  });
  const fillAccount = async (u: ReturnType<typeof userEvent.setup>) => {
    await u.type(screen.getByLabelText("Benutzername"), "alice");
    await u.type(screen.getByLabelText("Passwort", { exact: true }), "passwort-alice-123");
    await u.type(screen.getByLabelText("Passwort wiederholen"), "passwort-alice-123");
    fireEvent.change(screen.getByLabelText("Geburtsdatum"), { target: { value: "1990-05-17" } });
  };

  it("required: the field is labelled without (optional), is required and checked before asking the node", async () => {
    const calls = mockFetch({ ...nodeWith("required"), "/api/v1/auth/register": { status: 201, body: enrollStep } });
    renderLogin("/login?invite=ABC123");
    const field = await screen.findByLabelText("E-Mail");
    expect(field).toBeRequired();
    expect(screen.queryByLabelText("E-Mail (optional)")).toBeNull();
    const u = userEvent.setup();
    await fillAccount(u);
    // The browser's own check aside, the form checks the field itself before it sends anything.
    fireEvent.submit(screen.getByRole("tabpanel"));
    expect(await screen.findByRole("alert")).toHaveTextContent("E-Mail-Adresse");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(calls.some((c) => c.url.includes("/auth/register"))).toBe(false);
    await u.type(field, "alice@example.org");
    await u.click(screen.getByRole("button", { name: "Konto erstellen" }));
    expect(await screen.findByRole("heading", { name: "Zweiten Faktor einrichten" })).toBeInTheDocument();
    expect(body(calls.find((c) => c.url.includes("/auth/register"))!)).toMatchObject({ email: "alice@example.org", invite: "ABC123" });
  });

  it("optional: the field is labelled (optional) and may stay empty", async () => {
    const calls = mockFetch({ ...nodeWith("optional"), "/api/v1/auth/register": { status: 201, body: enrollStep } });
    renderLogin("/login?invite=ABC123");
    const field = await screen.findByLabelText("E-Mail (optional)");
    expect(field).not.toBeRequired();
    const u = userEvent.setup();
    await fillAccount(u);
    await u.click(screen.getByRole("button", { name: "Konto erstellen" }));
    expect(await screen.findByRole("heading", { name: "Zweiten Faktor einrichten" })).toBeInTheDocument();
    expect(body(calls.find((c) => c.url.includes("/auth/register"))!)).toMatchObject({ email: null });
  });

  it("none: no e-mail field, and no address is sent", async () => {
    const calls = mockFetch({ ...nodeWith("none"), "/api/v1/auth/register": { status: 201, body: enrollStep } });
    renderLogin("/login?invite=ABC123");
    await screen.findByLabelText("Einladungscode");
    await waitFor(() => expect(calls.some((c) => c.url.includes("/.well-known/tavrn"))).toBe(true));
    await waitFor(() => expect(screen.queryByLabelText(/E-Mail/)).toBeNull());
    const u = userEvent.setup();
    await fillAccount(u);
    await u.click(screen.getByRole("button", { name: "Konto erstellen" }));
    expect(await screen.findByRole("heading", { name: "Zweiten Faktor einrichten" })).toBeInTheDocument();
    expect(body(calls.find((c) => c.url.includes("/auth/register"))!)).toMatchObject({ email: null });
  });

  it("unknown policy (discovery document unavailable): the field stays optional, the node decides", async () => {
    mockFetch(nodeWith(null));
    renderLogin("/login?invite=ABC123");
    expect(await screen.findByLabelText("E-Mail (optional)")).not.toBeRequired();
  });

  it("a refused registration keeps every entered value, including the invite code", async () => {
    mockFetch({
      ...nodeWith("required"),
      "/api/v1/auth/register": { status: 403, body: { type: "x", title: "Forbidden", status: 403, code: "auth.invite_invalid", detail: "Invite invalid, expired or used up" } },
    });
    renderLogin("/login?invite=ABC123");
    const u = userEvent.setup();
    await screen.findByLabelText("E-Mail");
    await fillAccount(u);
    await u.type(screen.getByLabelText("Anzeigename (optional)"), "Alice");
    await u.type(screen.getByLabelText("E-Mail"), "alice@example.org");
    await u.click(screen.getByRole("button", { name: "Konto erstellen" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("Benutzername")).toHaveValue("alice");
    expect(screen.getByLabelText("Passwort", { exact: true })).toHaveValue("passwort-alice-123");
    expect(screen.getByLabelText("Passwort wiederholen")).toHaveValue("passwort-alice-123");
    expect(screen.getByLabelText("Geburtsdatum")).toHaveValue("1990-05-17");
    expect(screen.getByLabelText("Anzeigename (optional)")).toHaveValue("Alice");
    expect(screen.getByLabelText("E-Mail")).toHaveValue("alice@example.org");
    expect(screen.getByLabelText("Einladungscode")).toHaveValue("ABC123");
  });
});

describe("LoginPage: e-mail confirmation (TAVRN_EMAIL=required)", () => {
  const nodeRequired = {
    "/api/v1/node": { body: { registration: "open" } },
    "/.well-known/tavrn": { body: { domain: "t.local", registration: "open", email: "required" } },
  };
  const unverified = { status: 403, body: { type: "x", title: "Forbidden", status: 403, code: "auth.email_unverified", detail: "Please verify the email address first" } };
  const signIn = async (u: ReturnType<typeof userEvent.setup>) => {
    await u.type(screen.getByLabelText("Benutzername"), "alice");
    await u.type(screen.getByLabelText("Passwort"), "passwort-alice-123");
    await u.click(screen.getByRole("button", { name: "Anmelden" }));
  };

  it("an unconfirmed address names the problem and sends the confirmation mail again", async () => {
    const calls = mockFetch({ ...nodeRequired, "/api/v1/auth/login": unverified, "/api/v1/auth/verify-email/resend": { body: {} } });
    renderLogin();
    const u = userEvent.setup();
    await signIn(u);
    expect(await screen.findByRole("alert")).toHaveTextContent("Deine E-Mail-Adresse ist noch nicht bestätigt");
    await u.click(screen.getByRole("button", { name: "Bestätigungsmail erneut senden" }));
    expect(await screen.findByText(/ein neuer Link unterwegs/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bestätigungsmail erneut senden" })).toBeNull();
    const resend = calls.filter((c) => c.url.includes("/auth/verify-email/resend"));
    expect(resend).toHaveLength(1);
    expect(body(resend[0]!)).toEqual({ account: "alice" });
    expect(useAuth.getState().token).toBeNull();
  });

  it("a node that cannot send mail says so instead", async () => {
    mockFetch({
      ...nodeRequired,
      "/api/v1/auth/login": unverified,
      "/api/v1/auth/verify-email/resend": { status: 503, body: { type: "x", title: "Unavailable", status: 503, code: "mail.unavailable", detail: "This node sends no e-mail" } },
    });
    renderLogin();
    const u = userEvent.setup();
    await signIn(u);
    await u.click(await screen.findByRole("button", { name: "Bestätigungsmail erneut senden" }));
    expect(await screen.findByText(/kann gerade keine E-Mails senden/)).toBeInTheDocument();
  });

  it("other sign-in errors offer no confirmation mail", async () => {
    mockFetch({ ...nodeRequired, "/api/v1/auth/login": { status: 401, body: { type: "x", title: "Unauthorized", status: 401, code: "auth.invalid_credentials", detail: "" } } });
    renderLogin();
    await signIn(userEvent.setup());
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Bestätigungsmail erneut senden" })).toBeNull();
  });

  it("registration: the field explains the confirmation, and the wizard names the address the link went to", async () => {
    mockFetch({
      ...nodeRequired,
      "/api/v1/auth/register": { status: 201, body: enrollStep },
      "/api/v1/auth/totp/enroll": { body: { secret: "JBSWY3DPEHPK3PXP", otpauth_url: "otpauth://totp/t.local:alice?secret=JBSWY3DPEHPK3PXP&issuer=t.local", issuer: "t.local" } },
      "/api/v1/auth/totp/confirm": { body: { recovery_codes: codes, session: { ...session, user: { ...user, email: "alice@example.org", email_verified: false } } } },
    });
    renderLogin("/login?mode=register");
    const u = userEvent.setup();
    const field = await screen.findByLabelText("E-Mail");
    expect(field).toHaveAccessibleDescription(/Wir senden dir einen Link/);
    await u.type(screen.getByLabelText("Benutzername"), "alice");
    await u.type(screen.getByLabelText("Passwort", { exact: true }), "passwort-alice-123");
    await u.type(screen.getByLabelText("Passwort wiederholen"), "passwort-alice-123");
    fireEvent.change(screen.getByLabelText("Geburtsdatum"), { target: { value: "1990-05-17" } });
    await u.type(field, "alice@example.org");
    await u.click(screen.getByRole("button", { name: "Konto erstellen" }));
    await u.click(await screen.findByTestId("choose-totp"));
    await screen.findByTestId("totp-secret");
    await u.type(screen.getByLabelText("6-stelliger Code"), "654321");
    await u.click(screen.getByRole("button", { name: "Aktivieren" }));
    expect(await screen.findByRole("heading", { name: "Deine Wiederherstellungscodes" })).toBeInTheDocument();
    expect(screen.getByTestId("email-confirmation-notice")).toHaveTextContent(
      "Wir haben einen Bestätigungslink an alice@example.org gesendet. Bestätige deine Adresse, bevor du dich erneut anmeldest",
    );
  });

  it("a confirmed address (or none) shows no notice after the registration", async () => {
    mockFetch({
      "/api/v1/node": { body: { registration: "open" } },
      "/api/v1/auth/register": { status: 201, body: enrollStep },
      "/api/v1/auth/totp/enroll": { body: { secret: "JBSWY3DPEHPK3PXP", otpauth_url: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP", issuer: "t.local" } },
      "/api/v1/auth/totp/confirm": { body: { recovery_codes: codes, session } },
    });
    renderLogin("/login?mode=register");
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText("Benutzername"), "alice");
    await u.type(screen.getByLabelText("Passwort", { exact: true }), "passwort-alice-123");
    await u.type(screen.getByLabelText("Passwort wiederholen"), "passwort-alice-123");
    fireEvent.change(screen.getByLabelText("Geburtsdatum"), { target: { value: "1990-05-17" } });
    await u.click(screen.getByRole("button", { name: "Konto erstellen" }));
    await u.click(await screen.findByTestId("choose-totp"));
    await screen.findByTestId("totp-secret");
    await u.type(screen.getByLabelText("6-stelliger Code"), "654321");
    await u.click(screen.getByRole("button", { name: "Aktivieren" }));
    await screen.findByRole("heading", { name: "Deine Wiederherstellungscodes" });
    expect(screen.queryByTestId("email-confirmation-notice")).toBeNull();
  });
});

describe("LoginPage: captcha", () => {
  afterEach(() => {
    delete window.turnstile;
  });

  it("shows the captcha only when the node requires it and sends the token", async () => {
    window.turnstile = {
      render: vi.fn((_el: HTMLElement, opts: { callback: (t: string) => void }) => {
        setTimeout(() => opts.callback("cap-tok"), 0);
        return "w1";
      }),
      reset: vi.fn(),
      remove: vi.fn(),
    } as unknown as typeof window.turnstile;
    const calls = mockFetch({
      "/api/v1/node": { body: { registration: "open", captcha: { provider: "turnstile", site_key: "site", register: true, login: false } } },
      "/api/v1/auth/register": { status: 201, body: enrollStep },
    });
    renderLogin();
    await screen.findByRole("tab", { name: "Registrieren" });
    expect(screen.queryByTestId("captcha")).not.toBeInTheDocument();
    const u = userEvent.setup();
    await u.click(screen.getByRole("tab", { name: "Registrieren" }));
    expect(await screen.findByTestId("captcha")).toBeInTheDocument();
    await u.type(screen.getByLabelText("Benutzername"), "alice");
    await u.type(screen.getByLabelText("Passwort"), "passwort-alice-123");
    await u.type(screen.getByLabelText("Passwort wiederholen"), "passwort-alice-123");
    fireEvent.change(screen.getByLabelText("Geburtsdatum"), { target: { value: "1990-05-17" } });
    await u.click(screen.getByRole("button", { name: "Konto erstellen" }));
    expect(await screen.findByRole("heading", { name: "Zweiten Faktor einrichten" })).toBeInTheDocument();
    expect(body(calls.find((c) => c.url.includes("/auth/register"))!)).toMatchObject({ captcha_token: "cap-tok" });
  });

  it("blocks without a solved captcha", async () => {
    window.turnstile = { render: vi.fn(() => "w1"), reset: vi.fn(), remove: vi.fn() } as unknown as typeof window.turnstile;
    const calls = mockFetch({ "/api/v1/node": { body: { registration: "open", captcha: { provider: "turnstile", site_key: "site", register: false, login: true } } } });
    renderLogin();
    await screen.findByTestId("captcha");
    const u = userEvent.setup();
    await u.type(screen.getByLabelText("Benutzername"), "alice");
    await u.type(screen.getByLabelText("Passwort"), "passwort-alice-123");
    await u.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Captcha");
    expect(calls.some((c) => c.url.includes("/auth/login"))).toBe(false);
  });
});
