// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { syncMailLocale } from "./mailLocale";

describe("syncMailLocale (PROTOCOL.md §6, the language of the node's mails)", () => {
  it("sends the client's language only when the node has another one", async () => {
    const updateMe = vi.fn(async () => ({}));
    const api = { users: { updateMe } };
    expect(await syncMailLocale(api, "de", "de")).toBe(false);
    expect(updateMe).not.toHaveBeenCalled();
    expect(await syncMailLocale(api, "de-de", "de")).toBe(true);
    expect(await syncMailLocale(api, null, "en")).toBe(true);
    expect(await syncMailLocale(api, undefined, "de")).toBe(true);
    expect(updateMe.mock.calls).toEqual([[{ locale: "de" }], [{ locale: "en" }], [{ locale: "de" }]]);
  });
});
