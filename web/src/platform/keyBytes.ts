// SPDX-License-Identifier: Apache-2.0
/**
 * Frame keys cross the local IPC bridges to the shells as arrays of numbers (the shells check them). The array is a
 * copy the client would otherwise leave to the garbage collector: it is wiped once the call is done, as the client
 * wipes its own key buffers (defence in depth: the bytes stay in memory no longer than needed).
 */
export async function withKeyNumbers<T>(key: Uint8Array, send: (numbers: number[]) => Promise<T>): Promise<T> {
  const numbers = Array.from(key);
  try {
    return await send(numbers);
  } finally {
    numbers.fill(0);
  }
}
