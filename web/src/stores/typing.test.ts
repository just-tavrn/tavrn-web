// SPDX-License-Identifier: Apache-2.0
// The typing indicator's cleanup tick (every 2 s) changes the state only when an entry expired: views subscribed to
// a channel's entry do not re-render while someone keeps typing.
import { beforeEach, describe, expect, it } from "vitest";
import { useTyping } from "./typing";

describe("typing store", () => {
  beforeEach(() => useTyping.setState({ byChannel: {} }));

  it("keeps the same objects when nothing expired", () => {
    useTyping.getState().mark("c1", "u1");
    useTyping.getState().mark("c2", "u2");
    const before = useTyping.getState();
    const c1 = before.byChannel.c1;
    let notified = 0;
    const off = useTyping.subscribe(() => notified++);
    useTyping.getState().prune(Date.now());
    off();
    expect(notified).toBe(0);
    expect(useTyping.getState().byChannel).toBe(before.byChannel);
    expect(useTyping.getState().byChannel.c1).toBe(c1);
  });

  it("drops expired entries and keeps the objects of channels without one", () => {
    useTyping.setState({ byChannel: { c1: { u1: 100, u2: 5000 }, c2: { u3: 5000 }, c3: { u4: 100 } } });
    const c2 = useTyping.getState().byChannel.c2;
    useTyping.getState().prune(1000);
    const { byChannel } = useTyping.getState();
    expect(byChannel).toEqual({ c1: { u2: 5000 }, c2: { u3: 5000 } });
    expect(byChannel.c2).toBe(c2);
  });
});
