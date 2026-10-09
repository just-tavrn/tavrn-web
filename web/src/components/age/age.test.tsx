// SPDX-License-Identifier: Apache-2.0
// Date of birth dialog, age gate settings and the locked channel view (protocol PROTOCOL.md §5e).
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DateOfBirthGate } from "./DateOfBirthGate";
import { AgeGateSection } from "./AgeGateSection";
import { AdultsOnlyBadge, LockedChannel } from "./LockedChannel";
import { useChannelLock } from "../../lib/age";
import { useAuth } from "../../stores/auth";
import { mockFetch, renderWithProviders } from "../../test/render";

const user = { id: "u1", username: "alice", domain: "t.local", address: "alice@t.local", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true, has_password: true };
const node = { domain: "t.local", age: { self_declared: true, gates: ["adults_only"], minimum_age: 16 } };

beforeEach(() => {
  useAuth.setState({ token: "acc", refresh: "ref", user, deviceId: "dev" });
});

describe("DateOfBirthGate", () => {
  it("asks an account without a date of birth, checks it and saves it once", async () => {
    let saved = false;
    const calls = mockFetch({
      "/api/v1/users/me/date-of-birth": () => {
        saved = true;
        return { body: { ...user, date_of_birth: "1990-05-17", age_status: { tier: "adult", method: "self" } } };
      },
      "/api/v1/users/me": () => ({ body: { ...user, date_of_birth: saved ? "1990-05-17" : null, age_status: saved ? { tier: "adult", method: "self" } : { tier: "unknown", method: "none" } } }),
      "/api/v1/node": { body: node },
    });
    renderWithProviders(<DateOfBirthGate />);
    const dialog = await screen.findByRole("dialog", { name: "Bitte gib dein Geburtsdatum an" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByTestId("date-of-birth-error")).toHaveTextContent("gültiges Geburtsdatum");
    const twelve = new Date();
    twelve.setUTCFullYear(twelve.getUTCFullYear() - 12);
    fireEvent.change(screen.getByLabelText("Geburtsdatum"), { target: { value: twelve.toISOString().slice(0, 10) } });
    await u.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByTestId("date-of-birth-error")).toHaveTextContent("mindestens 16 Jahre");
    expect(calls.some((c) => c.url.includes("date-of-birth"))).toBe(false);
    fireEvent.change(screen.getByLabelText("Geburtsdatum"), { target: { value: "1990-05-17" } });
    await u.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const put = calls.find((c) => c.url.includes("date-of-birth"))!;
    expect(put.init.method).toBe("PUT");
    expect(JSON.parse(put.init.body as string)).toEqual({ date_of_birth: "1990-05-17" });
  });

  it("stays away for accounts with a status and for nodes without age.v1", async () => {
    for (const me of [{ ...user, age_status: { tier: "minor", method: "self" } }, user]) {
      const calls = mockFetch({ "/api/v1/users/me": { body: me } });
      const { unmount } = renderWithProviders(<DateOfBirthGate />);
      await waitFor(() => expect(calls.some((c) => c.url.includes("/users/me"))).toBe(true));
      expect(screen.queryByRole("dialog")).toBeNull();
      unmount();
    }
  });

  it("shows the node's refusal", async () => {
    mockFetch({
      "/api/v1/users/me/date-of-birth": { status: 409, body: { code: "age.date_of_birth_set", status: 409, title: "Conflict", detail: "set", type: "x" } },
      "/api/v1/users/me": { body: { ...user, age_status: { tier: "unknown", method: "none" } } },
      "/api/v1/node": { body: node },
    });
    renderWithProviders(<DateOfBirthGate />);
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText("Geburtsdatum"), { target: { value: "1990-05-17" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("bereits gesetzt");
  });
});

describe("AgeGateSection", () => {
  it("offers both gates with an explanation and saves the choice", async () => {
    const onSave = vi.fn(async () => undefined);
    renderWithProviders(<AgeGateSection scope="room" value="none" canManage onSave={onSave} />);
    expect(screen.getByText(/finden diesen Raum nicht unter Entdecken/)).toBeInTheDocument();
    const select = screen.getByLabelText("Altersbeschränkung");
    expect(screen.getByRole("option", { name: "Nur Erwachsene (18+)" })).toBeInTheDocument();
    await userEvent.setup().selectOptions(select, "adults_only");
    expect(onSave).toHaveBeenCalledWith("adults_only");
    await waitFor(() => expect(select).toHaveValue("adults_only"));
  });

  it("goes back when the node refuses, names the room's gate and is read-only without the permission", async () => {
    const onSave = vi.fn(async () => {
      throw Object.assign(new Error("restricted"), { problem: { code: "age.restricted" } });
    });
    const { unmount } = renderWithProviders(<AgeGateSection scope="channel" value="none" inherited canManage onSave={onSave} />);
    const select = screen.getByLabelText("Altersbeschränkung");
    expect(select).toHaveAccessibleDescription(/ganze Raum ist nur für Erwachsene/);
    await userEvent.setup().selectOptions(select, "adults_only");
    await waitFor(() => expect(select).toHaveValue("none"));
    unmount();
    renderWithProviders(<AgeGateSection scope="channel" value="adults_only" canManage={false} onSave={onSave} />);
    expect(screen.getByLabelText("Altersbeschränkung")).toBeDisabled();
  });
});

function LockHarness({ gate }: { gate: string }) {
  const lock = useChannelLock({ age_gate_effective: gate });
  if (lock.pending) return <p>lädt</p>;
  return lock.locked ? <LockedChannel name="late" /> : <p>Inhalt</p>;
}

describe("locked channels", () => {
  it("lock gated channels for minors and unknown ages, never for adults or ungated channels", async () => {
    for (const [tier, gate, expected] of [
      ["minor", "adults_only", "locked"],
      ["unknown", "adults_only", "locked"],
      ["adult", "adults_only", "open"],
      ["minor", "none", "open"],
    ] as const) {
      mockFetch({ "/api/v1/users/me": { body: { ...user, age_status: { tier, method: "self" } } } });
      const { unmount } = renderWithProviders(<LockHarness gate={gate} />);
      if (expected === "locked") {
        expect(await screen.findByTestId("age-locked")).toHaveTextContent("Dieser Kanal ist nur für Erwachsene");
        expect(screen.getByRole("heading", { name: "Dieser Kanal ist nur für Erwachsene" })).toBeInTheDocument();
        expect(screen.queryByText("Inhalt")).toBeNull();
      } else {
        expect(await screen.findByText("Inhalt")).toBeInTheDocument();
      }
      unmount();
    }
  });

  it("the badge has an accessible name", () => {
    renderWithProviders(<AdultsOnlyBadge />);
    expect(screen.getByRole("img", { name: "Nur für Erwachsene" })).toHaveTextContent("18+");
  });
});
