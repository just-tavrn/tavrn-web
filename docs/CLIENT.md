# The web client

What the web client does, screen by screen: accounts and encryption, several nodes in one client, voice and video,
the room rail and its folders, context menus, notifications and media, translations. The protocol behind each part is specified in
[tavrn-protocol](https://github.com/just-tavrn/tavrn-protocol); the client's accessibility is documented in
[ACCESSIBILITY.md](ACCESSIBILITY.md).

## Accounts in the web client

Every password account has a second factor: registration is a short wizard (account → authenticator app
via QR code or a passkey → ten recovery codes shown once → recovery key), and sign-in asks for the TOTP
code, a recovery code or a passkey; "Sign in with a passkey" skips the password. The **recovery key**
(24 words or a compact string, generated in the browser and never sent anywhere) unlocks the encrypted
messages on a new device or browser; passkeys with the PRF extension can do the same (the client's own PRF
assertions name the relying party id the node publishes, `webauthn.rp_id`, so they also work when passkeys belong
to a parent domain of the web client's host). Local keys live in
IndexedDB, encrypted under a device key derived from the master secret; the security settings manage
factors, recovery codes, the recovery key and the optional "require the recovery key every time" lock.
Without the recovery key the client offers a degraded mode (plaintext channels only, encrypted
conversations stay locked) or an identity reset (old encrypted history is lost). Details:
[PROTOCOL.md](https://github.com/just-tavrn/tavrn-protocol/blob/main/PROTOCOL.md) §5a, [ENCRYPTION.md](https://github.com/just-tavrn/tavrn-protocol/blob/main/ENCRYPTION.md) §2.4.

## Date of birth and age gates

Nodes with `age.v1` (protocol PROTOCOL.md §5e) ask every account for its date of birth.

- **Registration** (password, passkey and the connect page of the apps all use the same form) has a required
  "Date of birth" field: a native date input with a visible label, a hint that says what the node does with it and an
  error text linked to the field. The client checks the date like the node does (a real date between 1900-01-01 and
  today, at least the node's `age.minimum_age` from `GET /node`) before it sends anything.
- **Accounts without a date of birth** (created before `age.v1`, or provisioned by single sign-on) see a blocking
  dialog "Please add your date of birth" (`components/age/DateOfBirthGate.tsx`) as soon as `GET /users/me` reports the
  tier `unknown`; the node answers `age.status_required` everywhere else until then. The only other way out is
  signing out. The date is set once; corrections go through the node operator.
- **Room settings → Overview** and **Room settings → Channels** have an "Age restriction" selector (Everyone or Adults
  only (18+)) with an explanation of what it enforces; it is applied at once. The node lets only adults switch it on.
- **Discover** lists gated rooms only to adults (the directory request carries the session of an account of this node)
  and marks them "18+". **Invite links** to a gated room tell users under 18 that they cannot join and disable the
  button.
- **Gated channels** stay in the channel list with an "18+" badge. For users under 18 (and of unknown age) the channel
  view is a notice "This channel is for adults only" instead of the messages, the composer, the previews or the voice
  stage (`lib/age.ts` `useChannelLock`).
- The client never shows another user's age or status; only the own status from `GET /users/me` decides what is locked.

## Several nodes in one client

The web client is a client of several nodes at once. Rooms of other nodes appear in the room rail under
their domain (`/n/<domain>/rooms/…`); the client opens a federated session there with a token of the home
node, renews it on its own and keeps one WebSocket per node. The conversation index on the home node lists
every room and conversation on any node, so a new device brings them all back after signing in. The login
page offers "Sign in with an account of another node": with the address `alice@home.example` the client
finds the home node and signs in there directly (password and TOTP or a recovery code) or through the
home node's own web client (the connect flow with PKCE, needed for passkeys and captchas); on that origin
the recovery key unlocks the encrypted messages. The same `/connect` page also confirms the sign-in of the
desktop app (`/connect?session=…`, app sessions of FEDERATION.md §8 step 3): sign in there with any method, the page
names the app's device and, after "Sign in to the app", says "return to the app" instead of redirecting; a sign-in on
the page for such a confirmation skips the encryption step, because the app creates its own device keys. `method=passkey`
(or `sso`) starts that method at once with only "Signing in with a passkey…" and "Use another method". After a passkey
ceremony with the PRF extension the page seals the passkey's unlock secret to the app's key from the URL fragment
(`#k=`, never sent to a server) and sends it with the confirmation, so the passkey unlocks the app's encrypted messages
as it does in the browser; an *unlock* request of a signed-in app ("Unlock the Tavrn app?") asks only for the passkey. Encryption works across nodes: the MLS group of a
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
connection quality at hand while you read text channels: its first line is the signal bars with a small padlock
(voice is always end-to-end encrypted; the tooltip names both, for example "Encrypted · connection good"), a short
status ("Connected") and the quality, the second line the channel and room. The channel list marks every channel
with an SVG lock next to its kind icon: closed for end-to-end encrypted channels (all voice channels), open in the
warning colour for plaintext channels; channel headers show the same lock. Moderators open a participant's menu (right click
or ⋯) to server-mute, disconnect or move them, drag people onto another voice channel, or move everybody at
once from a voice channel's menu (with a confirmation; the target's user limit holds); the target list offers every
voice channel the moderator may move into, also channels the member may neither view nor join (VOICE.md §7 "Moved
participations"). A member moved into such a channel follows the move as usual: the channel shows up in their
channel list while they are in it (with the stage and the whiteboard), and
disappears again when they leave; they cannot rejoin by themselves. Everybody can set a per-person volume there. A dropped connection rejoins by itself; others see an amber plug on your avatar
meanwhile instead of you vanishing.

**Quick menus on mute and deafen.** A right-click (the context-menu key, a long press on touch) on the microphone
button of the voice bar or of the stage controls lists the microphones (the current one checked), switches
push-to-talk on or off (with the bound key as a hint), has sliders for the input volume and, with voice activation,
the activation threshold, and links to the voice settings; the headphones button lists the output devices the same
way with an output volume slider. A choice changes the voice settings, so it applies live to the running call
like a change in the settings tab. The menu stays open after a choice and closes on a click outside, Escape or a
second right-click on the same button; the arrow keys reach the sliders. While the browser hides the device names the menu offers **Show devices**;
browsers without output device selection (`setSinkId`, missing in some Firefox builds and WebKitGTK) say so
instead of listing speakers. A click keeps muting and deafening.

**Voice and stream audio are separate.** A participant's voice (microphone) and their screen share's audio
each have their own volume (0–200 %, kept per device): the voice volume in the participant's menu, the stream
volume behind the speaker button on the stream tile and, while they stream, in the menu next to the voice
volume. The output volume of the settings multiplies with both; the priority speaker still ducks the others'
voices and streams as before. Deafen mutes voices and the notification sounds about others, but a stream you
are watching (its tile is on screen) keeps playing: the tile shows a speaker badge and the voice bar says
"Voices muted, the stream keeps playing". A stream that is not on screen (you opened a text channel or the
settings) goes silent while deafened. The switch "Streams stay audible while deafened" in the voice settings
(on by default) turns this off, so that deafen silences everything.

**Calls in DMs and group DMs:** the call button in the conversation header rings the others (a banner with a
soft synthesized ringtone on all their devices, also across nodes); accepting opens the call view with the same
tiles and controls as voice channels, end-to-end encrypted with the conversation's keys. Nobody answering within
45 seconds or a declined DM call leaves a "missed call" entry, a finished call one with its duration.

Media is end-to-end encrypted with keys from the channel's MLS group: the client never publishes before
LiveKit confirmed encryption and refuses to join in browsers without insertable streams. **Settings →
Voice & video** (kept per device, applied live): microphone and speaker with a level meter (browsers name
the devices only once the page may use the microphone: the desktop app asks for it when the tab opens, the
browser offers **Show devices**, also on the first click into a list, and the lists follow devices plugged in or
out), two microphone
tests with the same processing as in a call, except that push-to-talk never closes the gate there, the tests
judge the microphone, not the key (**Hear yourself** plays the microphone back live with a timer
and stops after one minute, when you leave the settings or when you join a voice channel, and is not available
while you are in one; it asks for headphones and mutes itself while the sound is loud and concentrated on one
frequency, the howl of speakers feeding the microphone, until you unmute it; **Record and play back** records
five seconds), a test tone, input/output volume, automatic gain, echo cancellation, noise suppression
(off, the browser's, or RNNoise running locally as a WASM audio worklet), a noise gate, voice activation
with a live "transmitting" light or push-to-talk (key and release delay), camera with preview, resolution and
frame rate within the node's limits, mirroring and background blur (strength slider, quality fast/balanced/high
with mask smoothing) or an image (MediaPipe served by the node, turned off automatically on machines that cannot
keep up, with the measured numbers), soft notification sounds (join, leave, mute, deafen, streams, connection, and a soft rising and falling
tone when push-to-talk or the priority key opens and closes the microphone, heard only by you, never while the server
keeps the microphone closed; volume and a switch per sound), the ringtone volume, and a **connection test** that tries every path to the
node's media server (UDP per address, TCP, TURN) and says what to fix when one fails. Room owners upload soundboard clips under room
settings → Soundboard; members with `use_soundboard` play them from the call controls into their own
(encrypted) microphone track. LiveKit, RNNoise and the background effects are only loaded once voice is used.

**The screen stays on during calls:** while you are in a voice channel or a call, the browser client asks for a
screen wake lock (switch "Keep the screen on during voice calls" in the voice settings, on by default), so a phone
does not lock mid-conversation. Browsers hold it only while the page is visible and the client asks again when you
come back; keeping voice alive with the display off is up to the mobile apps, and the desktop app will keep the system
awake through its shell.

**Quality and traffic** (VOICE.md §4a): with `manage_channels`, room settings → Channels → a voice channel →
**Voice quality** offers Saver (8 kbps, telephone quality, least traffic), Standard (32, clear speech), High (64,
the default of new channels), Studio (128, practically transparent speech), Music (192, stereo) and a custom
value; presets above the node's `TAVRN_VOICE_MAX_BITRATE_KBPS` are shown as limited by this node. Everybody in a
channel receives what a speaker publishes (the media server forwards, it does not transcode), so quality is a
channel setting, and the section names the traffic per hour for every speaker and listener (Music: about 86 MB).
The voice bar shows the quality of the current call with the Opus bitrate in its tooltip. The microphone is
published as Opus with the channel's bitrate, DTX on and RED off; in-band FEC is negotiated by the node's media
server (`limits.audio_fec`), the browser needs no option for it. **Music mode** (192 kbps and more): echo
cancellation, noise suppression (also RNNoise) and automatic gain are off, DTX is off so quiet passages are not
cut, and the capture asks for two channels. Stereo is published only when the device really delivers two
channels; a mono microphone is published as mono and heard in the middle, and a two-channel interface with a
single microphone on one input is folded onto both sides (the gate worklet's channel guard: one side below
−70 dBFS while the other carries signal), so nobody is ever heard on one side only. Calls in DMs use 64 kbps.
A changed quality applies from the next join.

## Encrypted conversations

Each channel, DM and group DM is an MLS group ([`@tavrn/e2ee`](https://github.com/just-tavrn/tavrn-js/tree/main/e2ee), `src/mls.ts`): the first device that opens a
conversation creates it, further devices join by external commit, DM and group members' devices are added
with a Welcome. Message content and attachments are encrypted and signed in the browser, the node only
stores ciphertext. Every device the client meets is checked against the user's identity key (pinned on
first use); a changed key shows "security key changed", and a device in a conversation that is not a
member or not confirmed by its user's key shows a warning and blocks sending until acknowledged. Content
keys are backed up encrypted on the home node so that a new device unlocked with the recovery key reads
the history. Friends (requests, accept, block) live under "Friends" on the home view.

**Changed security keys** (ENCRYPTION.md §3.3). Until the user acknowledges the "security key changed" badge (in the
member list or next to the author; acknowledging asks for confirmation) or verifies the new key, the contact's
devices under the new key do not count: DMs and group DMs do not add them, and in channels their leaves show in the
unknown-device warning with "security key changed and not confirmed yet", which blocks sending like every ghost.
Acknowledging adds the missing devices and checks the roster again at once. Rotations signed by the previous key
(§9a) are not held back.

**Sending** (ENCRYPTION.md §5.2, §5.3). Before encrypting, the client processes the commits it has not seen yet; if
that fails, nothing is sent and the composer keeps the text with an error to try again. If the commits brought a
device nobody was shown yet, sending stops as well and the unknown-device warning has to be acknowledged again. A
message's thread and reply are signed inside its encrypted content, so a message the node moved to another thread or
another reply target shows as "Moved message (signature does not match)" instead of its content. When the node
answers that the epoch is stale (`mls.epoch_stale`), the client catches up and encrypts once more.

**Whiteboard drafts.** The owner's unsaved board of a conversation is kept in the local encrypted store under a name
derived with the device's search key (`whiteboard-draft:<HMAC>`), so the store's record names do not reveal which
conversations have a board; drafts under the old name (with the conversation id) are moved on first read.

**Several tabs.** All tabs of one browser profile share the account's MLS state (one IndexedDB store). One tab owns
it: the first tab that opens the account's session manager holds the Web Lock `tavrn-mls|<home node>|<address>/<device>`
(`src/stores/mls.ts`, `@tavrn/e2ee` `src/tabs.ts`), runs every join, catch-up, commit and encryption and alone
writes the state. The other tabs read from a copy that follows the owner's writes (decryption, rosters, voice
keys) and send everything that changes the state to the owner over a BroadcastChannel of the same name; the
owner also passes on the epoch changes their views wait for. When the owner tab closes or signs out, the next tab
takes the lock over, loads the state from the store and runs the calls that were in flight once more. Without Web
Locks or BroadcastChannel every tab works alone (a second tab may then have to rejoin after an invalid commit, as
before). The desktop app has one window, which always owns the state. New KeyPackages (topped up at every start)
are created in the owner's state too.

History is lazy: a conversation's pages are dropped when it closes, and the local search index keeps text and file
names of the last 90 days. **Keep the full history on this device** (the menu of an encrypted channel, DM or group DM;
default off) keeps the conversation's whole history here instead: the background sync pages it back to the start, the
search index keeps all of it, and the messages with their decrypted content stay in an encrypted local archive
(IndexedDB `tavrn-history`, sealed with keys derived from this device's local storage key, so it locks with the device
and reveals no ids or text; `web/src/history/`). The message list then uses the archived content instead of
decrypting again and reads from the archive while the node cannot be reached. Each conversation may take up to the
space set under Settings → Privacy → Local search index (default 50 MB; the oldest messages go first); the menu entry
shows what it takes, the settings the total. Turning the setting off, clearing the index or signing out (which wipes the
device) deletes the archive.

**History for new members** (protocol ENCRYPTION.md §7b; `web/src/crypto/history.ts`, `web/src/crypto/groupJoins.ts`).
The channel setting (channel settings → History for new members) decides what a member gets from before their room
join: nothing (`since_join`, the default), the last days or everything. Everything posted since the join is always
readable, also in channels the member opens only later: a device enters a channel's encryption group only once it is
there, and the messages in between need keys from other members. The client therefore joins the groups of a room's
encrypted channels (text, announcement, forum and files) as soon as the room is loaded on an unlocked device, one after
the other with a short pause, so that gap is usually empty. Otherwise an online member's device shares the missing keys
automatically (under every setting, also `since_join`); until they arrive the channel shows "Older messages are being
unlocked…" at the top and the messages and forum post titles in question as not readable yet, and they open as soon as
the keys are there. With no other member online the keys come when one is back. Nothing from before the join is ever
shared under `since_join`: the node does not serve those messages to the member, and the client accepts a key only after
checking it against a message it was served.

**History after a key reset** (protocol ENCRYPTION.md §7b, capability `history.restore`; `web/src/history/restore.ts`).
A member who reset their security key keeps their rooms but not the encrypted history from before the reset, and
other members' devices never send those keys automatically: the sharing code (`HistorySync` in `@tavrn/e2ee`) shares
only epochs after the reset epoch with a waiting member who has `key_reset_at`, and with older nodes it takes the reset
time from the member's keys document (`identity_reset_at`, `src/crypto/history.ts`) so that it cannot be tricked into
sending the old range. In such a room the member sees a banner in every encrypted channel (and in the file browser of
encrypted files channels) that explains it and asks the room's moderators to restore the history, with an optional
message, the request's state, "Withdraw request" and, after a denial, the reason and "Ask again". Members with
**Restore history after a key reset** (`restore_history`, owner and administrators by default) get a notification and
handle the requests under room settings → History requests: the requester, their join and reset dates, the message,
every encrypted channel the requester may read (text, announcement, forum and files channels) with the window and
the epochs this device would send, and a warning when this device lacks some keys. Approving needs the confirmation
that the person's identity was verified on another channel; the client then approves (telling the node whether the
restore is partial) and sends the keys from this device for every channel in which a device of the requester is in the
group, and reports what it shared, what was incomplete and what it skipped. Denying needs a reason, which the
requester sees. The welcome channel shows both decisions; the room's overview has the switch "Members may ask to
restore their history".

**Share keys and sealed history shares** (protocol ENCRYPTION.md §3.1 and §7b "Format v2", capability
`history.shares2`). Automatic; there is nothing for users to do. Every device has a share key next to its device key and
publishes it with its attestation (devices attested earlier publish it once on their next start). Where the node
hosting a channel announces the capability and every device of the recipient that is in the channel's group has a share
key that verifies with its attested device key, the history keys for a new member (and the keys of an approved restore)
go out sealed to exactly those devices, so no other member could read them; otherwise the client falls back to the
older format. Received shares are accepted only with this device's own box. Encrypted thread titles name their thread
in the signed content (the client picks the thread id where the node announces `threads.client_ids`, renames always),
and the answers of bots name the interaction they answer: a title or answer the node moved elsewhere is shown like
anything else that cannot be read.

## Files channels

A files channel (kind `files`, [FILES.md](https://github.com/just-tavrn/tavrn-protocol/blob/main/FILES.md)) is a file
browser (`web/src/files/`): breadcrumbs, list and grid views, sorting, uploads by button or drag and drop with
progress, folders, rename, move (dialog or dragging, with a non-drag equivalent), delete, download, media in the
viewer, the context menu and keyboard navigation.

**End-to-end encrypted files channels** (FILES.md §8, the default: the "Create channel" dialog has "End-to-end
encrypted" ticked for files channels, with the consequence on one line) use the channel's MLS group like a text
channel (`files/e2ee.ts`). Uploads are encrypted in 1 MiB chunks in the browser (one chunk in memory at a time) with a
fresh file key; raster images get a client-made thumbnail (at most 320 px, WebP or JPEG) encrypted with the same key;
name, type and key travel in the entry record, encrypted under the channel's current epoch by the tab that owns the MLS
state. Browsing decrypts the records of the listed folder (names, types, folder names; the header shows the SVG lock),
downloads and previews decrypt chunk by chunk, and media keep their safe blob types (SVG is never rendered). The node
cannot search: the search box filters the open folder, and the global search finds the files through the local index
(below). The node cannot check name uniqueness either, so the client numbers duplicates (`name (2).ext`) before it
uploads and refuses a rename to a name the folder has. Entries this device cannot decrypt are listed as "Encrypted
file"/"Encrypted folder" with size and date; the channel shows the same states as the message list: "locked" (key store
locked), joining, no group yet, an error, or "some entries cannot be decrypted yet" (keys of older epochs missing, which
history shares may fill). **Your files** (toolbar; in place of the browser while the device is locked) lists the
member's own uploads and folders by ownership alone (`GET …/files/mine`: counts, sizes, dates, no names) with single and
bulk deletion, so lost keys never keep files on the node. History for new members follows the channel's setting, which
for files channels is "all" (default) or "since join"; keys are checked against entry records instead of messages,
the same way after a key reset (only records since the reset) and for a restore request (the window's oldest record).

The channel settings show the encryption as fixed ("cannot be changed: create a new files channel and upload the files
again"); external stores of encrypted channels need no `encrypt_files` (they only receive ciphertext). Unencrypted files
channels keep the permanent "not end-to-end encrypted" banner.

**Deleting** a files channel asks for the channel's name and says what happens to its files: counts and size, where they
are ("stored on this node" / "stored on WebDAV at host"), and the consequence: "All files are deleted permanently", or
for an external store "The objects under \<prefix> are deleted from the external store" with **Keep the objects on the
external store** (only for unencrypted external channels, sent as `keep_external`); for encrypted external channels the
dialog explains that the objects are unreadable without the channel's keys and are deleted too. The room deletion
dialog lists its files channels the same way (`files/DeleteChannel.tsx`).

**Search** (SEARCH.md §3.6): every decrypted entry goes into the local encrypted search index (name and folder path as
text, type category, size, upload date, uploader, channel and room; thumbnails only by reference). The background sync
pages through the records of encrypted files channels this device has opened (`search/filesSync.ts`). Results appear in
the search panel under **Files** with name, folder, size, date, uploader and the thumbnail (fetched and decrypted on
demand); choosing one opens the folder with the entry selected. The filters gain "Type (files)"; uploader and dates use
the existing author and date filters. Deleted entries leave the index, results whose entry is gone are removed when
opened, and "Clear index" clears them with the messages; the 90-day window counts from the upload date.

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
slash commands work there as in the channel (application commands invoked there name the thread, so the bot answers
in it), and in encrypted channels the title is encrypted with the channel's
messages. Its header follows or unfollows the thread and, for its creator or members with *Manage threads*,
renames, archives, locks or deletes it. Starting or writing in a thread follows it; only followed threads count
towards the channel's unread badge and raise notifications (direct mentions always do). The client loads the
followed threads of every room once it is connected (one room after the other in the background, at most 100 rooms per
node, again after a reconnect at most once a minute) and keeps them current over the WebSocket, so this works for rooms
not opened since the start as well; a thread started on another device is followed here at once.

Forum channels show posts instead of messages: cards with title, tags, author, replies, last activity and the
start of the first message, tag filter chips, "Latest activity" or "Newest posts", archived posts on demand and
**New post** (title, message, up to five tags). Where the node announces `threads.client_ids` the client picks the
post's id, so the device signature of the first message covers it like every reply and readers see no "unverified"
marker; a node that refuses the id (this device's clock is far off) gets the post with an unsigned first message. Their tags and the auto-archive time of every channel's threads
are set in the room settings under *Channels* (*Manage channels*). Webhooks (room settings → *Webhooks*) can post
into forum channels too; the settings explain that every payload then names a post with `"thread_id"`. In announcement channels only members with
*Manage messages* post; the others see a notice instead of the composer and react or reply in threads.

## Room rail and folders

The room rail (the narrow bar on the far left; inside the navigation drawer on phones) lists Home, your rooms,
the rooms of other nodes under their domain, "+" (create or join) and Discover. Once their channels' counts are known,
rooms show a mention count (red, bottom right); without mentions a room whose notification level is "All messages"
shows its unread count there (neutral grey, capped at "999+"; "All messages" is the node's default level), a room
with "Only mentions", "Nothing" or a mute keeps the unread dot (top right). Voice activity is a badge top left (see "Voice activity in the
room rail and the friends list"). Rooms can be grouped into **folders**:

- **Create**: right-click (long press on touch, the context-menu key or Shift+F10 on Home, + or Discover) on the
  empty rail → "New folder…" asks for a name (up to 32 characters; without one the folder is named after its
  rooms) and an optional colour. A room's menu offers "Move to folder ▸" with the folders, "New folder…" (a folder
  with that room) and "Remove from folder"; "Move up" / "Move down" reorder rooms and folders.
- **Folder menu**: "Rename…", "Colour ▸", "Expand"/"Collapse", "Move up"/"Move down", "Delete folder" (its rooms
  return to the rail at the folder's place; no room is left).
- **Drag and drop** (mouse): a room dropped onto another room makes a folder of both (as on phone home screens),
  onto a folder adds it, onto the empty rail takes it out of its folder; dropped onto the upper or lower edge of an
  entry it is placed before or after it (an accent line shows where). On touch nothing is draggable; every drag
  action is also a menu entry (WCAG 2.5.7).
- **Display**: a collapsed folder is a rounded square with up to four mini icons on its colour; a click expands
  it inline (its rooms follow on a slightly lighter background) and collapses it again. A collapsed folder shows
  the sum of its rooms' counts (a mention count wins over the unread count of its "All messages" rooms, which wins
  over the unread dot), the voice badge of its rooms and the selected ring while it holds the
  open room. Rooms of several nodes can share a folder; their names carry their domain. A room you leave (or one
  its node no longer lists) leaves its folder; rooms of a node that cannot be reached stay where they are.
- **Accessibility**: the rooms stay links in a list ("Your rooms"); a folder is a disclosure button
  (`aria-expanded`, `aria-controls`) whose accessible name holds its name, the number of rooms, the mention or
  unread count, the voice activity and "contains the open room"; a room's accessible name is its name followed by
  its counts and voice activity ("Raids, 12 unread, 3 in voice, someone is streaming"). ↑/↓, Home and End
  move through the rail, → expands a folder or enters it, ← goes back to the folder or collapses it, Enter and
  Space toggle it.

Storage: folders are a per-account client setting kept in this browser (local storage
`tavrn.rail:<account address>`). The shape is ready to sync through the home node later (follow-up, not yet
done):

```json
{
  "clientStateVersion": 1,
  "folders": [{ "id": "f3a…", "name": "Raids", "color": "violet", "roomIds": ["home.example/01J…", "other.example/01K…"] }],
  "order": ["home.example/01H…", "folder:f3a…"],
  "expanded": ["f3a…"]
}
```

Room keys are node-qualified (`<domain>/<room id>`); `order` lists the top-level entries (rooms of the home node
and folders; rooms of other nodes outside folders stay under their domain), rooms the order does not know yet
are appended in the node's order; `expanded` is device state. A newer `clientStateVersion` than the client
knows is ignored (the rail shows no folders) instead of being misread.

## Voice activity in the room rail and the friends list

The client knows who is in which voice channel of every room you are in, not only of the open one: at start, after
every reconnect and resync it loads `GET /users/me/voice` (VOICE.md §5) from the home node and from every node with a
federated session, and `voice.state` events keep it current. The node only reports channels you may view, so nothing
here ever reveals a hidden channel; rooms you are not in are never shown either.

- **Rail badges**: a room with somebody in voice gets a small speaker badge in the top left corner of its icon
  (green); while somebody shares a screen it becomes a monitor (amber). The unread dot (top right) and the
  mention or unread count (bottom right) stay. A collapsed folder shows the badge of its rooms. The item's accessible
  name says "3 in voice" and "someone is streaming".
- **Room card**: resting the mouse on a rail room for 300 ms, or moving the keyboard focus onto it, opens a card to
  the right of the rail: the icon, name (and node), member count, online count (when the member list was loaded),
  description, the unread or mention state and who is in which voice channel (avatars grouped under the channel name,
  at most eight, then "+n"; a small monitor marks who streams). The card stays open while the pointer is over it and
  closes with Escape, when the focus leaves the room or the pointer leaves both. On touch devices there is no hover:
  the long press on a room opens its menu with the card's content as a non-interactive head above the entries.
- **Friends list**: a friend in a voice channel you can view shows "In voice: <room> / <channel>" under their name.
  Each friend has a menu (right-click, long press or the "⋯" button) with "Join <channel>" while they are in voice,
  which opens the channel and joins it like a click in the channel list (errors such as a full channel or a missing
  permission come as the same messages), plus "Message", "Remove friend" and "Block". A friend in a channel you cannot
  view, or in a room you are not in, shows nothing.

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
A choice that only changes a state shown in the menu (notification level, @everyone, mute and unmute, roles, server
mute, keep the full history, folder colour) keeps the menu and an open submenu open and shows the new state, like the
voice quick menus; navigation, copy, join/leave, moderation and destructive items close it.
The emoji picker (composer, message reactions, sound emojis) has a fixed size (bounded by the viewport) and opens
below its button or above it when there is no room; the grid scrolls inside, and the space is reserved while the
emoji data loads, so the panel never grows out of the viewport.

The sidebar has three bars. At the top, the **room header** is one button (room icon, name, chevron ⌄; rooms of
other nodes show their domain below the name) that opens the room menu: "Invite people" and "Room settings" first,
then mark as read, notifications, copy ID, report and leave; moderators see the number of open reports as a badge on
the chevron and next to "Room settings", which then opens the report inbox. Above the account bar sits the **voice
bar** while connected. At the bottom, the **account bar** holds the avatar with the account menu (presence, custom
status, activity, legal pages, sign out and, for node admins of the home node, "Node administration"), the own name
with the connection state below it, the notification bell and the user settings. On phones the bell is in the top
bar instead, so there is always exactly one. Node admins also find "Node administration" at the top of the settings
navigation.

Notifications: mentions (`@name`, `@name@domain`, `@Role` of mentionable roles, `@everyone`) and DMs show a
toast with a jump link, a soft sound and an entry behind the bell next to the settings gear; with
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
"Push notifications for new reports" (on by default, stored on the home node as `global.reports`) lets room
moderators and node admins turn off the pushes of new reports; such a push names only the room ("New report in
\<room>", or "A report for the node admins") and opens the room's Reports tab or Admin → Reports. A hint under the
switches says what rooms on other nodes push: under "All messages" they do not push ordinary messages, only mentions,
direct messages and calls (the home node receives no hints for the rest, PROTOCOL.md §6d).
When the browser's subscription still belongs to another account (`409 push.endpoint_taken`), the client unsubscribes it and subscribes again, which gives this account a new endpoint.
Images open a viewer (zoom, drag, swipe or arrow keys between the images of a message, download icon, open
original); audio attachments get an inline player and videos play inline and enlarge into the viewer.
Downloads only start from the download icon. SVG files are never shown inline or opened, only downloaded (they
can carry scripts). **Settings → Privacy & safety → Image previews** decides which images load by themselves:
always, only from friends and members of shared rooms (default; in rooms every member counts) or never; images
larger than the node's `TAVRN_PREVIEW_AUTO_MAX_BYTES` (default 5 MiB) always wait. The others show a placeholder
with name, size and a **Load** button (and "Load all" for several in one message); nothing is fetched before. Roles with "show separately in the member list" get their own
section there; the role list in the room settings is reordered by drag and drop (or the arrows). `@everyone`
can never get management permissions; the editor greys them out.

**Channel permissions are layered** ([permissions.md](https://github.com/just-tavrn/tavrn-protocol/blob/main/permissions.md)
"Evaluation"): roles give the base, a category's overrides apply to all its channels, and a channel's own overrides
win over the category's; a bit left at "–" inherits from the layer below. In **Room settings → Channels** the
category name opens **Permissions in this category**, a channel shows **Permissions in this channel** (the former
"sync with category" switch is gone). Both editors list only the channel-scoped permissions, grouped as general,
text, voice, files and management; under every permission the value it inherits is shown in grey ("Inherited:
allowed by the category" / "by the roles"), which is also the accessible description of its allow/neutral/deny
choice. **Reset to category** removes a channel's own overrides after a confirmation. The sidebar lists only the
channels the user may view, and a category only when one of its channels is visible (channel managers also see
empty ones); `channelPermissions` (`web/src/lib/channelPermissions.ts`) computes exactly like the node, including
the view, read and connect a moved participation grants in the voice channel the user's own session is in. The node
sends a private channel's events only to the members it is listed to: a member who gains a channel gets
`channel.create`, one who loses it `channel.delete` with `hidden: true` (PROTOCOL.md §6). The client then drops the
channel from the sidebar like a deleted one, but an open channel says **You no longer have access to this channel**
instead of "Channel not found", and the channel's local search entries stay (`web/src/lib/hiddenChannels.ts`).

**File types** (PROTOCOL.md §7a, [permissions.md](https://github.com/just-tavrn/tavrn-protocol/blob/main/permissions.md)
"Upload categories"): images, audio, videos, documents, archives and other files. **Room settings → Overview →
Uploads** sets what everyone may attach (`@everyone`, the room default) and links to the roles. In **Room settings →
Roles** every role has **Allowed file types**: a list, or for roles other than `@everyone` **Not set (inherit the room
default)**, where the member's highest role with its own list decides, otherwise `@everyone` (shown greyed); it is
saved with the role, and only when it changed. The category and channel editors have a **File types** block under the
permissions with the same allow / – / deny choice per type, the inherited value in grey, and the result for the
selected role with the unsaved changes applied ("Result for Artists: Images, Documents"; `web/src/lib/uploadPolicy.ts`
evaluates like the node). Programs and scripts additionally need the node's `TAVRN_UPLOAD_ALLOW_EXECUTABLES`. The
composer filters the file picker and refuses a file outside the policy before anything is uploaded.

**Download warning.** Before an attachment, a file in the media viewer or a files-channel entry is saved, the client
checks the content about to be written (decrypted, for encrypted files) with the node's rules (`executableKind` in
`web/src/lib/uploads.ts`: magic bytes of Windows, ELF, Mach-O and DEX programs, `#!` scripts, shortcuts and disk images;
the node's list of dangerous extensions; executable content types). For a program, script, installer, shortcut, disk
image or macro document a dialog asks first: **This file can run programs on your computer**, with the file name and
the detected kind, **Cancel** (focused, so Enter never downloads) and **Download anyway**; Escape cancels. Archives
(zip, 7z, rar, tar.*) are not warned. The warning is always on (`web/src/lib/download.ts`).

## Reports, auto-moderation and ownership

Specified in [MODERATION.md](https://github.com/just-tavrn/tavrn-protocol/blob/main/MODERATION.md); the client shows
these features only for nodes that announce `reports.v1` and `automod.v1`.

- **Reporting.** "Report message" in the message menu (others' messages), "Report" in the member menu and "Report
  room" in the room menu (rail and the room header). The dialog asks for a category and optional details
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
  report. The room header's chevron, "Room settings" in its menu and the tabs show the number of open reports; new
  reports arrive in the bell and as a toast (not while notifications are set to nothing or the room is muted), and
  as a web push while no tab is open (see "Push notifications" above).
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
- **Retention.** Room settings → Overview → **Message retention** (owner or "Manage room") deletes the room's
  messages after a number of days, with their attachments (PROTOCOL.md §7f); the section shows the node's period
  (`GET /node` `message_retention_days`), and a room can only choose a shorter one. Pinned messages and the welcome
  channel are kept. **Attachment retention** below it deletes only the files, earlier if set so.
- **Single sign-on groups.** Admin → SSO picks the rooms and their roles of a group by name.

## The desktop app

The same client also runs as the desktop app for Linux and Windows ([DESKTOP.md](DESKTOP.md)): it is bundled into a
Tauri shell instead of being served by a node, asks for the home node on the first start (the node picker at `/node`,
changeable under Settings → App, where the app also shows its version and installs signed updates) and talks to that
node over https and wss. The client's platform layer (`src/platform/`) tells the API client, the WebSocket and the link
builders where the node lives. The node picker and the login page take the account's address first
(`alice@home.example`): the shell finds the node of that domain (well-known, SRV, direct) and the app switches to it.
Flows that need the node's own origin (passkeys, single sign-on, the captcha) run on the node's own page in a window of
the app without any native API ("Sign in on \<node>'s page"), and the app takes over the session; a passkey used there
also unlocks the encrypted messages, and "Unlock with a passkey" on the app's unlock screen runs just the passkey on
that page; on nodes without
app sessions the password with TOTP or a recovery code is what works. Web push is not offered. Details in DESKTOP.md
"Signing in" and "Limitations".

The app keeps the key that unlocks the local key store in the OS keychain (Secret Service, Credential Manager) instead
of IndexedDB, and moves an existing key there on its first start; without a keychain it keeps the browser's behaviour
and says so under Settings → App. Mentions, direct messages and incoming calls become native notifications while the
window is not in front (a click opens the conversation; Settings → Notifications switches them off for this device),
and a tray icon shows the voice state (in a channel, speaking, muted, deafened) with mute, deafen, leave voice,
show/hide and quit in its menu; closing the window keeps the app in the tray (Settings → App).

**Downloads** in the app open the system's save dialog; the app writes the file and says where it went ("Saved to
Downloads", with **Show in folder**). Every download of the client goes through one function, `saveFile` in
`src/platform/saveFile.ts` (in the browser: the browser's download as before); DESKTOP.md "Downloads".
**Voice engine:** the desktop app on Linux sends and plays voice through its own native engine (LiveKit's Rust SDK in
the shell; the system's web view has no WebRTC), end-to-end encrypted exactly as in the browser and with the same
settings: devices of its own (Settings → Voice & video lists the engine's microphones and speakers), input volume,
echo cancellation, noise suppression (RNNoise becomes WebRTC's noise suppression there), automatic gain, the noise
gate, voice activation or push-to-talk (also through the system-wide hotkey while the window is in the background),
per-user volumes, mute and deafen, the speaking rings and the notification sounds. On Windows the setting **Native
voice engine (experimental)** under Settings → Voice & video → Voice engine switches the next call to it (default off;
only shown in the desktop app). Audio only for now: camera, screen sharing, soundboard clips and the priority speaker
are not available with the native engine, and their buttons say so (DESKTOP.md "Voice").

**Hotkeys:** push-to-talk (Settings → Voice & video → Input mode), the priority speaker and, under **More hotkeys**,
mute and deafen have one binding each: a single key, a modifier alone (left Ctrl, right Shift, …) or a combination,
taken by a recorder (Escape cancels, Backspace removes the binding) that shows the key names of the platform (Super,
Win or Cmd) and lights the key up while it is held. In the browser they work while the tab has focus; the desktop app
also observes them system-wide, while a game has the focus, without taking the keys away from it (DESKTOP.md
"Hotkeys"). A key of another action is refused; a character typed into a text field never triggers.

## Translations

The web client ships English (default) and German. To add a language, copy `web/src/i18n/en.json` to
`web/src/i18n/<code>.json`, translate the values, and register the file in `web/src/i18n/index.ts`.
A unit test verifies that every language has exactly the same keys as English.

The language also decides the language of the home node's e-mails (address confirmation, password reset, account,
legal and app token mails): the client sends it as `locale` (`PATCH /users/me`) when the app starts and the node has
another one, and whenever the user switches the language under Settings → Language (`lib/mailLocale.ts`). The node
writes English where it has no texts for the language.
