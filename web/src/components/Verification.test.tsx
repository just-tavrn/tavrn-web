// SPDX-License-Identifier: Apache-2.0
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../stores/auth";
import { useE2ee } from "../stores/e2ee";
import { useMlsUi } from "../stores/mls";
import { renderWithProviders } from "../test/render";
import { VerifiedBadge, VerifyButton, VerifyDialog, safetyNumberGroups } from "./Verification";

const NUMBER = "040339216913827958187952294580671215546444183407797709380693";
const PAYLOAD = "tavrn:verify?v=1&a=alice@t.local&ka=AAAA&b=bob@t.local&kb=BBBB";

const manager = {
  safetyNumber: vi.fn(async (address: string) => (address === "alice@t.local" ? { number: NUMBER, payload: PAYLOAD } : null)),
  comparePayload: vi.fn((_: string, payload: string) => payload === PAYLOAD),
  verifiedContact: vi.fn(() => undefined),
};
const markVerified = vi.fn(async () => true);
const dismissVerificationRefresh = vi.fn(async () => undefined);
const removeVerification = vi.fn(async () => undefined);

vi.mock(import("../stores/mls"), async (original) => ({
  ...(await original()),
  getMls: async () => manager as never,
  markVerified: (...args: unknown[]) => markVerified(...(args as [])),
  removeVerification: (...args: unknown[]) => removeVerification(...(args as [])),
  dismissVerificationRefresh: (...args: unknown[]) => dismissVerificationRefresh(...(args as [])),
}));

const me = { id: "u1", username: "bob", domain: "t.local", address: "bob@t.local", display_name: "Bob", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };

beforeEach(() => {
  useAuth.setState({ token: "t", user: me as never });
  useE2ee.setState({ status: "unlocked" });
  useMlsUi.setState({ verification: {} });
  markVerified.mockClear();
  removeVerification.mockClear();
});

describe("safetyNumberGroups", () => {
  it("splits 60 digits into 12 groups of 5", () => {
    const groups = safetyNumberGroups(NUMBER);
    expect(groups).toHaveLength(12);
    expect(groups[0]).toBe("04033");
    expect(groups.join("")).toBe(NUMBER);
  });
});

describe("VerifyDialog", () => {
  it("shows the safety number and QR code, compares a pasted code and marks the contact as verified (QR)", async () => {
    const u = userEvent.setup();
    renderWithProviders(<VerifyDialog address="alice@t.local" onClose={() => {}} />);
    const number = await screen.findByTestId("safety-number");
    expect(number.querySelectorAll("span")).toHaveLength(12);
    expect(number).toHaveTextContent("04033 92169 13827 95818".replace(/ /g, ""));
    expect(screen.getByTestId("verify-qr")).toBeInTheDocument();
    expect(screen.getByTestId("verify-payload")).toHaveValue(PAYLOAD);
    expect(screen.getByTestId("verify-state")).toHaveTextContent("Noch nicht verifiziert");

    const field = screen.getByLabelText("Gescannter oder eingefügter Code der anderen Person");
    await u.type(field, "tavrn:verify?v=1&a=x");
    await u.click(screen.getByRole("button", { name: "Vergleichen" }));
    expect(screen.getByTestId("verify-result")).toHaveAttribute("data-result", "mismatch");
    expect(screen.getByRole("button", { name: "Als verifiziert markieren" })).toBeDisabled();

    await u.clear(field);
    await u.click(field);
    await u.paste(` ${PAYLOAD}\n`);
    await u.click(screen.getByRole("button", { name: "Vergleichen" }));
    expect(screen.getByTestId("verify-result")).toHaveTextContent("Die Codes stimmen überein.");
    await u.click(screen.getByRole("button", { name: "Als verifiziert markieren" }));
    await waitFor(() => expect(markVerified).toHaveBeenCalledWith("alice@t.local", "qr"));
  });

  it("marks as verified by numeric comparison, and offers removal for verified contacts", async () => {
    const u = userEvent.setup();
    const { unmount } = renderWithProviders(<VerifyDialog address="alice@t.local" onClose={() => {}} />);
    await u.click(await screen.findByRole("button", { name: "Als verifiziert markieren" }));
    await waitFor(() => expect(markVerified).toHaveBeenCalledWith("alice@t.local", "numeric"));
    unmount();
    useMlsUi.setState({ verification: { "alice@t.local": "verified" } });
    renderWithProviders(<VerifyDialog address="alice@t.local" onClose={() => {}} />);
    expect(await screen.findByTestId("verify-state")).toHaveAttribute("data-state", "verified");
    await u.click(screen.getByRole("button", { name: "Verifizierung entfernen" }));
    await waitFor(() => expect(removeVerification).toHaveBeenCalledWith("alice@t.local"));
  });

  it("explains a broken verification, and when nothing can be compared", async () => {
    useMlsUi.setState({ verification: { "alice@t.local": "broken" } });
    const { unmount } = renderWithProviders(<VerifyDialog address="alice@t.local" onClose={() => {}} />);
    expect(await screen.findByTestId("verify-state")).toHaveTextContent("nach deiner Verifizierung geändert");
    unmount();
    renderWithProviders(<VerifyDialog address="eve@other.example" onClose={() => {}} />);
    expect(await screen.findByText(/noch kein Sicherheitsschlüssel bekannt/)).toBeInTheDocument();
  });

  it("asks to unlock when this device is locked", async () => {
    useE2ee.setState({ status: "locked" });
    renderWithProviders(<VerifyDialog address="alice@t.local" onClose={() => {}} />);
    expect(await screen.findByText(/Entsperre deine verschlüsselten Nachrichten/)).toBeInTheDocument();
  });
});

describe("VerifyButton", () => {
  it("opens the dialog for others and is hidden for the own account", async () => {
    const { unmount } = renderWithProviders(<VerifyButton address="bob@t.local" />);
    expect(screen.queryByTestId("verify-button")).not.toBeInTheDocument();
    unmount();
    renderWithProviders(<VerifyButton address="alice@t.local" name="Alice" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Alice verifizieren" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Sicherheitsschlüssel verifizieren");
    expect(await screen.findByTestId("safety-number")).toBeInTheDocument();
  });
});

describe("VerifiedBadge after a rotation (ENCRYPTION.md §9a)", () => {
  it("asks softly for a fresh verification and can be dismissed", async () => {
    useMlsUi.setState({ verification: { "alice@t.local": "refresh" } });
    const u = userEvent.setup();
    renderWithProviders(<VerifiedBadge address="alice@t.local" />);
    const badge = screen.getByTestId("verification-refresh-badge");
    expect(badge).toHaveTextContent("Verifizierung erneuern");
    expect(screen.queryByTestId("verification-broken-badge")).toBeNull();
    await u.click(badge);
    expect(dismissVerificationRefresh).toHaveBeenCalledWith("alice@t.local");
  });

  it("the dialog explains the refresh and offers to verify again", async () => {
    useMlsUi.setState({ verification: { "alice@t.local": "refresh" } });
    renderWithProviders(<VerifyDialog address="alice@t.local" onClose={() => {}} />);
    expect(await screen.findByTestId("verify-state")).toHaveTextContent("erneuert (vom bisherigen Schlüssel signiert)");
    expect(screen.getByRole("button", { name: "Als verifiziert markieren" })).toBeInTheDocument();
  });
});
