// SPDX-License-Identifier: Apache-2.0
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { RoomDetail } from "@tavrn/sdk";
import { WebhooksTab } from "./WebhooksTab";
import { useAuth } from "../../stores/auth";
import { mockFetch, renderWithProviders } from "../../test/render";

const channel = (id: string, kind: string, name: string) => ({ id, room_id: "r1", kind, name, encrypted: false });
const room = {
  id: "r1",
  name: "Raum",
  my_permissions: "0",
  categories: [],
  channels: [channel("c1", "text", "allgemein"), channel("c2", "forum", "hilfe"), channel("c3", "voice", "Sprache")],
} as unknown as RoomDetail;

describe("WebhooksTab (APPLICATIONS.md §6.1)", () => {
  it("offers forum channels and explains that their webhooks post into posts (thread_id)", async () => {
    useAuth.setState({ token: "acc" });
    mockFetch({ "/rooms/r1/webhooks": { body: [] } });
    renderWithProviders(<WebhooksTab room={room} />);
    const select = screen.getByTestId("webhook-channel");
    expect([...select.querySelectorAll("option")].map((o) => o.value)).toEqual(["c1", "c2"]);
    expect(screen.queryByTestId("webhook-forum-hint")).toBeNull();
    await userEvent.setup().selectOptions(select, "c2");
    await waitFor(() => expect(screen.getByTestId("webhook-forum-hint")).toHaveTextContent(/thread_id/));
    expect(screen.getByTestId("webhook-forum-hint")).toHaveTextContent(/Beitrag/);
  });
});
