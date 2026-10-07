// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { INTERACTION_LIFETIME_MS, useInteractions } from "./interactions";

const application = { ref: "t.local/A", name: "WeatherBot", bot: "weather@t.local" };

describe("interaction notices (APPLICATIONS.md §5.7)", () => {
  beforeEach(() => useInteractions.setState({ notices: [] }));

  it("shows thinking until an answer arrives, keeps ephemeral replies and errors until dismissed", () => {
    const s = useInteractions.getState();
    s.add({ key: "i1:thinking", interactionId: "i1", conversationId: "c", kind: "thinking", application });
    s.add({ key: "i1:thinking", interactionId: "i1", conversationId: "c", kind: "thinking", application });
    expect(useInteractions.getState().notices).toHaveLength(1);
    s.add({ interactionId: "i1", conversationId: "c", kind: "ephemeral", application, content: { type: "text", body: "done" } });
    expect(useInteractions.getState().notices.map((n) => n.kind)).toEqual(["ephemeral"]);
    s.add({ key: "i2:thinking", interactionId: "i2", conversationId: "c", kind: "thinking", application });
    s.resolve("i2");
    s.add({ interactionId: "i3", conversationId: "c", kind: "error", application, text: "City not found" });
    expect(useInteractions.getState().notices.map((n) => n.kind)).toEqual(["ephemeral", "error"]);
    s.dismiss(useInteractions.getState().notices[0]!.key);
    expect(useInteractions.getState().notices.map((n) => n.kind)).toEqual(["error"]);
  });

  it("forgets thinking after the interaction's lifetime and bounds the list", () => {
    const s = useInteractions.getState();
    s.add({ key: "t", interactionId: "t", conversationId: "c", kind: "thinking", application });
    s.prune(Date.now() + INTERACTION_LIFETIME_MS + 1);
    expect(useInteractions.getState().notices).toHaveLength(0);
    for (let i = 0; i < 25; i++) s.add({ interactionId: `e${i}`, conversationId: "c", kind: "error", application, text: String(i) });
    const left = useInteractions.getState().notices;
    expect(left).toHaveLength(20);
    expect(left[0]!.text).toBe("5");
  });
});
