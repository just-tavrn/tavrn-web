# LiveKit client data routing

`livekit-client@2.22.4.patch` retains `destinationIdentities` on the outer `DataPacket` in
`LocalParticipant.publishData`. With E2EE, the SDK replaces the inner user packet with encrypted bytes;
putting the routing addresses only inside that packet causes the SFU to broadcast it. The patch preserves
the encrypted payload and allows the SFU to route to the intended devices.

The patch covers the source and ESM entry used by the Vite web/desktop bundle. This application does not
load the dependency's UMD/CommonJS distribution. The version is pinned and pnpm records the patch hash.
`whisperTransport.test.ts` checks the actual ESM publication method, and `voice-whisper.spec.ts` proves
that a third participant receives neither the targeted signals nor audio, even after requesting the track.
Remove the patch only after an upstream fix passes both regressions; 2.23.0 still has the same source bug.
