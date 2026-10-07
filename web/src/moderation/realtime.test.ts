// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { alertText, reportPath } from "./realtime";

const t = (key: string, params?: Record<string, string | number>) => `${key}${params ? JSON.stringify(params) : ""}`;

describe("moderation events", () => {
  it("describes flood and content alerts", () => {
    expect(alertText({ user: { display_name: "Bob" }, kind: "spam", deleted: 4 }, t)).toBe('automod.spam{"name":"Bob","count":4}');
    expect(alertText({ user: { display_name: "Bob" }, kind: "content", rule: "Slurs", scope: "room", matched: "bad", action: "delete" }, t)).toBe(
      'automod.content_alert{"name":"Bob","rule":"Slurs","matched":"bad","action":"automod.action.delete"}',
    );
    expect(alertText({ user: { display_name: "Bob" }, kind: "content", rule: "node", scope: "node", matched: "x", action: "block" }, t)).toContain('"rule":"automod.node_rule"');
  });

  it("links a report to the room's inbox or the admin inbox", () => {
    expect(reportPath({ id: "R", scope: "room", room_id: "ROOM" }, null)).toBe("/rooms/ROOM/settings/reports");
    expect(reportPath({ id: "R", scope: "room", room_id: "ROOM" }, "b.test")).toBe("/n/b.test/rooms/ROOM/settings/reports");
    expect(reportPath({ id: "R", scope: "node", room_id: "ROOM" }, null)).toBe("/admin/reports");
  });
});
