// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";
import { LocalParticipant } from "livekit-client";

it("keeps targeted data routing outside the payload before E2EE replaces it", async () => {
  const sendDataPacket = vi.fn(async (packet: { destinationIdentities: string[]; value: { value: { destinationIdentities: string[] } } }) => {
    expect(packet.destinationIdentities).toEqual(["b@n/device"]);
    expect(packet.value.value.destinationIdentities).toEqual(["b@n/device"]);
  });
  const participant = { identity: "a@n/device", engine: { sendDataPacket } } as unknown as LocalParticipant;
  await LocalParticipant.prototype.publishData.call(participant, new Uint8Array([1]), { reliable: true, topic: "tavrn.whisper", destinationIdentities: ["b@n/device"] });
  expect(sendDataPacket).toHaveBeenCalledOnce();
});

it("preserves ordinary broadcast behavior when no destinations are requested", async () => {
  const sendDataPacket = vi.fn(async (packet: { destinationIdentities: string[] }) => expect(packet.destinationIdentities).toEqual([]));
  const participant = { identity: "a@n/device", engine: { sendDataPacket } } as unknown as LocalParticipant;
  await LocalParticipant.prototype.publishData.call(participant, new Uint8Array([1]), { reliable: true });
  expect(sendDataPacket).toHaveBeenCalledOnce();
});
