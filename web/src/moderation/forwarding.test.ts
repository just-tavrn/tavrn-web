// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { forwardTarget, homeNodeOf } from "./forwarding";

const report = { source: "user", kind: "message", target_address: "mallory@b.example", forwarded: null };

describe("forwarding reports (MODERATION.md §1.6)", () => {
  it("finds the home node of an address", () => {
    expect(homeNodeOf("mallory@B.example")).toBe("b.example");
    expect(homeNodeOf("nobody")).toBeNull();
    expect(homeNodeOf("@b.example")).toBeNull();
    expect(homeNodeOf("x@")).toBeNull();
  });

  it("offers forwarding only for user reports about users of other nodes, once", () => {
    expect(forwardTarget(report, "a.example")).toBe("b.example");
    expect(forwardTarget({ ...report, kind: "user" }, "a.example")).toBe("b.example");
    expect(forwardTarget(report, "B.example"), "a local user").toBeNull();
    expect(forwardTarget({ ...report, kind: "room", target_address: "" }, "a.example")).toBeNull();
    expect(forwardTarget({ ...report, source: "automod" }, "a.example")).toBeNull();
    expect(forwardTarget({ ...report, source: "forward" }, "a.example"), "forwarded in").toBeNull();
    expect(forwardTarget({ ...report, forwarded: { node: "b.example", at: "2026-10-12T10:00:00Z", by: "admin@a.example" } }, "a.example")).toBeNull();
  });
});
