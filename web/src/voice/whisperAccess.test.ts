// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { Permission, type RoomDetail, TavrnApi } from "@tavrn/sdk";
import { WHISPER, whisperAllowed, verifiedWhisperReceipt, startWhisper, receiveWhisper, endWhisper } from "./whisperAccess";
const room = (permissions: bigint) => ({ channels: [{ id: "c", kind: "voice", category_id: "cat" }], roles: [{ id: "all", is_everyone: true, permissions: (permissions | Permission.VIEW_CHANNEL).toString() }], my_roles: [], overrides: [], is_owner: false } as unknown as RoomDetail);
describe("whisper initiation authorization", () => {
  it("requires the dedicated bit and speaking, and honors category and channel denies", () => {
    expect(whisperAllowed(undefined, "c", "me")).toBe(false);
    expect(whisperAllowed(room(Permission.SPEAK), "c", "me")).toBe(false);
    expect(whisperAllowed(room(WHISPER), "c", "me")).toBe(false);
    expect(whisperAllowed(room(Permission.SPEAK | Permission.PRIORITY_SPEAKER), "c", "me")).toBe(false);
    const r = room(Permission.SPEAK | WHISPER);
    expect(whisperAllowed(r, "c", "me")).toBe(true);
    r.overrides = [{ target_type: "category", target_id: "cat", subject_type: "role", subject_id: "all", allow: "0", deny: WHISPER.toString() }] as RoomDetail["overrides"];
    expect(whisperAllowed(r, "c", "me")).toBe(false);
    r.overrides.push({ target_type: "channel", target_id: "c", subject_type: "member", subject_id: "me", allow: WHISPER.toString(), deny: "0" } as RoomDetail["overrides"][number]);
    expect(whisperAllowed(r, "c", "me")).toBe(true);
    expect(whisperAllowed(r, "unknown", "me")).toBe(false);
  });
  it("sends reply session IDs without arbitrary recipients using the authenticated SDK transport", async () => {
    const api = new TavrnApi();
    const start = vi.spyOn(api.voice, "startWhisper").mockResolvedValue({} as never);
    const receive = vi.spyOn(api.voice, "receiveWhisper").mockResolvedValue({} as never);
    const end = vi.spyOn(api.voice, "endWhisper").mockResolvedValue(undefined);
    const target = { domain: "n", roomId: "r", channelId: "c" };
    await startWhisper(api, target, { reply_to: "last" });
    expect(start).toHaveBeenLastCalledWith("r", "c", { reply_to: "last" });
    await receiveWhisper(api, target, "session");
    expect(receive).toHaveBeenLastCalledWith("r", "c", "session");
    await endWhisper(api, target, "session");
    expect(end).toHaveBeenLastCalledWith("r", "c", "session");
  });
});
describe("server-confirmed whisper reception", () => {
  const receipt = { id: "session", sender: "alice@n/d", expires_at: new Date(31_000).toISOString(), reply_expires_at: new Date(121_000).toISOString() };
  it("accepts only the server-confirmed matching publication and sender", async () => {
    const request = vi.fn(async () => receipt);
    const verify = (name: string, sender = receipt.sender) => verifiedWhisperReceipt(name, sender, request, () => true, () => 1000);
    expect(await verify("whisper")).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(await verify("whisper:session")).toEqual(receipt);
    expect(await verify("whisper:other")).toBeNull();
    expect(await verify("whisper:session", "forged@n/d")).toBeNull();
    request.mockRejectedValueOnce(new Error("denied"));
    expect(await verify("whisper:session")).toBeNull();
  });
  it("keeps connection-bound playback and reply available beyond a short initial window", async () => {
    const longReceipt = { ...receipt, expires_at: new Date(3_600_000).toISOString(), reply_expires_at: new Date(3_600_000).toISOString() };
    expect(await verifiedWhisperReceipt("whisper:session", receipt.sender, async () => longReceipt, () => true, () => 180_000)).toEqual(longReceipt);
  });
  it("rejects delayed responses after deafen, unpublish or reconnect and expired receipts", async () => {
    let current = true; let resolve!: (value: typeof receipt) => void;
    const pending = verifiedWhisperReceipt("whisper:session", receipt.sender, () => new Promise((r) => { resolve = r; }), () => current, () => 1000);
    current = false; resolve(receipt);
    expect(await pending).toBeNull();
    expect(await verifiedWhisperReceipt("whisper:session", receipt.sender, async () => receipt, () => true, () => 31_000)).toBeNull();
  });
});
