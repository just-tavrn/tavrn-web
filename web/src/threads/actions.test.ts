// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { TavrnApiError, type TavrnApi } from "@tavrn/sdk";
import { createPost, startThread } from "./actions";

// Titles of encrypted channels are sealed with the device's session manager (covered in the title tests); a title bound
// to its thread (signed context, ENCRYPTION.md §5.2) is told apart by the id.
vi.mock("./titles", () => ({
  sealTitle: async (_q: string, encrypted: boolean, title: string, _mls: unknown, threadId?: string) => (encrypted ? { title: threadId ? `SEALED-TITLE:${threadId}` : "SEALED-TITLE", title_epoch: 4 } : { title }),
}));

const ID = "01J9ZK3G5M8Q2W4E6R8T0Y2TH1";

function fakes(fail?: (body: Record<string, unknown>) => TavrnApiError | null) {
  const create = vi.fn(async (_room: string, channel: string, body: Record<string, unknown>) => {
    const err = fail?.(body);
    if (err) throw err;
    return { id: (body.id as string | undefined) ?? "NODEPICKED", channel_id: channel, room_id: "R", last_message_id: "M" };
  });
  const api = { threads: { create } } as unknown as TavrnApi;
  const mls = { encrypt: vi.fn(async () => ({ content: "CIPHERTEXT", epoch: 4 })), signPlaintext: vi.fn(() => "SIGNATURE") };
  return { api, mls, create };
}

const post = { domain: "n.test", roomId: "R", channelId: "C", encrypted: false, title: "Absturz", tags: ["T1"], body: "Die App stürzt ab." };

describe("createPost (PROTOCOL.md §7e, FEDERATION.md §10.3)", () => {
  it("picks the thread id and signs the first message with it where the node keeps client ids", async () => {
    const { api, mls, create } = fakes();
    const id = await createPost({ ...post, api, mls, clientIds: true, newId: () => ID });
    expect(id).toBe(ID);
    expect(mls.signPlaintext).toHaveBeenCalledWith("n.test/C", { reply_to: null, thread_id: ID, mentions_everyone: false, mentions: [], attachments: [] }, { type: "text", body: "Die App stürzt ab." });
    expect(create).toHaveBeenCalledWith("R", "C", { id: ID, title: "Absturz", tags: ["T1"], message: { content: { type: "text", body: "Die App stürzt ab." }, mentions: [], signature: "SIGNATURE" } });
  });

  it("stays unsigned on older nodes, without a device key, and when the node refuses the id", async () => {
    let f = fakes();
    await createPost({ ...post, api: f.api, mls: f.mls, clientIds: false, newId: () => ID });
    expect(f.mls.signPlaintext).not.toHaveBeenCalled();
    expect(f.create.mock.calls[0]![2]).toEqual({ title: "Absturz", tags: ["T1"], message: { content: { type: "text", body: "Die App stürzt ab." } } });
    f = fakes();
    await createPost({ ...post, api: f.api, mls: null, clientIds: true, newId: () => ID });
    expect(f.create.mock.calls[0]![2]).not.toHaveProperty("id");
    // A clock far off: the node refuses the id, the post goes out unsigned.
    f = fakes((b) => (b.id ? new TavrnApiError({ type: "x", title: "Bad Request", status: 400, code: "thread.id_invalid", detail: "" }) : null));
    expect(await createPost({ ...post, api: f.api, mls: f.mls, clientIds: true, newId: () => ID })).toBe("NODEPICKED");
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.create.mock.calls[1]![2]).toEqual({ title: "Absturz", tags: ["T1"], message: { content: { type: "text", body: "Die App stürzt ab." } } });
  });

  it("encrypts the first message in encrypted channels with the thread id in its signed context (ENCRYPTION.md §5.2)", async () => {
    const { api, mls, create } = fakes();
    await createPost({ ...post, encrypted: true, api, mls, clientIds: true, newId: () => ID });
    expect(mls.signPlaintext).not.toHaveBeenCalled();
    expect(mls.encrypt).toHaveBeenCalledWith("n.test/C", { type: "text", body: "Die App stürzt ab." }, { ctx: { thread_id: ID, reply_to: null } });
    // The title is bound to the thread id too.
    expect(create.mock.calls[0]![2]).toEqual({ id: ID, title: `SEALED-TITLE:${ID}`, title_epoch: 4, tags: ["T1"], message: { content: "CIPHERTEXT", epoch: 4 } });
  });

  it("encrypts without a context where the thread id is not the client's", async () => {
    let f = fakes();
    await createPost({ ...post, encrypted: true, api: f.api, mls: f.mls, clientIds: false, newId: () => ID });
    expect(f.mls.encrypt).toHaveBeenCalledWith("n.test/C", { type: "text", body: "Die App stürzt ab." });
    expect(f.create.mock.calls[0]![2]).toEqual({ title: "SEALED-TITLE", title_epoch: 4, tags: ["T1"], message: { content: "CIPHERTEXT", epoch: 4 } });
    f = fakes((b) => (b.id ? new TavrnApiError({ type: "x", title: "Bad Request", status: 400, code: "thread.id_invalid", detail: "" }) : null));
    expect(await createPost({ ...post, encrypted: true, api: f.api, mls: f.mls, clientIds: true, newId: () => ID })).toBe("NODEPICKED");
    expect(f.mls.encrypt).toHaveBeenLastCalledWith("n.test/C", { type: "text", body: "Die App stürzt ab." });
  });
});

describe("startThread: encrypted titles bound to their thread (ENCRYPTION.md §5.2)", () => {
  const base = { domain: "n.test", roomId: "R", channelId: "C", title: "Plan", rootMessageId: "M1" };
  const refused = (b: Record<string, unknown>) => (b.id ? new TavrnApiError({ type: "x", title: "Bad Request", status: 400, code: "thread.id_invalid", detail: "" }) : null);

  it("picks the thread id in encrypted channels where the node keeps client ids, and seals the title with it", async () => {
    const { api, create } = fakes();
    expect(await startThread({ ...base, api, encrypted: true, clientIds: true, newId: () => ID })).toBe(ID);
    expect(create).toHaveBeenCalledWith("R", "C", { id: ID, title: `SEALED-TITLE:${ID}`, title_epoch: 4, root_message_id: "M1" });
  });

  it("falls back to an unbound title when the node refuses the id or does not keep client ids", async () => {
    let f = fakes(refused);
    expect(await startThread({ ...base, api: f.api, encrypted: true, clientIds: true, newId: () => ID })).toBe("NODEPICKED");
    expect(f.create.mock.calls[1]![2]).toEqual({ title: "SEALED-TITLE", title_epoch: 4, root_message_id: "M1" });
    f = fakes();
    await startThread({ ...base, api: f.api, encrypted: true, clientIds: false, newId: () => ID });
    expect(f.create.mock.calls[0]![2]).toEqual({ title: "SEALED-TITLE", title_epoch: 4, root_message_id: "M1" });
    // Plaintext channels keep the node's ids (nothing to bind).
    f = fakes();
    await startThread({ ...base, api: f.api, encrypted: false, clientIds: true, newId: () => ID });
    expect(f.create.mock.calls[0]![2]).toEqual({ title: "Plan", root_message_id: "M1" });
  });
});
