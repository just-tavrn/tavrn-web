// SPDX-License-Identifier: Apache-2.0
/**
 * The language of the node's mails (tavrn-protocol PROTOCOL.md §6, `locale` of `PATCH /users/me`): the home node
 * writes confirmation, password, account, legal and app token mails in the account's stored language. The client
 * sends its own language whenever the node has another one (at start and when the user switches the language).
 */
import type { UpdateMeRequest } from "@tavrn/sdk";

interface UsersApi {
  users: { updateMe: (req: UpdateMeRequest) => Promise<unknown> };
}

/** Sends `locale` when the node's `stored` value differs; true when it sent it. */
export async function syncMailLocale(api: UsersApi, stored: string | null | undefined, locale: string): Promise<boolean> {
  if ((stored ?? "") === locale) return false;
  await api.users.updateMe({ locale });
  return true;
}
