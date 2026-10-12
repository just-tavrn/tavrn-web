# Whiteboard (`web/src/whiteboard/`)

The shared whiteboard of a conversation (design note 4.10, normative protocol: `tavrn-protocol/WHITEBOARD.md`). It works in
every conversation: voice and text channels, DMs and group DMs. Nothing in here knows about voice.

| File | Role |
|---|---|
| `sync.ts` | Pure helpers: element diffs (`version`/`versionNonce`), reconciliation, validation of untrusted payloads, permissions, throttle, send budget, chunking. |
| `protocol.ts` | Event types and timings. |
| `controller.ts` | `WhiteboardController`: one board on this device (owner authority, proposals, snapshots, files, cursors, thumbnails, keepalive). Network and canvas are injected. |
| `store.ts` | One controller per conversation, shared by all views; socket wiring (`ephemeral`, `whiteboard.session`), encryption, local draft. **Integration hook** `useWhiteboardSession`. |
| `drafts.ts` | The owner's unsaved board per conversation in the local encrypted store, under a keyed record name (`whiteboard-draft:<HMAC>`) that does not reveal the conversation. |
| `scenes.ts` | Scene library: serialization, encryption under the backup key (`encryptScene`), API. |
| `share.ts` | "Share to channel": PNG as an (encrypted) attachment. |
| `excalidraw.ts` | Lazy loading of Excalidraw (fonts from the node), PNG/SVG export, thumbnails. |
| `mermaid-stub.ts` | Stands in for `@excalidraw/mermaid-to-excalidraw` (aliased in `vite.config.ts`): no text-to-diagram, pasted Mermaid code stays plain text, and the bundle stays without Mermaid. |
| `WhiteboardCanvas.tsx` | The Excalidraw canvas (the lazy chunk). |
| `WhiteboardSession.tsx` | The board UI: open/join/leave/close, permissions, scenes, background, export, share. |
| `WhiteboardBadge.tsx` | `WhiteboardBadge`, `WhiteboardThumbnail`, `WhiteboardButton` (header link to the board). |
| `WhiteboardPage.tsx` | Routes `…/channels/<id>/whiteboard`, `…/conversations/<id>/whiteboard` (full screen; also the "maximize" target). |

## On the voice stage

`WhiteboardStage.tsx` (with the lazy `WhiteboardStageTile.tsx`) and `stage.ts` plug into `web/src/voice/ui/*` with
small additive edits. The board is a stage tile of its own, joined like a screen share (docs/CLIENT.md "Streams are
joined"); the participants' camera tiles are never touched. `useStageBoard()` says which tile it is
(`boardTileState()`: `available`, `joined`, `preview`, `hidden`, `none`). `VoiceStage` puts `WhiteboardPlaceholder`
("Whiteboard · <name>", badge, thumbnail, Join whiteboard, double-click) into the grid before joining and
`WhiteboardLargeTile` (focus, maximize, popout = the full-screen route in a new window, fullscreen with the phone's
landscape lock for a board wider than tall, Leave whiteboard or the owner's Hide preview) into the large area once
joined, next to a focused stream; `WhiteboardIndicator` is the owner's "Whiteboard is open" bar (preview toggle,
joined count, Close). The owner's preview state is `useBoardPreview` (shown again by `openBoard()`).
`VoiceControls` gets `WhiteboardControl` and calls `beforeScreenShare()` before the screen share dialog;
`VoiceChannelRow` shows `WhiteboardRowBadge` on the presenter (`presenterIdentity()`) and joins the board on a
double-click or Enter (`rowBoardAction()`). `openBoard()` / `beforeBoard()` stop a running screen share first. Both
ask before ending the other presentation.

## Integration surface

Use inside the node scope of the conversation (`useNode()` must name the hosting node, as everywhere else):

```tsx
import { useWhiteboardSession } from "../whiteboard/store";
import { WhiteboardThumbnail, WhiteboardBadge } from "../whiteboard/WhiteboardBadge";

const { session, isOwner, role, joined, ended, join, leave, thumbnailUrl, controller } = useWhiteboardSession(channelId);
// Plaintext text channels need { encrypted: false }; voice channels and DMs are always encrypted (the default).
```

- `session`: `{ conversation_id, owner, owner_id, device_id, open_for_all, grants, started_at }` or `null`. The
  presenter is the participant whose address is `session.owner` (and whose device is `session.device_id`); one user
  presents either a screen share or a board.
- `isOwner`: this device presents the board. `role`: `"owner" | "editor" | "viewer" | null`.
- `joined` / `join()` / `leave()`: "Join whiteboard" / "Leave whiteboard" on the stage tile. Joining only marks the
  device as joined and asks the owner for a snapshot; render the board with `<WhiteboardSession>` (or navigate
  to the full-screen route: `${channelPath}/whiteboard`).
- `thumbnailUrl`: a small `data:image/webp` of the board, refreshed by the owner at most every 5 s after changes;
  available **before** joining (render `<WhiteboardThumbnail conversationId=… />` on a placeholder and
  `<WhiteboardBadge conversationId=… />` as the small badge).
- `ended`: the board was closed while this device had joined.
- The hook must run where the conversation's MLS group is joined on this device (the voice view does that for the
  channel; the full-screen page uses `useE2eeConversation`), otherwise events cannot be decrypted.

`<WhiteboardSession layout="embedded" …>` fills its parent instead of the screen (a tile); it leaves the session
for viewers when it unmounts. A board keeps running on the owner's device while no view shows it (it answers late joiners) until it is closed;
viewers leave the session when their last view unmounts.
