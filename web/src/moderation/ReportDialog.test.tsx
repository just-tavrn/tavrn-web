// SPDX-License-Identifier: Apache-2.0
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Message, TavrnApi } from "@tavrn/sdk";
import { renderWithProviders } from "../test/render";
import { ReportDialog } from "./ReportDialog";
import type { EvidenceCandidate } from "./evidence";

const message = { id: "M3", conversation_id: "C1", author: "mallory@n.example", encrypted: true } as unknown as Message;
const candidate = (id: string, reported = false): EvidenceCandidate => ({ message_id: id, author: "mallory@n.example", device_id: "D", created_at: "2026-10-01T10:00:00Z", text: `text ${id}`, attachments: [], reported });

function client() {
  const create = vi.fn(async (_req: unknown) => ({ id: "R1", status: "open", merged: false }));
  return { api: { reports: { create } } as unknown as TavrnApi, create };
}

describe("ReportDialog", () => {
  it("sends no plaintext without consent", async () => {
    const { api, create } = client();
    renderWithProviders(<ReportDialog subject={{ kind: "message", message, encrypted: true, candidates: [candidate("M1"), candidate("M3", true)], roomName: "Guild" }} client={api} node="n.example" onClose={() => undefined} />);
    expect(screen.queryByTestId("report-evidence-list")).toBeNull();
    await userEvent.setup().click(screen.getByTestId("report-submit"));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![0]).toEqual({ kind: "message", conversation_id: "C1", message_id: "M3", category: "spam", detail: "" });
  });

  it("shows exactly what is shared and lets the reporter leave context messages out", async () => {
    const { api, create } = client();
    const onClose = vi.fn();
    renderWithProviders(<ReportDialog subject={{ kind: "message", message, encrypted: true, candidates: [candidate("M1"), candidate("M2"), candidate("M3", true)], remoteNode: "other.example" }} client={api} node="home.example" onClose={onClose} />);
    const u = userEvent.setup();
    await u.selectOptions(screen.getByTestId("report-category"), "harassment");
    await u.type(screen.getByTestId("report-detail"), "threats");
    await u.click(screen.getByTestId("report-consent"));
    expect(screen.getByTestId("report-evidence-list")).toHaveTextContent("text M2");
    expect(screen.getByTestId("report-evidence-reported")).toBeDisabled();
    expect(screen.getByTestId("report-evidence-reported")).toBeChecked();
    await u.click(screen.getAllByTestId("report-evidence-context")[0]!);
    await u.click(screen.getByTestId("report-submit"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const req = create.mock.calls[0]![0] as { node: string; user: string; category: string; detail: string; evidence: { message_id: string }[] };
    expect(req).toMatchObject({ node: "other.example", user: "mallory@n.example", category: "harassment", detail: "threats" });
    expect(req.evidence.map((e) => e.message_id)).toEqual(["M2", "M3"]);
  });

  it("explains that plaintext messages are linked and reports members with their room", async () => {
    const { api, create } = client();
    const { unmount } = renderWithProviders(<ReportDialog subject={{ kind: "message", message: { ...message, encrypted: false }, encrypted: false, candidates: [] }} client={api} node="n.example" onClose={() => undefined} />);
    expect(screen.queryByTestId("report-evidence")).toBeNull();
    unmount();
    renderWithProviders(<ReportDialog subject={{ kind: "user", address: "bob@n.example", name: "Bob", roomId: "ROOM", roomName: "Guild" }} client={api} node="n.example" onClose={() => undefined} />);
    await userEvent.setup().click(screen.getByTestId("report-submit"));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ kind: "user", user: "bob@n.example", room_id: "ROOM", category: "spam", detail: "" }));
  });
});
