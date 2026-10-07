// SPDX-License-Identifier: Apache-2.0
/**
 * Messages the node deleted right after accepting them (auto-moderation `delete` and `timeout`, MODERATION.md §2.2):
 * the `message.delete` event can arrive before the answer to the send, so the sender's view must not add the
 * message afterwards. A bounded memory of recently deleted ids.
 */
const MAX = 500;
const recent = new Set<string>();
const order: string[] = [];

export function rememberDeleted(id: string) {
  if (recent.has(id)) return;
  recent.add(id);
  order.push(id);
  if (order.length > MAX) recent.delete(order.shift()!);
}

export function wasDeleted(id: string): boolean {
  return recent.has(id);
}
