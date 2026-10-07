// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { activityEnd, botOfApplication } from "./display";

const ID = "01J9Z8Y7X6W5V4T3S2R1Q0P9N8";
const user = (o: Partial<{ kind: string; domain: string; application_id: string | null; username: string }>) => ({ kind: "user", domain: "a.example", application_id: null, username: "x", ...o });

describe("botOfApplication", () => {
  it("finds a local bot by domain and id", () => {
    const bot = user({ kind: "bot", domain: "games.example", application_id: ID, username: "miner" });
    expect(botOfApplication(`games.example/${ID}`, [user({}), bot])).toBe(bot);
  });

  it("finds a remote bot by its full reference", () => {
    const bot = user({ kind: "bot", domain: "games.example", application_id: `games.example/${ID}` });
    expect(botOfApplication(`games.example/${ID}`, [bot])).toBe(bot);
  });

  it("ignores case differences", () => {
    const bot = user({ kind: "bot", domain: "Games.Example", application_id: ID.toLowerCase() });
    expect(botOfApplication(`games.example/${ID}`, [bot])).toBe(bot);
  });

  it("never matches people, other domains or other ids", () => {
    expect(botOfApplication(`games.example/${ID}`, [user({ kind: "user", domain: "games.example", application_id: ID })])).toBeNull();
    expect(botOfApplication(`games.example/${ID}`, [user({ kind: "bot", domain: "other.example", application_id: ID })])).toBeNull();
    expect(botOfApplication(`games.example/${ID}`, [user({ kind: "bot", domain: "games.example", application_id: "01J9Z8Y7X6W5V4T3S2R1Q0P9N9" })])).toBeNull();
    expect(botOfApplication(`games.example/${ID}`, [user({ kind: "bot", domain: "games.example", application_id: null })])).toBeNull();
    expect(botOfApplication(null, [user({ kind: "bot", domain: "games.example", application_id: ID })])).toBeNull();
    expect(botOfApplication(`games.example/${ID}`, [])).toBeNull();
  });
});

describe("activityEnd", () => {
  it("only returns a future end", () => {
    const now = Date.parse("2026-10-06T12:00:00Z");
    expect(activityEnd({ ends_at: "2026-10-06T12:30:00Z" }, now)?.toISOString()).toBe("2026-10-06T12:30:00.000Z");
    expect(activityEnd({ ends_at: "2026-10-06T11:30:00Z" }, now)).toBeNull();
    expect(activityEnd({ ends_at: null }, now)).toBeNull();
    expect(activityEnd({ ends_at: "garbage" }, now)).toBeNull();
    expect(activityEnd(null, now)).toBeNull();
  });
});
