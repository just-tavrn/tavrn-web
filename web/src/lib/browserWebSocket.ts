// SPDX-License-Identifier: Apache-2.0
/**
 * The browser's WebSocket for the sdk's realtime socket (`TavrnSocket` option `WebSocketImpl`). The sdk constructs its
 * implementation as `new Impl(url, undefined, { maxPayload })`, the options of the Node.js package `ws`. Chromium's
 * constructor does not ignore that third argument: it takes the object as the subprotocol list and throws
 * ("The subprotocol '[object Object]' is invalid"), so no realtime connection was ever made. This wrapper passes the
 * URL (and real subprotocols) only; the sdk still checks the frame size itself after a frame arrived.
 */
export function urlOnlyWebSocket(Base: typeof WebSocket): typeof WebSocket {
  return class extends Base {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (protocols === undefined) super(url);
      else super(url, protocols);
    }
  };
}

const wrapped = new WeakMap<typeof WebSocket, typeof WebSocket>();

/** The current global WebSocket (tests may replace it), constructed with the URL (and subprotocols) only. */
export function browserWebSocket(): typeof WebSocket {
  const Base = globalThis.WebSocket;
  let Ws = wrapped.get(Base);
  if (!Ws) {
    Ws = urlOnlyWebSocket(Base);
    wrapped.set(Base, Ws);
  }
  return Ws;
}
