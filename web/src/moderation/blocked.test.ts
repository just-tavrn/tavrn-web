// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { TavrnApiError } from "@tavrn/sdk";
import { blockedRule, blockedText, isAutomodBlock } from "./blocked";

const problem = (code: string, meta?: unknown) => new TavrnApiError({ type: "x", title: "Forbidden", status: 403, detail: "d", code, ...(meta ? { meta } : {}) } as never);
const t = (key: string, params?: Record<string, string | number>) => `${key}${params ? JSON.stringify(params) : ""}`;

describe("auto-moderation blocks in the composer", () => {
  it("recognizes the error and names the rule", () => {
    const e = problem("automod.blocked", { rule: "Slurs", scope: "room" });
    expect(isAutomodBlock(e)).toBe(true);
    expect(isAutomodBlock(problem("message.send_forbidden"))).toBe(false);
    expect(isAutomodBlock(new Error("x"))).toBe(false);
    expect(blockedRule(e)).toEqual({ rule: "Slurs", node: false });
    expect(blockedText(e, t)).toBe('automod.blocked_rule{"rule":"Slurs"}');
  });

  it("names the node's own filter without a rule name", () => {
    expect(blockedText(problem("automod.blocked", { rule: "node", scope: "node" }), t)).toBe("automod.blocked_node");
    expect(blockedText(problem("automod.blocked"), t)).toBe("automod.blocked_node");
  });
});
