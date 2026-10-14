// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { parsePoll } from "@tavrn/e2ee";
import { buildPoll, emptyDraft, hasErrors, slotCount, validateDraft, type PollDraft } from "./model";
import { offsetMinutes, parseRfc3339, toRfc3339, zonedInstant } from "./time";
import { slotText } from "./format";

const NOW = Date.parse("2026-10-14T10:00:00Z");

function choice(labels: string[], patch: Partial<PollDraft> = {}): PollDraft {
  const d = emptyDraft("choice");
  return { ...d, question: "Wohin?", options: labels.map((label, i) => ({ key: `k${i}`, label })), ...patch };
}

describe("poll drafts", () => {
  it("accepts a valid choice poll and builds the content of §7g", () => {
    const d = choice([" Küche ", "Garten"]);
    expect(validateDraft(d, NOW)).toEqual({});
    const { content, closesAt } = buildPoll(d, NOW);
    expect(content).toEqual({ type: "poll", kind: "choice", question: "Wohin?", options: [{ id: "o1", label: "Küche" }, { id: "o2", label: "Garten" }], max_choices: 1, results_visible: "always", votes_visible: "public" });
    expect(closesAt).toBeNull();
    const { type: _type, ...poll } = content;
    expect(parsePoll(content)).toEqual(poll);
  });

  it("names every problem of a choice poll", () => {
    const e = validateDraft(choice(["A", "", "a", "x".repeat(101)], { question: "  " }), NOW);
    expect(e.question).toBe("polls.error.question_empty");
    expect(e.option).toEqual({ k1: "polls.error.option_empty", k2: "polls.error.option_duplicate", k3: "polls.error.option_long" });
    expect(validateDraft(choice(["A"]), NOW).options).toBe("polls.error.options_few");
    expect(validateDraft(choice(Array.from({ length: 21 }, (_, i) => `O${i}`)), NOW).options).toBe("polls.error.options_many");
    expect(validateDraft(choice(["A", "B"], { question: "x".repeat(301) }), NOW).question).toBe("polls.error.question_long");
    expect(hasErrors(validateDraft(choice(["A", "B"]), NOW))).toBe(false);
  });

  it("multiple choice caps max_choices at the number of options", () => {
    expect(buildPoll(choice(["A", "B", "C"], { multiple: true, maxChoices: 2 }), NOW).content).toMatchObject({ max_choices: 2 });
    expect(buildPoll(choice(["A", "B"], { multiple: true, maxChoices: 9 }), NOW).content).toMatchObject({ max_choices: 2 });
  });

  it("close times: quick choices, a custom time, and the node's limits (a minute to a year)", () => {
    expect(buildPoll(choice(["A", "B"], { closes: "1h" }), NOW).closesAt).toBe("2026-10-14T11:00:00.000Z");
    expect(buildPoll(choice(["A", "B"], { closes: "1w" }), NOW).closesAt).toBe("2026-10-21T10:00:00.000Z");
    expect(validateDraft(choice(["A", "B"], { closes: "custom", closesCustom: "" }), NOW).closes).toBe("polls.error.close_invalid");
    const soon = new Date(NOW + 30_000);
    const local = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    expect(validateDraft(choice(["A", "B"], { closes: "custom", closesCustom: local(soon) }), NOW).closes).toBe("polls.error.close_soon");
    expect(validateDraft(choice(["A", "B"], { closes: "custom", closesCustom: local(new Date(NOW + 400 * 86_400_000)) }), NOW).closes).toBe("polls.error.close_far");
    expect(validateDraft(choice(["A", "B"], { closes: "custom", closesCustom: local(new Date(NOW + 2 * 86_400_000)) }), NOW).closes).toBeUndefined();
  });

  it("date polls: all-day and timed slots in the creator's zone, sorted, with RFC 3339 offsets", () => {
    const d: PollDraft = {
      ...emptyDraft("date"),
      question: "Teamessen",
      days: {
        "2026-11-07": { allDay: true, times: [] },
        "2026-11-06": { allDay: false, times: [{ key: "b", start: "19:00", end: "22:00" }, { key: "a", start: "12:00", end: "" }] },
      },
    };
    expect(validateDraft(d, NOW, "Europe/Berlin")).toEqual({});
    expect(slotCount(d.days)).toBe(3);
    const { content } = buildPoll(d, NOW, "Europe/Berlin");
    expect(content).toMatchObject({
      kind: "date",
      slots: [
        { id: "s1", start: "2026-11-06T12:00:00+01:00" },
        { id: "s2", start: "2026-11-06T19:00:00+01:00", end: "2026-11-06T22:00:00+01:00" },
        { id: "s3", start: "2026-11-07T00:00:00+01:00", all_day: true },
      ],
    });
    const { type: _type, ...poll } = content;
    expect(parsePoll(content)).toEqual(poll);
  });

  it("names every problem of a date poll", () => {
    const base = { ...emptyDraft("date"), question: "Wann?" };
    expect(validateDraft(base, NOW).slots).toBe("polls.error.slots_none");
    expect(validateDraft({ ...base, days: { "2026-11-01": { allDay: false, times: [] } } }, NOW).slots).toBe("polls.error.day_no_time");
    const bad = validateDraft(
      {
        ...base,
        days: {
          "2026-11-01": { allDay: false, times: [{ key: "t1", start: "10:00", end: "09:00" }, { key: "t2", start: "25:00", end: "" }, { key: "t3", start: "11:00", end: "" }, { key: "t4", start: "11:00", end: "" }] },
          "2026-10-14": { allDay: false, times: [{ key: "t5", start: "08:00", end: "" }] },
        },
      },
      NOW,
      "UTC",
    );
    expect(bad.time).toEqual({ t1: "polls.error.time_end_before", t2: "polls.error.time_invalid", t4: "polls.error.time_duplicate", t5: "polls.error.time_past" });
    const many = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`2026-12-${String((i % 28) + 1).padStart(2, "0")}-${i}`, { allDay: true, times: [] }]));
    expect(validateDraft({ ...base, days: many }, NOW).slots).toBe("polls.error.slots_many");
  });
});

describe("poll time zones", () => {
  it("converts wall times of a zone to instants and back, across daylight saving", () => {
    expect(new Date(zonedInstant("2026-10-24", "12:00", "Europe/Berlin")).toISOString()).toBe("2026-10-24T10:00:00.000Z");
    expect(new Date(zonedInstant("2026-10-26", "12:00", "Europe/Berlin")).toISOString()).toBe("2026-10-26T11:00:00.000Z");
    expect(toRfc3339(Date.parse("2026-10-26T11:00:00Z"), "Europe/Berlin")).toBe("2026-10-26T12:00:00+01:00");
    expect(toRfc3339(Date.parse("2026-10-26T11:00:00Z"), "America/New_York")).toBe("2026-10-26T07:00:00-04:00");
    expect(offsetMinutes(Date.parse("2026-07-01T00:00:00Z"), "Asia/Kolkata")).toBe(330);
    expect(parseRfc3339("2026-11-06T19:00:00+05:30")).toEqual({ date: "2026-11-06", hour: 19, minute: 0, offset: 330 });
  });

  it("shows slots in the viewer's zone with the creator's time when the offsets differ", () => {
    const slot = { id: "s1", start: "2026-11-06T19:00:00+01:00", end: "2026-11-06T22:00:00+01:00" };
    const berlin = slotText(slot, "de-DE", "Europe/Berlin");
    expect(berlin.time).toBe("19:00 – 22:00");
    expect(berlin.creator).toBeNull();
    const ny = slotText(slot, "en-US", "America/New_York");
    expect(ny.time).toBe("01:00 PM – 04:00 PM");
    expect(ny.creator).toBe("19:00 – 22:00 UTC+01:00");
    const tokyo = slotText(slot, "de-DE", "Asia/Tokyo");
    expect(tokyo.day).toBe("2026-11-07");
    expect(tokyo.time).toBe("03:00 – 06:00");
  });

  it("all-day slots keep the creator's date in every zone", () => {
    const slot = { id: "s2", start: "2026-11-07T00:00:00+01:00", all_day: true };
    for (const zone of ["America/Los_Angeles", "Pacific/Auckland", "Europe/Berlin"]) {
      const x = slotText(slot, "de-DE", zone);
      expect(x).toMatchObject({ day: "2026-11-07", allDay: true, time: "", creator: null });
      expect(x.date).toBe("Sa., 7. Nov.");
    }
  });
});
