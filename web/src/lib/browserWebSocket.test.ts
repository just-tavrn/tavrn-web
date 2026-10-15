// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { TavrnSocket } from "@tavrn/sdk";
import { urlOnlyWebSocket } from "./browserWebSocket";

/** A WebSocket that records its constructor arguments and, like Chromium, rejects a non-string third argument's slot. */
function recordingBase() {
  const calls: unknown[][] = [];
  class Base {
    readyState = 0;
    onopen: unknown = null;
    onmessage: unknown = null;
    onclose: unknown = null;
    onerror: unknown = null;
    constructor(...args: unknown[]) {
      calls.push(args);
      // Chromium takes an object among the arguments as the subprotocol list and throws.
      if (args.some((a) => typeof a === "object" && a !== null && !Array.isArray(a))) throw new SyntaxError("The subprotocol '[object Object]' is invalid.");
    }
    send() {}
    close() {}
  }
  return { Base: Base as unknown as typeof WebSocket, calls };
}

describe("the browser's WebSocket for the realtime socket", () => {
  it("is constructed with the URL only, whatever options the sdk passes", () => {
    const { Base, calls } = recordingBase();
    const Ws = urlOnlyWebSocket(Base) as unknown as new (...a: unknown[]) => unknown;
    expect(() => new Ws("wss://n.example/api/v1/ws", undefined, { maxPayload: 1024 })).not.toThrow();
    expect(calls.at(-1)).toEqual(["wss://n.example/api/v1/ws"]);
    new Ws("wss://n.example/api/v1/ws", ["v1"]);
    expect(calls.at(-1)).toEqual(["wss://n.example/api/v1/ws", ["v1"]]);
  });

  it("lets the sdk's socket open its connection (it passes ws options as the third argument)", async () => {
    const statuses: string[] = [];
    // The browser's own constructor: the sdk's attempt throws and is retried, never opened.
    const raw = recordingBase();
    const failing = new TavrnSocket({ url: "wss://n.example/api/v1/ws", getToken: () => "t", WebSocketImpl: raw.Base, onStatus: (s) => statuses.push(s) });
    failing.connect();
    await vi.waitFor(() => expect(raw.calls).toHaveLength(1));
    expect(raw.calls[0]![2]).toEqual({ maxPayload: expect.any(Number) });
    failing.close();
    // Wrapped: one connection, made with the URL only.
    const wrapped = recordingBase();
    const socket = new TavrnSocket({ url: "wss://n.example/api/v1/ws", getToken: () => "t", WebSocketImpl: urlOnlyWebSocket(wrapped.Base) });
    socket.connect();
    await vi.waitFor(() => expect(wrapped.calls).toEqual([["wss://n.example/api/v1/ws"]]));
    socket.close();
  });
});
