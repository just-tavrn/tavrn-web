# The web client

What the web client does, screen by screen: accounts and encryption, several nodes in one client, voice and video,
context menus, notifications and media, translations. The protocol behind each part is specified in
[tavrn-protocol](https://github.com/just-tavrn/tavrn-protocol); the client's accessibility is documented in
[ACCESSIBILITY.md](ACCESSIBILITY.md).

## Accounts in the web client

Every password account has a second factor: registration is a short wizard (account → authenticator app
via QR code or a passkey → ten recovery codes shown once → recovery key), and sign-in asks for the TOTP
code, a recovery code or a passkey; "Sign in with a passkey" skips the password. The **recovery key**
(24 words or a compact string, generated in the browser and never sent anywhere) unlocks the encrypted
messages on a new device or browser; passkeys with the PRF extension can do the same. Local keys live in
IndexedDB, encrypted under a device key derived from the master secret; the security settings manage
factors, recovery codes, the recovery key and the optional "require the recovery key every time" lock.
Without the recovery key the client offers a degraded mode (plaintext channels only, encrypted
conversations stay locked) or an identity reset (old encrypted history is lost). Details:
[PROTOCOL.md](https://github.com/just-tavrn/tavrn-protocol/blob/main/PROTOCOL.md) §5a, [ENCRYPTION.md](https://github.com/just-tavrn/tavrn-protocol/blob/main/ENCRYPTION.md) §2.4.

## Several nodes in one client

The web client is a client of several nodes at once. Rooms of other nodes appear in the room rail under
their domain (`/n/<domain>/rooms/…`); the client opens a federated session there with a token of the home
node, renews it on its own and keeps one WebSocket per node. The conversation index on the home node lists
every room and conversation on any node, so a new device brings them all back after signing in. The login
page offers "Sign in with an account of another node": with the address `alice@home.example` the client
finds the home node and signs in there directly (password and TOTP or a recovery code) or through the
home node's own web client (the connect flow with PKCE, needed for passkeys and captchas); on that origin
the recovery key unlocks the encrypted messages. Encryption works across nodes: the MLS group of a
conversation lives on the node that hosts it, while every user's keys are checked against that user's own
home node. Friends and DMs work by full address (`bob@other.example`); a DM lives on the home node of the
person who starts it and shows its node's domain in the DM list; DMs started by a friend on another node
appear by themselves, room invitations by address wait in the invite list on the home view. A node that is
down only marks its own rooms and conversations as unreachable; a node that refuses to renew the session
asks to sign in there again. Details: [FEDERATION.md](https://github.com/just-tavrn/tavrn-protocol/blob/main/FEDERATION.md) §4, §6, §8 and §13.2.

"Discover" (the compass in the room rail) lists the public rooms and nodes the client's node knows from the
peer directory. Every room card shows the domain of the node that hosts it; the client checks the listing
each hosting node signed for its room and hides entries that do not verify. Joining a room of another node
opens a federated session there. Room owners list a public room under room settings → overview → "Listed
in the directory".

## Voice channels in the web client

Clicking a voice channel joins it (the channel list shows who is in which channel, also outside the call,
with mute, deafen, camera and screen icons and the user limit as `3/5`). While connected, the voice channel
shows the stage: one tile per participant with avatar or camera, a glowing border and level meter while
someone speaks, screen shares as large tiles (enlarge, picture-in-picture); phones get a swipeable grid of
four and a bottom control bar. The voice bar at the bottom of the sidebar keeps mute, deafen, leave and the
connection quality at hand while you read text channels. Moderators open a participant's menu (right click
or ⋯) to server-mute, disconnect or move them, drag people onto another voice channel, or move everybody at
once from a voice channel's menu (with a confirmation; the target's user limit holds); everybody can set a
per-person volume there. A dropped connection rejoins by itself; others see an amber plug on your avatar
meanwhile instead of you vanishing.

**Calls in DMs and group DMs:** the call button in the conversation header rings the others (a banner with a
soft synthesized ringtone on all their devices, also across nodes); accepting opens the call view with the same
tiles and controls as voice channels, end-to-end encrypted with the conversation's keys. Nobody answering within
45 seconds or a declined DM call leaves a "missed call" entry, a finished call one with its duration.

Media is end-to-end encrypted with keys from the channel's MLS group: the client never publishes before
LiveKit confirmed encryption and refuses to join in browsers without insertable streams. **Settings →
Voice & video** (kept per device, applied live): microphone and speaker with a level meter, a five-second
test recording and a test tone, input/output volume, automatic gain, echo cancellation, noise suppression
(off, the browser's, or RNNoise running locally as a WASM audio worklet), a noise gate, voice activation
with a live "transmitting" light or push-to-talk (key and release delay), camera with preview, resolution and
frame rate within the node's limits, mirroring and background blur (strength slider, quality fast/balanced/high
with mask smoothing) or an image (MediaPipe served by the node, turned off automatically on machines that cannot
keep up, with the measured numbers), soft notification sounds (join, leave, mute, deafen, streams, connection;
volume and a switch per sound), the ringtone volume, and a **connection test** that tries every path to the
node's media server (UDP per address, TCP, TURN) and says what to fix when one fails. Room owners upload soundboard clips under room
settings → Soundboard; members with `use_soundboard` play them from the call controls into their own
(encrypted) microphone track. LiveKit, RNNoise and the background effects are only loaded once voice is used.

## Encrypted conversations

Each channel, DM and group DM is an MLS group ([`@tavrn/e2ee`](https://github.com/just-tavrn/tavrn-js/tree/main/e2ee), `src/mls.ts`): the first device that opens a
conversation creates it, further devices join by external commit, DM and group members' devices are added
with a Welcome. Message content and attachments are encrypted and signed in the browser, the node only
stores ciphertext. Every device the client meets is checked against the user's identity key (pinned on
first use); a changed key shows "security key changed", and a device in a conversation that is not a
member or not confirmed by its user's key shows a warning and blocks sending until acknowledged. Content
keys are backed up encrypted on the home node so that a new device unlocked with the recovery key reads
the history. Friends (requests, accept, block) live under "Friends" on the home view.

## Threads, forum and announcement channels

Threads ([PROTOCOL.md §7e](https://github.com/just-tavrn/tavrn-protocol/blob/main/PROTOCOL.md)) are
sub-conversations of a text or announcement channel. **Create thread** in a message's menu asks for a title
(prefilled from the message), **Reply in thread** opens the message's thread or starts one with that title. A
message that started a thread shows "N replies · last reply …" with the most recent writers' avatars; a click
opens the thread. The 🧵 button in the channel header lists the active and archived threads with unread counts
and starts standalone threads. A thread opens in a panel next to the channel on tablets and desktops (drag its
edge, or use the arrow keys on it, to resize; the width is remembered on this device) and full screen with a back
button on phones; Esc closes it, and every thread has its own link (`…/channels/<channel>/threads/<thread>`). The
panel is the channel's conversation in thread mode: encryption, reactions, uploads, mentions, `/me` and the other
slash commands work there as in the channel, and in encrypted channels the title is encrypted with the channel's
messages. Its header follows or unfollows the thread and, for its creator or members with *Manage threads*,
renames, archives, locks or deletes it. Starting or writing in a thread follows it; only followed threads count
towards the channel's unread badge and raise notifications (direct mentions always do).

Forum channels show posts instead of messages: cards with title, tags, author, replies, last activity and the
start of the first message, tag filter chips, "Latest activity" or "Newest posts", archived posts on demand and
**New post** (title, message, up to five tags). Their tags and the auto-archive time of every channel's threads
are set in the room settings under *Channels* (*Manage channels*). In announcement channels only members with
*Manage messages* post; the others see a notice instead of the composer and react or reply in threads.

## Context menus, notifications and media

Members, messages, channels, rooms in the rail and DMs have context menus: right-click (or the keyboard's
context-menu key / Shift+F10), the ⋯ button, or a long press on phones. Members: profile, message, add friend,
mention, copy address, and with the matching permission kick, ban (with a reason), timeout, roles (checkboxes),
server mute, disconnect and "move to"; in your call a volume slider (0–200 %). Moderation items against someone
whose highest role is not below yours stay greyed out with the reason. Messages: reply, react, copy text, link or
id, create thread, reply in thread, pin, edit, delete, mark unread, report. Channels and rooms: mark as read, notification level (all / mentions only /
nothing), mute for 1 h, 8 h, 24 h or until turned back on, edit/duplicate/delete with `manage_channels`, "move
everyone here" on voice channels. DMs: close (until a new message arrives), mute, block. Logging out is the last
item of the status menu on your avatar (with a confirmation).

Notifications: mentions (`@name`, `@name@domain`, `@Role` of mentionable roles, `@everyone`) and DMs show a
toast with a jump link, a soft sound and an entry behind the bell 🔔 next to the settings gear; with
**Settings → Notifications → Desktop notifications** the browser shows them while tavrn is in the background
(the permission is asked only after that click; encrypted messages never appear in the notification text).
The settings are stored on the home node and fall back to this browser on nodes that do not offer them yet.
**Settings → Notifications → Push notifications** turns on web push for this browser or installed app
(tavrn-protocol PROTOCOL.md §6d): the client registers a service worker (`public/sw.js`, push and notification
clicks only: it caches nothing and there is no offline mode), subscribes with the home node's VAPID key and
registers the subscription with the home node, which pushes while no tab of the client is connected and follows
the notification settings (rooms on other nodes push through the home node for DMs, mentions and calls). Pushes of
encrypted conversations only name the conversation and the sender; "Show message text in push notifications" adds
a preview of unencrypted messages. A click opens or focuses the conversation; a test button sends a push. Signing
out removes the subscription; on iPhone and iPad push works only after adding tavrn to the home screen.
Images open a viewer (zoom, drag, swipe or arrow keys between the images of a message, download icon, open
original); audio attachments get an inline player and videos play inline and enlarge into the viewer.
Downloads only start from the download icon. SVG files are never shown inline or opened, only downloaded (they
can carry scripts). **Settings → Privacy & safety → Image previews** decides which images load by themselves:
always, only from friends and members of shared rooms (default; in rooms every member counts) or never; images
larger than the node's `TAVRN_PREVIEW_AUTO_MAX_BYTES` (default 5 MiB) always wait. The others show a placeholder
with name, size and a **Load** button (and "Load all" for several in one message); nothing is fetched before. Roles with "show separately in the member list" get their own
section there; the role list in the room settings is reordered by drag and drop (or the arrows). `@everyone`
can never get management permissions; the editor greys them out.

## Reports, auto-moderation and ownership

Specified in [MODERATION.md](https://github.com/just-tavrn/tavrn-protocol/blob/main/MODERATION.md); the client shows
these features only for nodes that announce `reports.v1` and `automod.v1`.

- **Reporting.** "Report message" in the message menu (others' messages), "Report" in the member menu and "Report
  room" in the room menu (rail and the ⋯ in the room header). The dialog asks for a category and optional details
  and says who will read the report (the room's moderators and the node admins, or the node admins only). Reports
  of a room go to the room's node; reports of direct messages to your home node. For an **end-to-end encrypted**
  message nobody else can read it, so the dialog offers to release its text and up to ten messages before it: only
  after ticking the consent box it lists exactly what would be sent (author, time, text, file names, never files)
  and lets you untick context messages; the reported message itself is always included, and a report without any
  text stays possible. Messages this device cannot decrypt cannot be released. Plaintext messages are linked by the
  node instead. Reports are not anonymous to moderators; the reported person is never told.
- **The inbox.** Room settings → **Reports** (members with `moderate_members`) and Admin → **Reports** (node admins,
  every report of the node, filterable by who handles it) list the reports with their status. A report shows the
  reporter, the target, the reporter's text, the plaintext message as it was when reported, or the released text
  under the label "released by the reporter – not verified". Moderators assign reports to themselves, add a
  resolution note, resolve or dismiss them, and act from the report: delete the message, time out (with the usual
  durations), remove, ban (node ban for node reports) or delete the person's messages (with the count and a typed
  confirmation). The actions run with the moderator's own permissions and are noted in the audit log with the
  report. The ⚙ in the room header and the tabs show the number of open reports; new reports arrive in the bell
  🔔 and as a toast (not while notifications are set to nothing or the room is muted).
- **Auto-moderation.** Room settings → **Auto-moderation** shows the node's flood protection and edits the room's
  content rules: words and phrases (one per line, `*` within a word, optionally whole words only), link filters
  (block all, allow only some domains, block some domains), exempt roles and channels, and the action (block,
  remove silently, remove and time out). Members with `moderate_members` but without `manage_room` see the rules
  read-only. The rules never apply to end-to-end encrypted channels; the tab says so. A blocked message stays in
  the composer with an explanation that names the rule (or the node's own filter).
- **Welcome channel.** Its entries offer no "Delete": nobody can delete them, owners and node admins included.
- **Ownership.** Room settings → Overview → **Transfer ownership** hands the room to another member of the room's
  node (not a bot); the owner confirms with the password, a passkey or single sign-on. Deleting an account that still
  owns rooms lists them in the deletion dialog with "Transfer ownership" and "Delete room" for each.
- **Single sign-on groups.** Admin → SSO picks the rooms and their roles of a group by name.

## The desktop app

The same client also runs as the desktop app for Linux and Windows ([DESKTOP.md](DESKTOP.md)): it is bundled into a
Tauri shell instead of being served by a node, asks for the home node on the first start (the node picker at `/node`,
changeable under Settings → App, where the app also shows its version and installs signed updates) and talks to that
node over https and wss. The client's platform layer (`src/platform/`) tells the API client, the WebSocket and the link
builders where the node lives. Flows that need the node's own origin are not offered in the app (passkeys, single
sign-on, the connect flow, captchas, web push); the password with TOTP or a recovery code works. The full list and
the reasons are in DESKTOP.md "Limitations".

**Global hotkeys** (app only): Settings → Voice & video → Global hotkeys binds push-to-talk and the priority speaker
(held), mute and deafen (toggles) to key combinations that also work while the app is in the background or minimized,
for example during a game. A recorder per action takes the combination (Escape cancels, Backspace removes it) and
shows the key names of the platform (Super, Win or Cmd). The bindings are kept with the voice settings, apart from the
push-to-talk and priority keys of the window, and are handed to the shell at every start; a combination that another
action or a key of the window already uses is refused. The browser shows a hint instead (DESKTOP.md "Global
hotkeys").

## Translations

The web client ships English (default) and German. To add a language, copy `web/src/i18n/en.json` to
`web/src/i18n/<code>.json`, translate the values, and register the file in `web/src/i18n/index.ts`.
A unit test verifies that every language has exactly the same keys as English.
