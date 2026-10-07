// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Channel, RoomDetail } from "@tavrn/sdk";
import { HistoryPolicySection, historyPolicyValue } from "./HistoryPolicy";
import { useAuth } from "../../stores/auth";
import { mockFetch, renderWithProviders } from "../../test/render";

const room = { id: "r1", name: "Raum", my_permissions: "0", channels: [], categories: [] } as unknown as RoomDetail;
const channel = (policy: string) => ({ id: "c1", room_id: "r1", kind: "text", name: "allgemein", encrypted: true, history_for_new_members: policy }) as unknown as Channel;

describe("HistoryPolicySection (ENCRYPTION.md §7b)", () => {
  it("builds the policy value and keeps days in range", () => {
    expect(historyPolicyValue("since_join", 5)).toBe("since_join");
    expect(historyPolicyValue("all", 5)).toBe("all");
    expect(historyPolicyValue("days", 14)).toBe("days:14");
    expect(historyPolicyValue("days", 0)).toBe("days:1");
    expect(historyPolicyValue("days", 99999)).toBe("days:3650");
    expect(historyPolicyValue("days", Number.NaN)).toBe("days:1");
  });

  it("explains the setting and saves a day window", async () => {
    useAuth.setState({ token: "acc" });
    const calls = mockFetch({ "/rooms/r1/channels/c1": { body: channel("days:7") } });
    let changed = 0;
    renderWithProviders(<HistoryPolicySection channel={channel("since_join")} room={room} canManage onChanged={async () => void changed++} />);
    expect(screen.getByText("Verlauf für neue Mitglieder")).toBeInTheDocument();
    expect(screen.getByText(/nimmt bereits geteilte Schlüssel nicht zurück/)).toBeInTheDocument();
    const save = screen.getByTestId("history-policy-save");
    expect(save).toBeDisabled();
    const u = userEvent.setup();
    await u.selectOptions(screen.getByTestId("history-policy"), "days");
    const days = screen.getByTestId("history-days");
    await u.clear(days);
    await u.type(days, "7");
    await u.click(save);
    const patch = calls.find((c) => c.url.endsWith("/rooms/r1/channels/c1") && c.init.method === "PATCH");
    expect(JSON.parse(String(patch!.init.body))).toEqual({ history_for_new_members: "days:7" });
    expect(changed).toBe(1);
  });

  it("is read-only without manage_channels", () => {
    renderWithProviders(<HistoryPolicySection channel={channel("all")} room={room} canManage={false} onChanged={async () => undefined} />);
    expect(screen.getByTestId("history-policy")).toBeDisabled();
    expect(screen.getByTestId("history-policy")).toHaveValue("all");
    expect(screen.queryByTestId("history-policy-save")).toBeNull();
  });
});
