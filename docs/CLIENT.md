# The web client

The web client is the React app through which people use tavrn in a browser and in the desktop app; this document
describes what it does, area by area.

It covers accounts and sign-in, several nodes in one client, the room rail, friends, the sidebar and the channel list,
messages, encryption and history, files channels, uploads and downloads, voice and video, permissions, menus,
notifications, moderation, settings, the desktop app and translations. The protocol behind each part is specified in
[tavrn-protocol](https://github.com/just-tavrn/tavrn-protocol); how to build and test the client is in the
[README](../README.md), the desktop shell in [DESKTOP.md](DESKTOP.md) and the client's accessibility in
[ACCESSIBILITY.md](ACCESSIBILITY.md).

## Overview

In production the node serves the client on its own domain, next to the API, and the client talks to the origin it
was loaded from; the desktop app bundles the same client and talks to the home node its user picks (README "How the
client reaches a node"). Everything a node offers (registration mode, captcha, voice, single sign-on, limits,
capabilities) comes from the node at runtime, and the client shows a feature only where the node announces it.

The screen has four parts: the **room rail** on the far left (Home, your rooms, the rooms of other nodes, Discover),
the **sidebar** with the room header, the channel list, the voice bar and the account bar, the **conversation** in the
middle and the **member list** on the right. Tablets keep the rail and the sidebar in one navigation column on the
left and open the member list as a drawer; phones show one column with the navigation and the member list as drawers
and the bell in the top bar (the member drawer is 240 px wide, 280 px on phones and tablets in landscape). The Home view holds direct messages, friends,
message requests and the invite list. User settings, room settings and the node administration are pages of their own
("Settings" below).

## Accounts and sign-in

Every password account has a second factor: registration is a short wizard (account → authenticator app via QR code
or a passkey → ten recovery codes shown once → recovery key), and sign-in asks for the TOTP code, a recovery code or a
passkey; "Sign in with a passkey" skips the password. The **recovery key** (24 words or a compact string, generated in
the browser and never sent anywhere) unlocks the encrypted messages on a new device or browser; passkeys with the PRF
extension can do the same (the client's own PRF assertions name the relying party id the node publishes,
`webauthn.rp_id`, so they also work when passkeys belong to a parent domain of the web client's host). A passkey unlocks
the messages once the client has stored its secret storage entry (the master secret wrapped under a key derived from
that passkey's PRF output, ENCRYPTION.md §2.4): written from an unlocked device after a PRF assertion with exactly
that passkey, at registration when the device is unlocked, else later. Settings → Security says for every passkey
**unlocks messages** (its entry exists), **can unlock messages: not enabled yet** with **Enable message unlock** (the
authenticator enabled the PRF when the passkey was created, but the entry is missing: the device was locked at
registration, or the assertion was cancelled; the button needs an unlocked device and runs one assertion), or
**message unlock not confirmed** with **Enable message unlock** as well (the registration announced no PRF: some
authenticators report the extension only when used or gain it with a system update, so one assertion with exactly
that passkey tells; with a PRF output the entry is stored and the node marks the credential as PRF-capable with it).
When an assertion gives no PRF output, the passkey says **cannot unlock messages here** with the reason (it signs in,
but this authenticator gave no PRF output; on Windows also that Windows Hello reports the extension only on Windows 11
24H2/25H2 with the February 2026 update or newer) and keeps the button for another try, for example after a system
update; nothing is stored. Removing a passkey removes its entry (the node deletes it with the credential). Local keys live
in IndexedDB, encrypted under a device key derived from the master secret; the security settings manage factors,
recovery codes, the recovery key and the optional lock **Require the recovery key or a passkey every time**. Without
the recovery key the client offers a degraded mode (plaintext channels only, encrypted conversations stay locked) or
an identity reset (old encrypted history is lost). A device whose local keys are gone while its session lives on (the
browser's or app's storage was cleared, or did not survive the process being killed) cannot be unlocked again: a
device key never changes (ENCRYPTION.md §3.1), so instead of the recovery key the banner and the encryption page say
that the device lost its keys and offer **Sign in again**, which signs out and forgets that device; the next sign-in
is a new device that unlocks with the recovery key as usual (its old leaves go as ghosts). **Signing out** (by choice, or because the home node refused the
session, for example after the device was removed elsewhere, or because another tab signed in with another account)
ends the account's sessions on other nodes and forgets them, empties the client's cache of rooms, DMs and contacts and
removes the account's per-browser data (room rail folders, notification entries, push record, terms state, closed
DMs); a new session never uses federated sessions of another account or device. Details:
[PROTOCOL.md](https://github.com/just-tavrn/tavrn-protocol/blob/main/PROTOCOL.md) §5a,
[ENCRYPTION.md](https://github.com/just-tavrn/tavrn-protocol/blob/main/ENCRYPTION.md) §2.4.

The registration form follows the node's e-mail policy (`email` of the discovery document `/.well-known/tavrn`,
`TAVRN_EMAIL`): `required` shows a mandatory "Email" field that the form checks before it sends anything, `optional`
shows "Email (optional)", `none` shows no field. A refused registration keeps every entered value, including the
invite code, so the person corrects only what the node named.

**E-mail confirmation** (PROTOCOL.md §5a.3). An address given at registration gets a confirmation mail with the link
`<node>/verify-email?token=…` (valid 24 hours, usable once). With `required` the field says that signing in with the
password needs the confirmed address, and the recovery codes step names the address the link went to (with `optional`
it says that a confirmed address allows a password reset); the device that registered stays signed in. The page of
the link confirms the address once on load and then offers "Sign in" (or "Continue" with a session); an invalid or
expired link says so and points to the sign-in, a network error offers "Try again", and the page without a token
explains where the link comes from. A sign-in refused with `auth.email_unverified` says that the address is not
confirmed yet and offers "Send the confirmation mail again" (`POST /auth/verify-email/resend` with the entered
account; the node answers the same for every account, sends a new link that replaces the old one, at most three an
hour). The apps open the mailed link in the system browser, on the node's own web client, like the password reset link.

### Date of birth and age gates

Nodes with `age.v1` (PROTOCOL.md §5e) ask every account for its date of birth.

- **Registration** (password, passkey and the connect page of the apps all use the same form) has a required "Date of
  birth" field: a native date input with a visible label, a hint that says what the node does with it and an error
  text linked to the field. The client checks the date like the node does (a real date between 1900-01-01 and today,
  at least the node's `age.minimum_age` from `GET /node`) before it sends anything.
- **Accounts without a date of birth** (created before `age.v1`, or provisioned by single sign-on) see a blocking
  dialog "Please add your date of birth" (`components/age/DateOfBirthGate.tsx`) as soon as `GET /users/me` reports the
  tier `unknown`; the node answers `age.status_required` everywhere else until then. The only other way out is
  signing out. The date is set once; corrections go through the node operator.
- **Room settings → Overview** and **Room settings → Channels** have an "Age restriction" selector (Everyone or Adults
  only (18+)) with an explanation of what it enforces; it is applied at once. The node lets only adults switch it on.
- **Discover** lists gated rooms only to adults (the directory request carries the session of an account of this node)
  and marks them "18+". **Invite links** to a gated room tell users under 18 that they cannot join and disable the
  button.
- **Gated channels** stay in the channel list; text, announcement, forum and files channels carry an "18+" badge
  there. For users under 18 (and of unknown age) the channel view is a notice "This channel is for adults only"
  instead of the messages, the composer, the previews or the voice stage (`lib/age.ts` `useChannelLock`).
- The client never shows another user's age or status; only the own status from `GET /users/me` decides what is
  locked.

## Several nodes in one client

The web client is a client of several nodes at once. Rooms of other nodes appear in the room rail under their domain
(`/n/<domain>/rooms/…`); the client opens a federated session there with a token of the home node, renews it on its
own and keeps one WebSocket per node. The conversation index on the home node lists every room and conversation on any
node, so a new device brings them all back after signing in. The login page offers "Sign in with an account of
another node": with the address `alice@home.example` the client finds the home node and signs in there directly
(password and TOTP or a recovery code) or through the home node's own web client (the connect flow with PKCE, needed
for passkeys and captchas); on that origin the recovery key unlocks the encrypted messages.

Encryption works across nodes: the MLS group of a conversation lives on the node that hosts it, while every user's
keys are checked against that user's own home node. Friends and DMs work by full address (`bob@other.example`); a DM
lives on the home node of the person who starts it and shows its node's domain in the DM list; DMs started by a friend
on another node appear by themselves, room invitations by address wait in the invite list on the home view. An
invitation or call that a node forwards for a person of a third node (the invitation's or ring's `via`) shows "via
\<node>" next to the name, with the explanation that the person's home node did not confirm it; such an invitation is
always a message request. A node
that is down only marks its own rooms and conversations as unreachable; a node that refuses to renew the session asks
to sign in there again. **The first sign-in on a node the account has nothing on** (a link to `/n/<domain>/…` of a node
without a room or conversation of the account in its index) asks first: "Connect to \<node> as \<address>?", because
signing in tells that node the address, the IP address and the online times; nothing is stored before the user agrees,
and side panels never ask. Details:
[FEDERATION.md](https://github.com/just-tavrn/tavrn-protocol/blob/main/FEDERATION.md) §4, §6, §8 and §13.2.

**The connect page for the apps.** The same `/connect` page also confirms the sign-in of the desktop app
(`/connect?session=…`, app sessions of FEDERATION.md §8 step 3): sign in there with any method, the page names the
app's device and, after "Sign in to the app", says "return to the app" instead of redirecting; a sign-in on the page
for such a confirmation skips the encryption step, because the app creates its own device keys. `method=passkey` (or
`sso`) starts that method at once with only "Signing in with a passkey…" and "Use another method"; `method=register`
opens the registration. The confirmation of a sign-in needs a fresh proof of the account (PROTOCOL.md §5c): a sign-in
on the page a moment ago counts; a page that was already signed in asks for it, with `method=passkey` through the
passkey itself (one touch confirms and unlocks), otherwise in the usual confirmation dialog. After a passkey ceremony
with the PRF extension the page seals the passkey's unlock secret to
the app's key from the URL fragment (`#k=`, never sent to a server) and sends it with the confirmation, so the passkey
unlocks the app's encrypted messages as it does in the browser; an *unlock* request of a signed-in app ("Unlock the
tavrn app?") asks only for the passkey ([DESKTOP.md](DESKTOP.md) "Signing in").

### Discover

"Discover" (the compass in the room rail) lists the public rooms and nodes the client's node knows from the peer
directory, in two tabs. **Rooms** can be searched by name or description and filtered by a minimum member count;
every room card shows the domain of the node that hosts it, and joining a room of another node opens a federated
session there. **Nodes** can be searched by domain, name or description and show the registration mode, the security
check result, the number of listed rooms, when the node was last seen and "Show rooms". The client checks the listing
each hosting node signed for its room and hides entries that do not verify (it says how many); entries a browser
cannot check are shown as "Signature not checked". **Report** on a room or node of another node sends the report to
the admins of your own node. Room owners list a public room under Room settings → Overview → "Listed in the
directory".

## Room rail and folders

The room rail (the narrow bar on the far left; inside the navigation drawer on phones) lists Home, your rooms, the
rooms of other nodes under their domain, "+" (create or join) and Discover. Home has its own unread dot for direct
messages; the domain of a node that cannot be reached turns red with a "node offline" tooltip. Once their channels'
counts are known, rooms show a mention count (red, bottom right); without mentions a room whose notification level is
"All messages" shows its unread count there (neutral grey, capped at "999+"), and a room with "Only mentions",
"Nothing" or a mute keeps the unread dot (top right). "All messages" is the default level of nodes that store
notification settings; on nodes without them the client's own default is "Only mentions". Voice activity is a badge
top left (see "Voice activity in the room rail and the friends list"). Rooms can be grouped into **folders**:

- **Create**: right-click (long press on touch, the context-menu key or Shift+F10 on Home, + or Discover) on the empty
  rail → "New folder…" asks for a name (up to 32 characters; without one the folder is named after its rooms) and an
  optional colour (teal, blue, violet, rose, amber, green or none). A room's menu offers "Move to folder ▸" with the
  folders, "New folder…" (a folder with that room) and "Remove from folder"; "Move up" / "Move down" reorder rooms
  and folders.
- **Folder menu**: "Rename…", "Colour ▸", "Expand"/"Collapse", "Move up"/"Move down", "Delete folder" (its rooms
  return to the rail at the folder's place; no room is left).
- **Drag and drop** (mouse): a room dropped onto another room makes a folder of both (as on phone home screens), onto a
  folder adds it, onto the empty rail takes it out of its folder; dropped onto the upper or lower edge of an entry it
  is placed before or after it (an accent line shows where). On touch nothing is draggable; every drag action is also
  a menu entry (WCAG 2.5.7).
- **Display**: a collapsed folder is a rounded square with up to four mini icons on its colour; a click expands it
  inline (its rooms follow on a slightly lighter background) and collapses it again. A collapsed folder shows the sum
  of its rooms' counts (a mention count wins over the unread count of its "All messages" rooms, which wins over the
  unread dot), the voice badge of its rooms and the selected ring while it holds the open room. Rooms of several nodes
  can share a folder; their names carry their domain. A room you leave (or one its node no longer lists) leaves its
  folder; rooms of a node that cannot be reached stay where they are.
- **Accessibility**: the rooms stay links in a list ("Your rooms"); a folder is a disclosure button (`aria-expanded`,
  `aria-controls`) whose accessible name holds its name, the number of rooms, the mention or unread count, the voice
  activity and "contains the open room"; a room's accessible name is its name followed by its counts and voice
  activity ("Raids, 12 unread, 3 in voice, someone is streaming"). ↑/↓, Home and End move through the rail, →
  expands a folder or enters it, ← goes back to the folder or collapses it, Enter and Space toggle it.

Storage: folders are a per-account client setting kept in this browser (local storage `tavrn.rail:<account address>`;
at most 100 folders, 200 rooms per folder and 1000 order entries). The shape is ready to be synced through the home
node, which does not happen yet:

```json
{
  "clientStateVersion": 1,
  "folders": [{ "id": "f3a…", "name": "Raids", "color": "violet", "roomIds": ["home.example/01J…", "other.example/01K…"] }],
  "order": ["home.example/01H…", "folder:f3a…"],
  "expanded": ["f3a…"]
}
```

Room keys are node-qualified (`<domain>/<room id>`); `order` lists the top-level entries (rooms of the home node and
folders; rooms of other nodes outside folders stay under their domain), rooms the order does not know yet are appended
in the node's order; `expanded` is device state. A newer `clientStateVersion` than the client knows is ignored (the
rail shows no folders) instead of being misread.

## Voice activity in the room rail and the friends list

The client knows who is in which voice channel of every room you are in, not only of the open one: at start, after
every reconnect and resync it loads `GET /users/me/voice` (VOICE.md §5) from the home node and from every node with a
federated session, and `voice.state` events keep it current. The node only reports channels you may view, so nothing
here ever reveals a hidden channel; rooms you are not in are never shown either.

- **Rail badges**: a room with somebody in voice gets a small speaker badge in the top left corner of its icon
  (green); while somebody shares a screen it becomes a monitor (amber). The unread dot (top right) and the mention or
  unread count (bottom right) stay. A collapsed folder shows the badge of its rooms. The item's accessible name says
  "3 in voice" and "someone is streaming".
- **Room card**: resting the mouse on a rail room for 300 ms, or moving the keyboard focus onto it, opens a card to the
  right of the rail: the icon, name (and node), member count, online count (when the member list was loaded),
  description, the unread or mention state ("Nothing new" without either) and who is in which voice channel (avatars
  grouped under the channel name, at most eight, then "+n"; a small monitor marks who streams). The card stays open
  while the pointer is over it and closes with Escape, when the focus leaves the room or the pointer leaves both. On
  touch devices there is no hover: the long press on a room opens its menu with the card's content as a
  non-interactive head above the entries.
- **Friends list**: a friend in a voice channel you can view shows "In voice: \<room> / \<channel>" under their name;
  their menu then has "Join \<channel>" (see "Friends, direct messages and invitations"). A friend in a channel you
  cannot view, or in a room you are not in, shows nothing. Neither does a friend whose presence is offline: someone
  who chose "invisible" stays offline in the friends list while in voice (the channel's own list still shows them
  to everybody who can view it).

## Friends, direct messages and invitations

**Friends** live under "Friends" on the Home view: a form sends a friend request by address, with an optional message
the other side sees as a quote; incoming requests offer Accept, Decline and Block, outgoing ones Withdraw; every
section shows its count, and blocked users are listed with the private note given when blocking (also under Settings →
Privacy & safety). Each friend has Message, Remove and Block next to a menu (right-click, long press or the "⋯"
button) with "Join \<channel>" while they are in voice, which opens the channel and joins it like a click in the
channel list (errors such as a full channel or a missing permission come as the same messages), "Invite to room",
"Message", "Remove" and "Block".

**Direct messages and group DMs** are listed on the Home view with their node's domain where it is another node.
Settings → Privacy & safety → "Who can message me" decides who may start one (friends only, friends and people in
shared rooms, or everyone, within what the node allows); messages of people who are not friends wait under **Message
requests** until they are accepted.

### Inviting friends to a room

The friend menu and the member menu (member list, message authors) have a submenu "Invite to room" with your rooms on
every node you are signed in to where you may create invites (owner, administrator or `create_invites`, from the room
details the client loads when the menu opens). Rooms the person is known to be in are left out (the current room in a
member menu, rooms whose member list is loaded); the submenu is missing when no room is left, and bots never get it.
Choosing a room sends a direct invite (FEDERATION.md §3.4: single use, bound to the address, valid for 7 days) and
closes the menu; a toast confirms "Invitation to \<room> sent to \<name>" or shows the node's refusal (already a
member, banned, too many invitations). The invitation appears live in the recipient's invite list on their home view,
with "Accept" and "Dismiss", on every node and on phones too, and a toast "Invitation to \<room> from \<inviter>"
tells them.

## The sidebar and the channel list

The sidebar has three bars. At the top, the **room header** is one button (room icon, name, chevron ⌄; rooms of other
nodes show their domain below the name) that opens the room menu: "Invite people" and "Room settings" first, then mark
as read, notifications, copy ID, report and leave; moderators see the number of open reports as a badge on the
chevron and next to "Room settings", which then opens the report inbox. Above the account bar sits the **voice bar**
while connected ("Voice channels" below). At the bottom, the **account bar** holds the avatar with the account menu
(presence, custom status, activity, legal pages, sign out with a confirmation and, for node admins of the home node,
"Node administration"), the own name with the connection state below it (the full address when signed in with an
account of another node), the notification bell and the user settings. On phones the bell is in the top bar instead,
so there is always exactly one. Node admins also find "Node administration" at the top of the settings navigation.

**The channel list** shows each channel with its kind (# text, 📣 announcement, 🗂 forum, 📁 files, 🔊 voice, 👋 the
welcome channel) and an SVG lock next to the kind icon: closed for end-to-end encrypted channels (all voice channels),
open in the warning colour for plaintext channels; the welcome channel has none. Channel headers show the same lock.
After the name come the unread badges, a bell-off mark on muted channels, the access marks (below), the bot markers
"No bots" and "Bots can read this encrypted channel" and the "18+" badge of gated channels. Voice channels list who is
in them, also outside the call, with mute, deafen, camera and screen icons and the user limit as `3/5`.

The sidebar lists only the channels the user may view, and a category only when one of its channels is visible
(channel managers also see empty ones). The node sends a private channel's events only to the members it is listed
to: a member who gains a channel gets `channel.create`, one who loses it `channel.delete` with `hidden: true`
(PROTOCOL.md §6). The client then drops the channel from the sidebar like a deleted one, but an open channel says
**You no longer have access to this channel** instead of "Channel not found", and the channel's local search entries
stay (`web/src/lib/hiddenChannels.ts`).

Room changes reach the list without reloading the room: the answers of the settings' saves and the payloads of
`channel.*`, `category.*`, `role.*`, `override.update` and `room.update` are written into the cached room
(`web/src/lib/roomCache.ts`, `web/src/hooks/roomEvents.ts`). Only changes of a role the viewer holds (or `@everyone`),
the viewer's own membership and a new owner fetch the room again (the node computes the viewer's room permissions),
once per burst of events. The list
evaluates the layered permissions once per room version: one map of permissions and access marks per channel.

### Channel list marks

Besides the encryption lock (which never means anything else), two SVG marks after the channel name tell who may use a
channel (`web/src/lib/channelPermissions.ts`, `AccessMark` in `web/src/components/Badges.tsx`):

- **Private** (a group with a slash, the same for everyone who sees the channel): the `@everyone` role has no effective
  `view_channel` there, evaluated like `channelPermissions` but for `@everyone` alone (its role bits, then the
  category's and the channel's `@everyone` overrides; other roles' and members' overrides are ignored): **Visible only
  to certain roles**. A voice channel `@everyone` may view but not `connect` to: **Joining only for certain roles**.
  The welcome channel is never private.
- **Restricted for you** (no entry, per viewer): the viewer sees the channel but lacks the bit the channel's view needs:
  `connect` for voice (**You can see this channel but not join it**), `send_messages` for text, announcement and forum
  channels, `attach_files` for files channels (**Read only for you**). The name is dimmed (`fg-2`; the open channel
  keeps `fg-0`); the row stays clickable and the stage or composer explains the rest. A voice row without `connect`
  opens the stage without trying to join. Members with the rights see nothing.

When both apply the private mark comes first. Each mark is a named image with the same text as its tooltip; the voice
row's accessible name repeats them. The channel editor in **Room settings → Channels** shows the private state as a
line under the channel name (and the mark in its channel list), so admins see what their overrides do.

## Messages and the composer

**Formatting** is Markdown with line breaks (`lib/markdown.ts`): bold, italic, strikethrough, inline code, links (they
open in a new tab; http, https and mailto only), lists, quotes and headings up to level three; raw HTML is never
rendered, and nothing edits the sanitized HTML as a string afterwards (emojis and mention badges are applied to its
text nodes). Names and file names are shown without Unicode bidi controls and isolated from the surrounding text, so
they cannot display in a misleading order. Code blocks show their
language, are highlighted and have "Copy code" and "Wrap long lines" buttons. Custom emojis (`:name:` of the room,
`<:name:ID>` from other rooms and nodes) render as images. **Spoilers** `||text||` (inline, also in quotes and lists)
stay hidden until clicked or activated with Enter or Space; the composer's spoiler button and Ctrl+Shift+S wrap the
selection, and every attachment can be marked as a spoiler, which covers images and videos until "Spoiler, click to
reveal".
**Emoji sizes**: Unicode emojis in message text are rendered at 1.25× the text size, aligned to the baseline without
changing the line height; a message that consists of one to three emojis (Unicode or custom, nothing else) shows them
at twice the text size; reaction chips show an 18 px glyph next to the count at the chip's usual height. Symbols that
render as text by default (©, ↔) stay text. **Country flags** on platforms whose emoji font has no flag glyphs
(Windows shows "DE" for 🇩🇪): at start the client draws a smiley and a flag on a canvas; when the smiley renders as a
colour glyph but the flag does not, it registers a bundled flag-only font (`lib/flagEmoji.ts`, the Twemoji country
flags of `country-flag-emoji-polyfill`, limited to the regional indicators and tag characters) and marks the document
(`<html data-flag-font>`), which puts that font first for messages, reactions, the emoji picker, status lines and the
composer; every other emoji keeps the platform's font. The font is served with the client, never from a CDN.
**Mentions** in rendered messages are pills (`.mention` with `data-mention` = self, user, bot, everyone or role):
`@name` and `@name@domain` of the message's mentions list, `@everyone`/`@here` when the message mentions everyone, and
the room's role names, only in text outside code. Mentions of yourself and `@everyone`/`@here` use the warning colour
with a border, other mentions the accent colour; a message that mentions you keeps its left border with a stronger
tint.

**The composer** has the emoji picker, a GIF picker on nodes with a GIF provider (in encrypted messages the client
itself accepts only the providers' media hosts), uploads by button, drag and drop or paste ("Uploads and downloads"),
mentions (`@name`, `@name@domain`, `@Role` of mentionable roles, `@everyone`) and slash commands with a palette
(argument hints, arrow keys, Tab or Enter): `/help`, `/me`, `/shrug`, `/poll`, `/whiteboard`, `/nick`, `/topic`, `/slowmode`,
`/kick`, `/ban`, `/timeout`, `/mute`, `/unmute`, `/move` and `/purge` (each only where the member may use it), plus
the commands of installed applications. The emoji picker (composer, message reactions, sound emojis) has a fixed size
(bounded by the viewport) and opens below its button or above it when there is no room; the grid scrolls inside, and
the space is reserved while the emoji data loads, so the panel never grows out of the viewport. Photos lose their
location, camera and time metadata on the device before the upload (Settings → Privacy & safety → "Image metadata":
always, the default, ask or never; HEIC/AVIF images and videos cannot be cleaned, and videos with a location ask
before uploading). **Link previews** are made when sending (Settings → Privacy & safety → "Create link previews when
sending"): the home node loads the page, the preview travels with the message (encrypted with it in encrypted chats),
and readers never load anything. Because the home node learns every link it loads, end-to-end encrypted conversations
make previews while typing only with **"Fetch link previews in encrypted conversations"** switched on (off by default;
the device-local setting `encryptedPreviews` in `tavrn.privacy.content`); plaintext channels keep the default above.
Typing indicators are not sent while the status is "invisible".

**Messages** get reactions, replies, inline edits (marked "(edited)"), pins (the channel's "Pinned messages" panel) and
threads. Links to YouTube, Twitch, Vimeo and Spotify become click-to-play embeds (Settings → Privacy & safety →
"Embeds": a thumbnail and play on click, play on click without a thumbnail, or off); nothing loads before the card is
on screen, the player only after a click. Message authors are shown like the member list everywhere: in rooms the
nickname or display name with the role colour, in DMs and group DMs the members' display names (as in the header),
otherwise the address. A message from a device its user retired carries a small "retired device" note.

**The "unverified" marker.** Plaintext messages carry the author device's signature (FEDERATION.md §10.3). A plaintext
text message of a person whose signature is missing or cannot be checked gets a small "unverified" marker, because the
hosting node could have written it; the tooltip says which of the two. A message without any `device_id` counts as
unsigned. A wrong or reused signature hides the content, and the bytes of a plaintext attachment are checked against
the SHA-256 the message carries (and its signature covers): a file that does not match is not shown or saved. Messages
the node itself vouches for as application content get no marker: webhook messages (WEBHOOK badge) and unsigned
messages of bots, which post with an app token the node authenticated and carry the BOT badge (many bots use the REST
API without a device key). A bot signature that cannot be checked is marked like anyone's. System messages get no
marker, and encrypted messages are checked by the encryption instead.

**Plaintext in encrypted conversations.** In a DM, a group DM or an encrypted channel every message is encrypted by its
sender, so a plaintext message there (except the node's own system entries) can only come from the node. It is never
shown as content: the row reads "This message was not end-to-end encrypted and may not come from the sender", its
attachments are hidden, and reply references, screen reader announcements, notifications and push notifications say
"Message not end-to-end encrypted" instead of its text. A plaintext edit of an encrypted message is treated the same.

### Polls

Polls and date polls ([PROTOCOL.md §7g](https://github.com/just-tavrn/tavrn-protocol/blob/main/PROTOCOL.md)) work in
text, announcement and forum channels, threads, DMs and group DMs on nodes that announce `polls.v1`. The composer's
**＋** button opens a menu with **Attach file**, **Poll** and **Date poll**, and `/poll [question]` opens the poll
composer with the question filled in; both appear only for members with *Create polls* (`create_polls`, granted to
`@everyone` in new rooms; DMs and group DMs always). In encrypted channels the node cannot see that a message is a
poll, so this client enforces the bit there (the node enforces it for plaintext polls and every poll with a close
time).

**The poll composer** (`polls/PollComposer.tsx`) asks for the question (up to 300 characters) and the kind:

- **Poll**: 2 to 20 options (up to 100 characters each; Enter adds an option below, Alt+↑/↓ or the arrow buttons move
  one, × removes one), single choice or "Allow several answers" with "At most n".
- **Date poll**: a month calendar (a date grid: one tab stop, arrow keys between days, Home/End, Page Up/Down by
  month, Enter or Space selects; several days; past days cannot be picked). Every selected day is **All day** or has
  one or more times (start, optional end); up to 60 slots. Times are entered and stored in the creator's time zone
  (RFC 3339 with its offset, the zone is named under the calendar).
- **Show results**: always, after voting or after the poll closes. **Votes**: public (who voted for what) or hidden
  until the poll closes. Both are kept by every member's app but are not anonymity: the composer says so.
- **Closes**: no end (default), 1 hour, 1 day, 1 week or a picked date and time (a minute to a year ahead). The close
  time is plaintext on the message (`poll_closes_at`), so the node refuses late votes.

Validation names every problem at its field (empty question or option, duplicate options, too many options or slots,
a day without a time, an end before its start, a time that has passed, a close time out of range) and the dialog
stays open with the node's message when sending fails.

**The poll in the message list** (`polls/PollView.tsx`) shows the question, the kind ("Poll", "Multiple choice", "Date
poll"), "Closes in …" (the exact time on hover) or **Closed**, and the number of votes. It has two views
(`polls/grid.ts`, `pollMode`): members see the **vote form** until they voted and the **results** afterwards (right
away: the own vote is applied before the node confirms it). **Change vote** returns to the form prefilled with the own
vote (choice: the own options checked; date: the own yes / maybe / no per slot); **Keep** and **Save** return to the
results (saving an unchanged vote sends nothing), **Retract vote** stays in the form and leaves the empty form. A vote
the node refuses is rolled back and the form stays open with the choice. Before voting, **Show results** looks at the
results (when they are visible) and **Vote** goes back. Closed polls and members who cannot vote see the results only,
without **Change vote**.

- **Choice polls**: the form lists the options as radio buttons or check boxes (44 px rows), with the bars, counts
  and shares while the results are visible. The results keep the bars, counts and shares and, with public votes, the
  voters' names ("and n more" expands them); the own vote is marked with a filled ✓, a thicker accent border, bold
  text and "Your vote", in the form too.
- **Date polls**: the form groups the slots by day (the viewer's time zone, with the creator's time when the offsets
  differ; all-day slots keep the creator's date), one line per slot with Yes / Maybe / No (44 px, text and icon,
  never colour alone). The results (`polls/DateResults.tsx`) stay compact with many slots: the best slots (most yes,
  then most maybe) are summarised on top (up to three with their counts, "and n more equally good"), then a grid with
  the days as columns and the times as rows (all day first). Every slot is one cell with ✓ yes and ? maybe counts, a
  totals bar (yes, maybe, no of all votes), ★ for the best slots and the own answer as a badge with its icon; a legend
  explains the marks. The grid is one tab stop (arrow keys between slots, Home / End) and Enter, Space or a click
  opens the slot's answers below it (each answer with its count and, with public votes, the names; the cell's tooltip
  lists the names too); its accessible name says the slot, the counts, "best date" and the own answer. On phones the
  grid scrolls sideways inside the poll with the times sticky. **Show all answers** adds the table of members ×
  slots. With the results hidden the cells show the own answers only.

Hidden results read "Results are shown after you vote" or "… when the poll closes", hidden voters "Who voted for what
is hidden until the poll closes". The author, or a member with *Manage messages*, can **Close poll now** (after a
confirmation), also a poll without a close time; a close time only ever moves earlier. The author always sees the
results of their own poll, also with "after voting" before they voted. Polls cannot be edited.

**Votes** are records next to the message, one per member and poll (`polls/votes.ts`): loaded when a poll is shown
(`GET …/poll/votes`), kept current by `poll.vote` and `poll.vote.delete`, never counted as unread and never notifying.
In encrypted conversations a vote is encrypted and signed by this device under the current epoch like a message
(the ghost check applies; a stale epoch is caught up once and sent again); in plaintext ones it carries this device's
plaintext signature. The own vote shows at once and is rolled back when the node refuses it; another device's later
vote replaces it (the last device wins). Every record is checked with `@tavrn/e2ee` (`checkPollVote`, `tallyPoll`):
signature against the voter's device, bound to this poll (`ctx.poll`) and to exactly this version of it
(`ctx.poll_hash`, SHA-256 of its JCS form). Votes of an earlier version are not counted and shown as "n on an
earlier version (not counted)" (and "You voted on an earlier version" for the own one), unverifiable ones as "n could
not be verified", votes after the close time not at all; plaintext votes without a signature this device can check
count and are listed as "n unverified". A member who cannot decrypt an encrypted poll with a close time (it is older
than their history) sees "Poll from before you joined" with the number of votes.

### Media and image previews

Images open a viewer (zoom, drag, swipe or arrow keys between the images of a message, download icon, open original);
audio attachments get an inline player and videos play inline and enlarge into the viewer. Downloads only start from
the download icon. SVG files are never shown inline or opened, only downloaded (they can carry scripts). **Settings →
Privacy & safety → Image previews** decides which images load by themselves: always, only from friends and members of
shared rooms (default; in rooms every member counts) or never; images larger than the node's
`TAVRN_PREVIEW_AUTO_MAX_BYTES` (default 5 MiB) always wait. The others show a placeholder with name, size and a
**Load** button (and "Load all" for several in one message); nothing is fetched before. GIFs in messages come from the
GIF provider's servers and follow the same setting (a placeholder with **Load** otherwise); they load without a
referrer. "Open original" is offered only for concrete image and video types; anything else is only downloaded.

### Threads

Threads ([PROTOCOL.md §7e](https://github.com/just-tavrn/tavrn-protocol/blob/main/PROTOCOL.md)) are
sub-conversations of a text or announcement channel. **Create thread** in a message's menu asks for a title
(prefilled from the message), **Reply in thread** opens the message's thread or starts one with that title. A message
that started a thread shows "N replies · last reply …" with the most recent writers' avatars; a click opens the
thread. The 🧵 button in the channel header lists the active and archived threads with unread counts and starts
standalone threads. A thread opens in a panel next to the channel on tablets and desktops (drag its edge, or use the
arrow keys on it, to resize; the width is remembered on this device) and full screen with a back button on phones;
Esc closes it, and every thread has its own link (`…/channels/<channel>/threads/<thread>`).

The panel is the channel's conversation in thread mode: encryption, reactions, uploads, mentions, `/me` and the other
slash commands work there as in the channel (application commands invoked there name the thread, so the bot answers
in it), and in encrypted channels the title is encrypted with the channel's messages. Its header follows or unfollows
the thread and, for its creator or members with *Manage threads*, renames, archives, locks or deletes it. Starting or
writing in a thread follows it; only followed threads count towards the channel's unread badge and raise
notifications (direct mentions always do). The client loads the followed threads of every room once it is connected
(one room after the other in the background, at most 100 rooms per node, again after a reconnect at most once a
minute) and keeps them current over the WebSocket, so this works for rooms not opened since the start as well; a
thread started on another device is followed here at once.

### Forum and announcement channels

Forum channels show posts instead of messages: cards with title, tags, author, replies, last activity and the start of
the first message, tag filter chips, "Latest activity" or "Newest posts", archived posts on demand and **New post**
(title, message, up to five tags). Where the node announces `threads.client_ids` the client picks the post's id, so the
device signature of the first message covers it like every reply and readers see no "unverified" marker; a node that
refuses the id (this device's clock is far off) gets the post with an unsigned first message. Their tags and the
auto-archive time of every channel's threads are set in the room settings under *Channels* (*Manage channels*).
Webhooks (room settings → *Webhooks*) can post into forum channels too; the settings explain that every payload then
names a post with `"thread_id"`.

In announcement channels only members with *Manage messages* post; the others see a notice instead of the composer
and react or reply in threads.

## Encrypted conversations

Each channel, DM and group DM is an MLS group
([`@tavrn/e2ee`](https://github.com/just-tavrn/tavrn-js/tree/main/e2ee), `src/mls.ts`): the first device that opens a
conversation creates it, further devices join by external commit, DM and group members' devices are added with a
Welcome. Message content and attachments are encrypted and signed in the browser, the node only stores ciphertext.
Every device the client meets is checked against the user's identity key (pinned on first use); a changed key shows
"Security key changed", and a device in a conversation that is not a member or not confirmed by its user's key shows a
warning and blocks sending until acknowledged. Content keys are backed up encrypted on the home node so that a new
device unlocked with the recovery key reads the history. Verified contacts carry a "verified" chip next to the author
of a message and in conversation headers, and a small shield icon (named "verified", with a tooltip) in member lists,
where names keep the width. The pinned keys, the verified contacts and the account's own
devices travel with them as an encrypted trust record (ENCRYPTION.md §7): after signing out and in again (a new
device) a contact whose key changed meanwhile still shows "Security key changed", and verifications stay.

**Unknown devices** (ENCRYPTION.md §4.6). Every encrypted write path checks the roster first: messages and their edits,
thread titles and renames, forum posts, file and folder records of files channels and whiteboard scenes. Conversations,
forums, files channels and whiteboards show the unknown-device warning with an "I understand" button, and nothing is
encrypted in that conversation until the user pressed it; the session manager itself refuses to encrypt while a
device in the roster is not acknowledged, so a view that missed the warning cannot send to the device either. An
acknowledgement covers that device's key: a device that appears later blocks again, also one under an acknowledged
device id with another key. Devices are added to DMs only from KeyPackages whose key is exactly the device's
confirmed key, and the cleanup of the user's own stale devices confirms a device as retired only when the account
recorded that device key itself (anything else is removed without a confirmation; messages of a lost device the
record does not know then stay unverifiable).

**Changed security keys** (ENCRYPTION.md §3.3). Until the user acknowledges the "Security key changed" badge (in the
member list or next to the author; acknowledging asks for confirmation) or verifies the new key, the contact's devices
under the new key do not count: DMs and group DMs do not add them, and in channels their leaves show in the
unknown-device warning ("its user's security key changed and you have not confirmed the change yet"), which blocks
sending like every ghost. Acknowledging adds the missing devices and checks the roster again at once. Rotations signed
by the previous key (§9a) are not held back.

**Sending** (ENCRYPTION.md §5.2, §5.3). Before encrypting, the client processes the commits it has not seen yet; if
that fails, nothing is sent and the composer keeps the text with an error to try again. If the commits brought a
device nobody was shown yet, sending stops as well and the unknown-device warning has to be acknowledged again (for
that device). A
message's thread and reply are signed inside its encrypted content, so a message the node moved to another thread or
another reply target shows as "Moved message (signature does not match)" instead of its content. When the node
answers that the epoch is stale (`mls.epoch_stale`), the client catches up and encrypts once more.

### Several tabs

All tabs of one browser profile share the account's MLS state (one IndexedDB store). One tab owns it: the first tab
that opens the account's session manager holds the Web Lock `tavrn-mls|<home node>|<address>/<device>`
(`src/stores/mls.ts`, `@tavrn/e2ee` `src/tabs.ts`), runs every join, catch-up, commit and encryption and alone writes
the state. The other tabs read from a copy that follows the owner's writes (decryption, rosters, voice keys) and send
everything that changes the state to the owner over a BroadcastChannel of the same name; the owner also passes on the
epoch changes their views wait for. When the owner tab closes or signs out, the next tab takes the lock over, loads the
state from the store and runs the calls that were in flight once more. Without Web Locks or BroadcastChannel every tab
works alone (a second tab may then have to rejoin after an invalid commit). The desktop app has one window, which
always owns the state. New KeyPackages (topped up at every start) are created in the owner's state too.

### Whiteboard drafts

The owner's unsaved board of a conversation is kept in the local encrypted store under a name derived with the
device's search key (`whiteboard-draft:<HMAC>`), so the store's record names do not reveal which conversations have a
board; drafts under the old name (with the conversation id) are moved on first read.

## History

History is lazy: a conversation's pages are dropped when it closes, and the local search index keeps text and file
names of the last 90 days.

**Keep the full history on this device** (the menu of an encrypted channel, DM or group DM; default off) keeps the
conversation's whole history here instead: the background sync pages it back to the start, the search index keeps all
of it, and the messages with their decrypted content stay in an encrypted local archive (IndexedDB `tavrn-history`,
sealed with keys derived from this device's local storage key, so it locks with the device and reveals no ids or text;
`web/src/history/`). The message list then uses the archived content instead of decrypting again and reads from the
archive while the node cannot be reached. Each conversation may take up to the space set under Settings → Privacy &
safety → Local search index (default 50 MB; the oldest messages go first); the menu entry shows what it takes, the
settings the total. Turning the setting off, clearing the index or signing out (which wipes the device) deletes the
archive.

### History for new members

The channel setting (channel settings → History for new members; ENCRYPTION.md §7b; `web/src/crypto/history.ts`,
`web/src/crypto/groupJoins.ts`) decides what a member gets from before their room join: nothing (`since_join`, the
default of text, announcement and forum channels), the last days or everything. Everything posted since the join is
always readable, also in channels the member opens only later: a device enters a channel's encryption group only once
it is there, and the messages in between need keys from other members. The client therefore joins the groups of a
room's encrypted channels (text, announcement, forum and files) as soon as the room is loaded on an unlocked device,
one after the other with a short pause, so that gap is usually empty. Otherwise an online member's device shares the
missing keys automatically (under every setting, also `since_join`); until they arrive the channel shows "Older
messages are being unlocked…" at the top and the messages and forum post titles in question as not readable yet, and
they open as soon as the keys are there. With no other member online the keys come when one is back. Nothing from
before the join is ever shared under `since_join`: the node does not serve those messages to the member, and the
client accepts a key only after checking it against a message it was served.

### History after a key reset

A member who reset their security key keeps their rooms but not the encrypted history from before the reset
(ENCRYPTION.md §7b, capability `history.restore`; `web/src/history/restore.ts`), and other members' devices never
send those keys automatically: the sharing code (`HistorySync` in `@tavrn/e2ee`) shares only epochs after the reset
epoch with a waiting member who has `key_reset_at`, and with older nodes it takes the reset time from the member's
keys document (`identity_reset_at`, `src/crypto/history.ts`) so that it cannot be tricked into sending the old range.

In such a room the member sees a banner in every encrypted channel (and in the file browser of encrypted files
channels) that explains it and asks the room's moderators to restore the history, with an optional message, the
request's state, "Withdraw request" and, after a denial, the reason and "Ask again". Members with **Restore history
after a key reset** (`restore_history`, owner and administrators by default) get a notification and handle the
requests under Room settings → History requests: the requester, their join and reset dates, the message, every
encrypted channel the requester may read (text, announcement, forum and files channels) with the window and the epochs
this device would send, and a warning when this device lacks some keys. Approving needs the confirmation that the
person's identity was verified on another channel; the client then approves (telling the node whether the restore is
partial) and sends the keys from this device for every channel in which a device of the requester is in the group, and
reports what it shared, what was incomplete and what it skipped. Denying needs a reason, which the requester sees. The
welcome channel shows both decisions; the room's overview has the switch "Members may ask to restore their history".

### Share keys and sealed history shares

This is automatic; there is nothing for users to do (ENCRYPTION.md §3.1 and §7b "Format v2", capability
`history.shares2`). Every device has a share key next to its device key and publishes it with its attestation
(devices attested earlier publish it once on their next start). Where the node hosting a channel announces the
capability and every device of the recipient that is in the channel's group has a share key that verifies with its
attested device key, the history keys for a new member (and the keys of an approved restore) go out sealed to exactly
those devices, so no other member could read them; otherwise the client falls back to the older format. Received
shares are accepted only with this device's own box. Encrypted thread titles name their thread in the signed content
(the client picks the thread id where the node announces `threads.client_ids`, renames always), and the answers of
bots name the interaction they answer: a title or answer the node moved elsewhere is shown like anything else that
cannot be read.

## Files channels

A files channel (kind `files`, [FILES.md](https://github.com/just-tavrn/tavrn-protocol/blob/main/FILES.md)) is a file
browser (`web/src/files/`): breadcrumbs, list and grid views, sorting, uploads by button or drag and drop with
progress, folders, rename, move (dialog or dragging, with a non-drag equivalent), delete, download, media in the
viewer, the context menu and keyboard navigation. Uploads follow the room's file types ("File types" below).

Where the node keeps no files of a room's files channels itself (`TAVRN_FILES_INTERNAL=off`, FILES.md §5;
`files_internal: false` in `GET /node`, or the room's entitlement `files_channels.internal` set to 0), a channel
without an external store reports its store as `none`: instead of "Upload" and "New folder" the toolbar shows "Choose
a store first", a link to the channel's storage settings for members who may configure it (*Manage channels* and
*Manage files*) and a plain note for everybody else, and the empty folder explains why. The storage settings start on
WebDAV and offer "This node" only where the room may use it: `internal_allowed` of the channel's files usage, the
room's `files_channels.internal` (a plan of the room owner can allow the node's storage on a node whose default is
off); older nodes without the field use `internal_allowed` of `GET …/files/backend`, their node default. Elsewhere
the storage settings name the reason; once a store is saved the upload button appears.

The storage settings of an external store have "Limit on the store (GB)": how much the channel may keep there (empty
or 0 = no limit, a comma or a point as decimal separator; anything else blocks saving with the reason). It is sent as
`max_bytes` with the store (FILES.md §5), and the channel's meter shows it as the limit; the node's own quota never
applies to external stores.

### End-to-end encrypted files channels

Files channels are end-to-end encrypted by default (FILES.md §8): the "Create channel" dialog has "End-to-end
encrypted" ticked for files channels, with the consequence on one line, and such a channel uses its MLS group like a
text channel (`files/e2ee.ts`). Uploads are encrypted in 1 MiB chunks in the browser (one chunk in memory at a time)
with a fresh file key; raster images get a client-made thumbnail (at most 320 px, WebP or JPEG) encrypted with the same
key; name, type and key travel in the entry record, encrypted under the channel's current epoch by the tab that owns
the MLS state. Browsing decrypts the records of the listed folder (names, types, folder names; the header shows the
SVG lock), downloads and previews decrypt chunk by chunk, and media keep their safe blob types (SVG is never
rendered). The node cannot search: the search box filters the open folder, and the global search finds the files
through the local index ("Search" below). The node cannot check name uniqueness either, so the client numbers
duplicates (`name (2).ext`) before it uploads and refuses a rename to a name the folder has. While the channel's
encryption group is still joining on this device, the "New folder" and "Rename" dialogs keep their button disabled
and say so; the name stays typed and the button opens as soon as the view is ready.

Entries this device cannot decrypt are listed as "Encrypted file"/"Encrypted folder" with size and date; the channel
shows the same states as the message list: "locked" (key store locked), joining, no group yet, an error, or "some
entries cannot be decrypted yet" (keys of older epochs missing, which history shares may fill). **Your files**
(toolbar; in place of the browser while the device is locked) lists the member's own uploads and folders by ownership
alone (`GET …/files/mine`: counts, sizes, dates, no names) with single and bulk deletion, so lost keys never keep
files on the node. History for new members follows the channel's setting, which for files channels is "all" (the
default) or "since join"; keys are checked against entry records instead of messages, the same way after a key reset
(only records since the reset) and for a restore request (the window's oldest record).

The channel settings show the encryption as fixed ("cannot be changed: create a new files channel and upload the files
again"); external stores of encrypted channels need no `encrypt_files` (they only receive ciphertext). Unencrypted
files channels keep the permanent "not end-to-end encrypted" banner.

### Deleting a files channel

Deleting a files channel asks for the channel's name and says what happens to its files: counts and size, where they
are ("stored on this node" / "stored on WebDAV at host"), and the consequence: "All files are deleted permanently", or
for an external store "The objects under \<prefix> are deleted from the external store" with **Keep the objects on the
external store** (only for unencrypted external channels, sent as `keep_external`); for encrypted external channels
the dialog explains that the objects are unreadable without the channel's keys and are deleted too. The room deletion
dialog lists its files channels the same way (`files/DeleteChannel.tsx`).

### Search

Every decrypted entry goes into the local encrypted search index (SEARCH.md §3.6: name and folder path as text, type
category, size, upload date, uploader, channel and room; thumbnails only by reference). The background sync pages
through the records of encrypted files channels this device has opened (`search/filesSync.ts`). Results appear in the
search panel under **Files** with name, folder, size, date, uploader and the thumbnail (fetched and decrypted on
demand); choosing one opens the folder with the entry selected. The filters gain "Type (files)"; uploader and dates
use the existing author and date filters. Deleted entries leave the index, results whose entry is gone are removed
when opened, and "Clear index" clears them with the messages; the 90-day window counts from the upload date.

## Uploads and downloads

### File types

Uploads are grouped into images, audio, videos, documents, archives and other files (PROTOCOL.md §7a,
[permissions.md](https://github.com/just-tavrn/tavrn-protocol/blob/main/permissions.md) "Upload categories").
**Room settings → Overview → Uploads** sets what everyone may attach (`@everyone`, the room default) and links to the
roles. In **Room settings → Roles** every role has **Allowed file types**: a list, or for roles other than `@everyone`
**Not set (inherit the room default)**, where the member's highest role with its own list decides, otherwise
`@everyone` (shown greyed); it is saved with the role, and only when it changed. The category and channel editors have
a **File types** block under the permissions with the same allow / – / deny choice per type, the inherited value in
grey, and the result for the selected role with the unsaved changes applied ("Result for Artists: Images, Documents";
`web/src/lib/uploadPolicy.ts` evaluates like the node). Programs and scripts additionally need the node's
`TAVRN_UPLOAD_ALLOW_EXECUTABLES`. The composer filters the file picker and refuses a file outside the policy before
anything is uploaded.

### Downloads

Every download of the client (attachments, files channels, the data export, recovery keys and codes, whiteboard
images) goes through one function, `saveFile` in `src/platform/saveFile.ts`: in the browser it is the browser's
download, in the desktop app the system's save dialog, after which the app says where the file went ("Saved to
Downloads", with **Show in folder**; DESKTOP.md "Downloads").

**Download warning.** Before an attachment, a file in the media viewer or a files-channel entry is saved, the client
checks the content about to be written (decrypted, for encrypted files) with the node's rules (`executableKind` in
`web/src/lib/uploads.ts`: magic bytes of Windows, ELF, Mach-O, Java class and DEX programs, `#!` scripts, shortcuts
and disk images; the node's list of dangerous extensions, which includes libraries and drivers, Java and mobile apps;
executable content types). For a program, script, installer, shortcut, disk image or macro document a dialog asks
first: **This file can run programs on your computer**, with the file name and the detected kind, **Cancel** (focused,
so Enter never downloads) and **Download anyway**; Escape cancels. Archives (zip, 7z, rar, tar.*) are not warned. The
warning is always on (`web/src/lib/download.ts`).

## Voice and video

Media is end-to-end encrypted with keys from the channel's MLS group: the client never publishes before LiveKit
confirmed encryption and refuses to join in browsers without insertable streams. LiveKit, RNNoise and the background
effects are only loaded once voice is used. The desktop app runs voice and video as the browser does, except where the
Tauri app uses its native voice engine ("The desktop app" below).

### Voice channels

The voice header carries two things next to the channel's name (VOICE.md §5, §2a): a **session timer** (`hh:mm:ss`
since the first participant connected to the empty channel, from the node's `session_started_at`, so late joiners
and members who only look at the channel see the same count; hidden while the channel is empty; its live region
announces the running time once a minute, not once a second) and the channel's **status** line under the name
("Raid at nine"). Members with *Set voice channel status* (`voice_status`) edit the status in place: click the
pencil or the text, type (at most 128 characters, a counter shows them), Enter saves, Escape or leaving the field
cancels; everybody else reads it, and `channel.update` brings changes to every member at once. The voice channel's
row in the channel list shows both in its tooltip (the status, then "Running for hh:mm:ss"), ticking while the
pointer or the focus is on the row. The room's role editor lists the permission in the voice group; a channel
override can grant it alone.

Clicking a voice channel joins it. While connected, the voice channel shows the stage: one tile per participant with
avatar or camera, a glowing border and level meter while someone speaks, screen shares and the whiteboard as tiles
of their own that are joined on demand ("Streams are joined" below; enlarge, picture-in-picture); phones get a
swipeable grid of four and a bottom control bar. Joined streams, camera tiles, the whiteboard and the whole stage can go full screen ("F" toggles,
Escape leaves) with mute, deafen, leave and exit at hand; iOS uses its native video full screen. On phones and
tablets a stream (or a whiteboard) wider than tall turns the screen to landscape in full screen (Screen Orientation API; browsers
without it, like iOS Safari, simply rotate with the device) and the lock ends with full screen; the full screen view
follows every rotation and fills the screen (the whole width and height, the video contained, no scrolling); the
stage keeps its layout while something is in full screen, so turning a phone past the phone breakpoint does not
drop the stream out of full screen. The voice bar at the bottom of the sidebar keeps mute, deafen, leave and
the connection quality at hand while you read text channels: its first line is the signal bars with a small padlock
(voice is always end-to-end encrypted; the tooltip names both, for example "Encrypted · connection good"), a short
status ("Connected") and the quality, the second line the channel and room. Joining the same account's voice on
another device ends it here with "Voice continues on another of your devices.".

Moderators open a participant's menu (right click or ⋯) to server-mute, disconnect or move them, drag people onto
another voice channel, or move everybody at once from a voice channel's menu (everyone in this channel, or everyone in
the other voice channels to this one; with a confirmation; the target's user limit holds); the target list offers
every voice channel the moderator may move into, also channels the member may neither view nor join (VOICE.md §7
"Moved participations"). A member moved into such a channel follows the move as usual: the channel shows up in their
channel list while they are in it (with the stage and the whiteboard), and disappears again when they leave; they
cannot rejoin by themselves. Everybody can drag their own row onto another voice channel they may join, which
switches to it (the same as clicking the channel; `connect` there decides, the node has the last word); while a
drag is over a channel it is highlighted, a channel that cannot take the drop (no `connect` for yourself, no
`move_members` for a moderator's drag) shows a red outline and refuses it, and the source channel is no target.
Everybody can set a per-person volume there. A dropped connection rejoins by itself
(after 0.5, 1, 2, 4 and then every 8 seconds, as long as the node's grace period keeps the seat, 45 seconds by
default); others see an amber plug on your avatar meanwhile
instead of you vanishing.

### Streams are joined

A screen share is opt-in: nobody receives it until they join it. A participant who shares shows up as a stream tile
with their name, the red LIVE badge and **Join stream**; until then nothing of the stream (video or its audio) is
transferred to this device. Joining (the button, a double-click on the tile, or a double-click or Enter on the member
marked LIVE in the voice channel's member list in the sidebar, which also opens the stage) receives the video and the
stream's audio; **Leave stream** (on the tile, or in the full screen controls) stops receiving it and the tile is a
placeholder again. Joining and leaving work any number of times without reconnecting. Several streams are separate:
joining one joins none of the others. The member list only joins from inside the same voice channel; elsewhere a
double-click says "Join the voice channel to watch the stream.". A stream that ends is forgotten: the next share of
the same person is joined anew. Cameras are not affected: a camera still replaces the participant's avatar by itself.

The sharer has no permanent self view: their share shows as a preview tile they can hide (and a double-click on
themselves in the member list brings it back), and a small "You are streaming" bar on the stage offers **Show
preview** / **Hide preview** and **Stop**.

In the Android app the screen is shared natively (the webview cannot): the same button opens a dialog with the
resolution, the frame rate and "Share the sound of other apps too" (off by default, Android 10 and newer), then
Android asks for its consent and the whole screen is shared until the user stops it in the "You are streaming" bar,
with the voice controls' button, or with **Stop sharing** in the notification Android shows meanwhile. The app
publishes the screen as the device's *screen publisher* (VOICE.md §4b), a second participant `<device>#screen` the
node lists with `screen_of`: everybody else sees it exactly like a browser's share, a stream tile under the sharer's
name that is joined on demand; it never shows up as a person of its own (no row, no tile, no count, no join cue), and
the sharer's own app shows no tile of it (the bar has no preview toggle then). It ends with the sharer's voice
session. Phones that watch are unchanged. Code: `web/src/voice/nativeScreen.ts` (start, keys, stop), the stream
mapping in `streams.ts` (`screenOwner`, `publisherStreams`, `streamIdentity`) and the presence store, which keeps
screen publishers apart from the people of a channel (`screensOf`); docs/ANDROID.md "Screen sharing".

The whiteboard of a voice channel (one per channel, "The whiteboard" below) is joined the same way. It is a tile of
its own next to the participants, never on the presenter's tile: every camera tile, the presenter's included, stays
as it is. Before joining the tile shows the board badge, "Whiteboard · <who started it>", the presenter's live
thumbnail and **Join whiteboard** (a double-click on the tile joins as well; so does a double-click or Enter on the
presenter in the member list, who carries a small board badge next to where LIVE would be, again only from inside the
channel; elsewhere "Join the voice channel to open the whiteboard."). Joined, the board fills a large tile with focus
(the board takes the whole stage), maximize, popout, full screen and **Leave whiteboard** (on the tile, in the
board's menu as "Leave session" and in the full screen controls), which returns to the placeholder, any number of
times. A joined whiteboard and a focused stream sit side by side (stacked on phones), the other tiles in a strip
below. The presenter's own board is a preview tile they can hide; a "Whiteboard is open" bar shows how many joined
and offers **Show preview** / **Hide preview** and **Close** (for everyone, after a confirmation). One person
presents either a screen share or a whiteboard.

In the browser engine (`web/src/voice/streams.ts`, `session.ts`) the room connects without LiveKit's auto-subscription;
microphones, cameras and every other track are subscribed as they are published, a screen share's video and audio
(`screen_share`, `screen_share_audio`) only while the stream is joined. The desktop app's native voice engine plays no
video and never subscribes screen shares at all; joining a stream there says that streams cannot be watched with the
native voice engine (docs/DESKTOP.md "Voice").

### Quick menus on mute, deafen and the camera

A right-click (the context-menu key, a long press on touch) on the microphone button of the voice bar or of the stage
controls lists the microphones (the current one checked), switches push-to-talk on or off (with the bound key as a
hint), has sliders for the input volume and, with voice activation, the activation threshold, and links to the voice
settings; the headphones button lists the output devices the same way with an output volume slider. A choice changes
the voice settings, so it applies live to the running call like a change in the settings tab. The menu stays open
after a choice and closes on a click outside, Escape or a second right-click on the same button; the arrow keys reach
the sliders. While the browser hides the device names the menu offers **Show devices**; browsers without output
device selection (`setSinkId`, missing in some Firefox builds and WebKitGTK) say so instead of listing speakers. A
click keeps muting and deafening.

The camera button of the stage controls and of the call view has the same kind of menu (`cameraMenu` in
`web/src/voice/deviceMenu.ts`). On phones and tablets (a coarse pointer) it offers **Front camera** and **Back camera**
(the front one by default; the choice is a voice setting, `cameraFacing`, so it is remembered on the device and drops a
camera chosen by id in the settings); the camera opens with the `facingMode` constraint. Desktops list the cameras as
Settings → Voice & video does, plus **Settings…**; desktops never send a facing, which would prefer an integrated
camera over the system default. A switch while the camera is on restarts the camera track with the new camera
(`switchActiveDevice` for a device, a restart with the new facing otherwise; a phone cannot open both cameras at once)
without leaving the call, the background effect stays on; a camera chosen while the camera is off applies when it
is turned on again. The back camera's own preview is not mirrored. A click keeps turning the camera on and off.

In the Android app the controls also have the **audio output** button (`web/src/voice/ui/AudioRouteButton.tsx`): its
icon and name show the route in use (speaker, earpiece, wired or Bluetooth headset), a tap opens the menu of the
connected outputs. The app decides the defaults and keeps the choice (docs/ANDROID.md "Audio output"); browsers and the
desktop choose the output device in the headphones menu instead.

### Mute and the microphone capture

A mute (also through deafen or a server mute) releases the microphone capture two seconds later: the browser's
recording indicator goes off, and on Android the phone leaves the call audio mode that an open capture with echo
cancellation keeps (Chromium plays remote voices as call audio then, often far quieter than media). A quick mute and
unmute keeps the capture; an unmute opens it again with the same device and settings before the microphone is
unmuted (if that fails, for example the device was unplugged, the microphone stays muted with a warning). Push-to-talk
closes only the gate between key presses, never the capture: a new `getUserMedia` per press would take hundreds of
milliseconds and cut off the first syllable. While unmuted (voice activation or push-to-talk) with echo cancellation
on, Android stays in the call audio mode: the volume keys set the call volume during a call.

**Talking while muted** (`web/src/voice/mutedTalk.ts`): with "Remind me when I talk while muted" (Settings → Voice &
video → Input mode, on by default except on Android) the capture and the microphone graph keep running while you are muted, so the
client can tell that your voice is being picked up; the gate is held closed and the published track is muted, so
nothing is sent (the other side decodes silence). Once the input stays above the voice activation threshold for
about 0.7 seconds (short dips between words do not count), a soft double tap plays (the cue "Talking while muted",
with its own switch and preview like every cue), the microphone button in the controls and in the voice bar and the
microphone flag on your own tile pulse for a moment (a static amber ring with reduced motion), and once per mute a
short notice says "You are talking, but your microphone is muted." (announced politely). The cue repeats at most
every ten seconds while the talking goes on. The hint applies to the mute toggle only: a released push-to-talk key is
not a mute; it does not listen while deafened (you stepped away) or server-muted (you could not unmute). With the
setting off the mute releases the capture as described above; on Android in the browser this also means the phone
stays in its call audio mode while muted as long as the hint is on, which is why the hint starts off in the browser on
Android and in the Android app (`mutedTalkHintDefault` in `web/src/voice/settings.ts`; only a choice that differs from
the platform's default is stored, so turning it on there is kept).

### Voice and stream audio

A participant's voice (microphone) and their screen share's audio each have their own volume (0–200 %, kept per
device): the voice volume in the participant's menu, the stream volume behind the speaker button on the stream tile
and, while they stream, in the menu next to the voice volume; Settings → Voice & video → "Volumes of other people"
lists them with Reset. The output volume of the settings multiplies with both; the priority speaker still ducks the
others' voices and streams. Deafen mutes voices and the notification sounds about others, but a stream you are
watching (joined, and its tile is on screen) keeps playing: the tile shows a speaker badge and the voice bar says "Voices muted,
the stream keeps playing". A stream that is not on screen (you opened a text channel or the settings) goes silent
while deafened. The switch "Streams stay audible while deafened" in the voice settings (on by default) turns this
off, so that deafen silences everything.

**Mute for you** (`web/src/voice/localMute.ts`) in a participant's menu (next to the volume, on the row in the
channel list and on the stage tile) silences that person's voice and their stream's audio on this device only;
nobody else is told and the node is not involved. It is kept in memory for the session, never in storage: a reload
starts with everybody audible, so a forgotten mute cannot outlive the day. A person muted for you carries a crossed
speaker on their tile and in the member list (amber; the tooltip says "Muted for you", a click on it or "Unmute for
you" in the menu lifts it), they are never shown speaking (there is nothing to hear), and the stage header shows
"Muted for you: n" while anybody in the call is muted this way.

### Calls in DMs and group DMs

The call button in the conversation header rings the others (a banner with a soft synthesized ringtone on all their
devices, also across nodes; direct calls and group calls have different ringtones, and direct calls ring louder);
accepting opens the call view with the same tiles and controls as voice channels, end-to-end encrypted with the
conversation's keys. Nobody answering within 45 seconds or a declined DM call leaves a "missed call" entry, a finished
call one with its duration. Calls in DMs use 64 kbps.

Phones and other browsers that start audio only after a user gesture: the first tap or key press after signing in
unlocks the sound (a silent one-sample buffer in the gesture), so a call can ring later without one. While the
browser still blocks it, the banner says "tap the page to hear the ringtone", and the ring shows a system
notification through the service worker (also when the tab is hidden) if push or browser notifications are on for
this device; the notification closes when the ring ends. Phones vibrate while it rings (browsers allow it after the
first tap). The node also pushes call rings while a tab is connected, because a phone may keep a frozen background
tab's connection open; the service worker shows them only while no page of the client is visible.

### Screen sharing, the priority speaker and the soundboard

Before the browser's picker, sharing the screen asks for resolution, frame rate and the sound ("Screen share audio"
below). Members with the priority speaker permission hold the priority key (or the megaphone toggle in the call
controls on phones and tablets) to lower everybody else to 25 % for all listeners. Room owners upload soundboard clips
under Room settings → Soundboard (at most 5 seconds, 1 MB and 50 clips per room); members with `use_soundboard` play
them from the call controls into their own (encrypted) microphone track, which also needs `speak`. Personal clips
(Settings → Sounds) and other rooms' clips need `use_external_sounds` and are greyed out without it.

### Screen share audio

The share dialog has one choice for the sound: **No sound**, **Whole system** (everything the computer plays) and,
on a platform that can capture it, **This window only**; a line under the choice says what it means where the client
runs (`web/src/voice/screenAudio.ts` decides from the platform, `ui/VoiceControls.tsx` shows it). Only the choices the
platform supports are shown, and "Whole system" starts selected only where the call's own playback is left out of it
(nobody hears themselves); elsewhere it is off by default and the note warns. What each platform does (October 2026):

| Where | Whole system | Own playback left out | This window |
|---|---|---|---|
| Chrome, Edge and other Chromium browsers on Windows (and ChromeOS) | yes, with a shared screen (the browser's "share system audio" box; a shared window carries the system's sound as well) | since Chrome 141 (`restrictOwnAudio`, read from the browser's supported constraints); older browsers include the call, and the note says so | no: no Chromium captures one window's sound (`windowAudio` knows "system" and "exclude" only) |
| Chromium browsers on macOS | since Chrome 141 | since Chrome 141 | no |
| Chromium browsers on Linux | a browser tab's sound only; a shared screen or window is silent | the tab's sound never carries the call | no |
| Firefox, Safari | no sound with a screen | — | no |
| The Windows app (Tauri, WebView2) | as Chromium on Windows: Edge's picker with the system audio box | with a WebView2 runtime of Edge 141 or newer | no |
| The Linux app (Electron) | no: Electron captures system audio on Windows only, and neither X11 nor the PipeWire portal gives it any | — | no |
| The Windows fallback (Electron) | yes (Electron's loopback capture) | **no**: Electron cannot leave a process out; use headphones or share without sound | no |
| The macOS app (Tauri, WebKit) | no sound with a screen | — | no |
| The Android app | the sound of other apps (Android 10 or newer, apps that allow capture) | yes: Android's playback capture takes media, game and unknown usages only, the call plays as voice communication | no |

"Whole system" asks the browser for audio with `restrictOwnAudio: true` and `systemAudio: "include"`; "No sound" asks
for none and keeps the system's sound out of the browser's picker. A viewer receives the sound only after joining the
stream ("Streams are joined" above) and has a stream volume of its own. The Android app's sound is the device's screen
publisher's audio track (docs/ANDROID.md "Screen sharing").

### The whiteboard

Every conversation has a shared whiteboard (the 🖍 button in the header opens it full screen; in a voice channel the
🖍 of the call controls presents one on the stage). Opening one needs `use_whiteboard` (in voice channels also
`connect`); one board runs per conversation at a time. The presenter decides who may edit (open for everyone, locked,
or single participants), keeps scenes in an encrypted library and sets a background; everybody can save the board as
an image or share it to a channel. Members with `manage_whiteboard` may close someone else's board. In encrypted
conversations everything on the board travels end-to-end encrypted. On the voice stage the board is a tile of its
own that is joined like a stream ("Streams are joined" above): the camera tiles stay as they are, the presenter keeps
a hideable preview and the "Whiteboard is open" bar, and the member list marks the presenter with a board badge.

### Settings → Voice & video

The voice settings are kept per device and applied live:

- microphone and speaker with a level meter (browsers name the devices only once the page may use the microphone: the
  desktop app asks for it when the tab opens, the browser offers **Show devices**, also on the first click into a
  list, and the lists follow devices plugged in or out);
- "Check microphone" (a level meter) and two microphone tests with the same processing as in a call, except that
  push-to-talk never closes the gate there (the tests judge the microphone, not the key): **Hear yourself** plays the
  microphone back live with a timer and stops after one minute, when you leave the settings or when you join a voice
  channel, and is not available while you are in one; it asks for headphones and mutes itself while the sound is loud
  and concentrated on one frequency (the howl of speakers feeding the microphone) until you unmute it. **Record and
  play back** records five seconds;
- a test tone, input and output volume, automatic gain, echo cancellation, noise suppression (off, the browser's, or
  RNNoise running locally as a WASM audio worklet), a noise gate with its threshold;
- voice activation with a live "transmitting" light, or push-to-talk (key, default `Backquote`, and a release delay,
  default 250 ms; on touch screens a "Hold to talk" button in the call controls), and "Remind me when I talk while
  muted" ("Mute and the microphone capture" above);
- camera with preview, resolution and frame rate within the node's limits, mirroring and background blur (strength
  slider, quality fast/balanced/high with mask smoothing) or an image (MediaPipe served by the node, turned off
  automatically on machines that cannot keep up, with the measured numbers);
- soft notification sounds (join, leave, mute, deafen, streams, connection, and a soft rising and falling tone when
  push-to-talk or the priority key opens and closes the microphone, heard only by you, never while the server keeps
  the microphone closed), with a volume, a switch and a preview per sound and "All notification sounds off", and the
  ringtone volume. The sounds are synthesized (`web/src/voice/cues.ts` explains the notes): join, leave and the
  stream cues are the present ones (a fifth and a triad with a clear onset), the ticks for your own switches stay
  quiet, and the ringtone is a two-bar tune in C major pentatonic;
- "Volumes of other people" ("Voice and stream audio" above), "Keep the screen on during voice calls" (below) and a
  **connection test** that tries every path to the node's media server (UDP per address, TCP, TURN) and says what to
  fix when one fails.

### Hotkeys

Push-to-talk (Settings → Voice & video → Input mode), the priority speaker and, under **More hotkeys**, mute and deafen
have one binding each: a single key, a modifier alone (left Ctrl, right Shift, …) or a combination, taken by a
recorder (Escape cancels, Backspace removes the binding) that shows the key names of the platform (Super, Win or Cmd)
and lights the key up while it is held. In the browser they work while the tab has focus; the desktop app also
observes them system-wide, while a game has the focus, without taking the keys away from it (DESKTOP.md "Hotkeys"). A
key of another action is refused; a character typed into a text field never triggers. Mute or deafen pressed outside
a call says that the next voice channel is joined muted or deafened.

### The screen stays on during calls

While you are in a voice channel or a call, the browser client asks for a screen wake lock (switch "Keep the screen on
during voice calls" in the voice settings, on by default), so a phone does not lock mid-conversation. Browsers hold it
only while the page is visible and the client asks again when you come back. The desktop app does not show the switch
and takes no wake lock; keeping voice alive with the display off is up to the native apps.

### Quality and traffic

With `manage_channels`, Room settings → Channels → a voice channel → **Voice quality** (VOICE.md §4a) offers Saver (8
kbps, telephone quality, least traffic), Standard (32, clear speech), High (64, the default of new channels), Studio
(128, practically transparent speech), Music (192, stereo) and a custom value; presets above the node's
`TAVRN_VOICE_MAX_BITRATE_KBPS` are shown as limited by this node. Everybody in a channel receives what a speaker
publishes (the media server forwards, it does not transcode), so quality is a channel setting, and the section names
the traffic per hour for every speaker and listener (Music: about 86 MB). The voice bar shows the quality of the
current call with the Opus bitrate in its tooltip. A changed quality applies from the next join.

The microphone is published as Opus with the channel's bitrate, DTX on and RED off; in-band FEC is negotiated by the
node's media server (`limits.audio_fec`), the browser needs no option for it. **Music mode** (192 kbps and more): echo
cancellation, noise suppression (also RNNoise) and automatic gain are off, DTX is off so quiet passages are not cut,
and the capture asks for two channels. Stereo is published only when the device really delivers two channels; a mono
microphone is published as mono and heard in the middle, and a two-channel interface with a single microphone on one
input is folded onto both sides (the gate worklet's channel guard: one side below −70 dBFS while the other carries
signal), so nobody is ever heard on one side only.

### Voice troubleshooting

**What a join does.** Clicking a voice channel starts the microphone, the playback and the encryption worker at once,
while the device joins the channel's encryption group (MLS, ENCRYPTION.md §4) and the node's pending leaf removals
are fetched. As soon as the device is in the group the client asks the node for its seat (`voice/join`); meanwhile it
removes ghost leaves it may remove (deleted devices, its own old devices) and commits a self update, so every voice
session starts on a fresh key (§5a). The call connects to the media server in parallel; only the device's own sending
key and the microphone's publication wait for the fresh key. The ghost cleanup never holds a join: when another device
was elected to remove a leaf (§4.7, the lowest device id among the participants who may do it), the join goes on and
the cleanup follows in the background once connected; the removal later moves the group to a new epoch, which
re-keys the call. Switching channels leaves the previous one in the background. A join on the same machine takes
about 0.2 seconds; with 40 ms to the node about half a second, most of it the media server's own connection set-up.

**Log join timings.** Settings → Voice & video → Connection test → **Log join timings** (or
`localStorage.setItem("tavrn.debug.voice", "1")` in the browser console, `removeItem` to turn it off) makes every
join print one table to the browser console (`console.info`, developer tools: F12 or Ctrl+Shift+I; in the desktop app
the same shortcut), once connected:

- every stage since the click with its duration (`ensure_joined_done`, `cleanup_done`, `self_update_done`,
  `voice_join_response`, `capture_ready`, `lk_signal_connected`, `lk_connected_event`, `fresh_key_ready`,
  `store_connected`, `mic_published`, …), also as `performance.mark("vj:<stage>")` entries for the browser's
  performance panel;
- how long the media server's signalling WebSocket (`/rtc`) took to open;
- each peer connection from its creation through ICE checking to connected;
- the selected candidate pair: local and remote candidate type (`host`, `srflx`, `relay`), UDP or TCP and the
  round-trip time.

Reading it: slow MLS stages (`ensure_joined`, `cleanup`, `self_update`) point at the node or the network to it (each
is one or two requests); a slow `/rtc` open or `lk_signal_connected` at the reverse proxy in front of the media server;
a long ICE phase, a `relay` pair or TCP instead of UDP at blocked UDP ports (the connection test above tells which
paths work). Nothing is recorded, wrapped or printed while the switch is off, and the setting stays in this browser
profile.

## Roles and permissions

Roles with "show separately in the member list" get their own section there; the role list in the room settings is
reordered by drag and drop (or the arrows). `@everyone` can never get management permissions; the editor greys them
out. Moderation items against someone whose highest role is not below yours stay greyed out with the reason. Each
role also carries its allowed file types ("File types" above).

**Channel permissions are layered**
([permissions.md](https://github.com/just-tavrn/tavrn-protocol/blob/main/permissions.md) "Evaluation"): roles give
the base, a category's overrides apply to all its channels, and a channel's own overrides win over the category's; a
bit left at "–" inherits from the layer below. In **Room settings → Channels** the category name opens **Permissions in
this category**, a channel shows **Permissions in this channel**. Both editors list only the channel-scoped
permissions, grouped as general, text, voice, files and management, each with an allow / – / deny choice; under
every permission the value it inherits is shown in grey ("Inherited: allowed by the category" / "by the roles"), which
is also the accessible description of the choice. **Reset to category** removes a channel's own overrides after a
confirmation. `channelPermissions` (`web/src/lib/channelPermissions.ts`) computes exactly like the node, including the
view, read and connect a moved participation grants in the voice channel the user's own session is in.

### View the room as a role

**Room settings → Roles → View room as this role** (for `@everyone` and every role you may manage, i.e. below your
highest role; the owner may preview all) opens the room as a member holding only the chosen roles sees it. The dialog
can combine further roles and sets the **join date** (now by default), the start of the encrypted history window. A
banner "Viewing as <role>" with **Exit preview** stays on every page of the room; "What is simulated" lists the
approximations. The preview ends on exit, on leaving the room, on a reload and on sign-out (it lives in the tab's
memory only, `web/src/stores/rolePreview.ts`).

It is a simulation on the device, nothing is asked of the node and nothing acts as the role:
`web/src/lib/previewRoom.ts` derives the room detail with the SDK's `computePermissions` (the protocol's permission
test vectors pin it) with `my_roles` = the chosen roles, `is_owner` = false and no member overrides, and `useRoom()`
returns it while the preview is active, so every room view follows: the channel list with the access marks the role
gets (categories only with a visible channel), the channel page (composer, reactions, pins, threads, `@everyone`,
slash commands, the message menu), the member list's moderation items under the role hierarchy, and the settings
tabs the role would see. Voice channels list join, speak, screen sharing, camera, soundboard and whiteboard as allowed
or not without joining; files channels list upload and manage. In encrypted channels the messages, forum posts and
file entries from before the window a new member with these roles gets (the channel's history setting from the join
date, the join itself without `read_history`) are cut behind "History for this role starts here"; plaintext is never
cut.

**Read-only.** While a preview is active the client refuses every request that would change something before it
leaves the device (`web/src/lib/previewGuard.ts`, applied by `trackingFetch` to every node client): one toast "Read-only
preview" explains it, read markers are refused silently, and only the device's own upkeep passes (session refresh and
federated sessions, presence, MLS and key upkeep, history keys for other members, the conversation index and
backups). Typing indicators are not sent, voice joins, voice moves and other drag-and-drop moves, uploads and pasted
files are off. Notifications, rail counts and search hits of channels the role cannot view are dropped, and a deep
link into one lands on "Members with this role cannot see this channel". Approximations: an adult member (age gates
are not simulated), not timed out, without a moved voice participation, joined at the chosen date; channels you cannot
see yourself cannot be previewed (the client never gets them), and for owners and administrators the preview is exact.

## Context menus

Members, messages, channels, rooms in the rail, DMs and friends have context menus, and a thread's header has a menu: right-click (or the
keyboard's context-menu key / Shift+F10), the ⋯ button, or a long press on phones.

| Menu | Entries |
|---|---|
| Member | profile, message, call (in DMs), add friend, invite to room, mention, copy address and ID; in your call a voice volume slider (0–200 %) and, while they stream, a stream volume slider; roles (checkboxes); with the matching permission server mute, disconnect and "move to" (server deafen is listed greyed out: no node supports it), timeout or remove timeout, "Remove from room", ban (with a reason); report and block |
| Message | reply, react, copy text, link or ID, create thread, reply in thread, mark unread, pin, edit, delete, report |
| Channel | mark as read, notification level (default, all, mentions only, nothing), mute for 1 h, 8 h, 24 h or until turned back on, keep the full history (encrypted channels), "move everyone here" on voice channels, edit, duplicate and delete with `manage_channels` (never for the welcome channel), copy link and ID |
| Room | invite people, room settings, mark as read, notification level, mute, suppress `@everyone`, the folder entries ("Room rail and folders"), copy ID, report, leave (greyed out for the owner, who transfers or deletes the room instead) |
| DM | mark as read, profile, copy address, notification level, mute, keep the full history, close (until a new message arrives), block |
| Friend | join their voice channel, invite to room, message, remove, block |
| Thread (its header) | for its creator or *Manage threads*: rename, archive, lock, delete |

A choice that only changes a state shown in the menu (notification level, `@everyone`, mute and unmute, roles, server
mute, keep the full history, folder colour, a thread's archive and lock, the devices and push-to-talk of the voice
quick menus) keeps the menu and an open submenu open and shows the new state; navigation, copy, join/leave,
moderation and destructive items close it. Logging out is the last item of the status menu on your avatar (with a
confirmation).

## Notifications

Mentions and DMs show a toast with a jump link, a soft sound and an entry behind the bell next to the settings gear.
**Settings → Notifications** sets what rooms notify about ("Rooms notify me about"; direct messages always notify
unless set to nothing), the sound (with a preview), lists the rooms and channels with their own settings (set from
their context menus) with a Reset each, and has **Desktop notifications when tavrn is in the background**: the
browser shows them then (the permission is asked only after that click; encrypted messages never appear in the notification
text). The settings are stored on the home node and fall back to this browser on nodes that do not offer them.

**Push notifications on this device** turns on web push for this browser or installed app (PROTOCOL.md §6d): the
client registers a service worker (`public/sw.js`, push and notification clicks only: it caches nothing and there is
no offline mode), subscribes with the home node's VAPID key and registers the subscription with the home node, which
pushes while no tab of the client is connected (call rings also while one is: the service worker shows them only
while no page of the client is visible) and follows the notification settings (rooms on other nodes push
through the home node for DMs, mentions and calls). Pushes of encrypted conversations only name the conversation and
the sender; "Show message text in push notifications" adds a preview of unencrypted messages. A click opens or focuses
the conversation; a test button sends a push. Signing out removes the subscription; on iPhone and iPad push works only
after adding tavrn to the home screen. "Push notifications for new reports" (on by default, stored on the home node as
`global.reports`) lets room moderators and node admins turn off the pushes of new reports; such a push names only the
room ("New report in \<room>", or "A report for the node admins") and opens the room's Reports tab or Admin → Reports.
A hint under the switches says what rooms on other nodes push: under "All messages" they do not push ordinary
messages, only mentions, direct messages and calls (the home node receives no hints for the rest, PROTOCOL.md §6d).
When the browser's subscription still belongs to another account (`409 push.endpoint_taken`), the client unsubscribes
it and subscribes again, which gives this account a new endpoint. The desktop app shows native notifications instead
("The desktop app").

## Reports, auto-moderation and ownership

These features are specified in [MODERATION.md](https://github.com/just-tavrn/tavrn-protocol/blob/main/MODERATION.md);
the client shows them only for nodes that announce `reports.v1` and `automod.v1`.

- **Reporting.** "Report message" in the message menu (others' messages), "Report" in the member menu and "Report
  room" in the room menu (rail and the room header). The dialog asks for a category and optional details and says who
  will read the report (the room's moderators and the node admins, or the node admins only). Reports of a room go to
  the room's node; reports of direct messages to your home node. For an **end-to-end encrypted** message nobody else
  can read it, so the dialog offers to release its text and up to ten messages before it: only after ticking the
  consent box it lists exactly what would be sent (author, time, text, file names, never files) and lets you untick
  context messages; the reported message itself is always included, and a report without any text stays possible.
  Messages this device cannot decrypt cannot be released. Plaintext messages are linked by the node instead. Reports
  are not anonymous to moderators; the reported person is never told.
- **The inbox.** Room settings → **Reports** (members with `moderate_members`) and Admin → **Reports** (node admins,
  every report of the node, filterable by who handles it) list the reports with their status. A report shows the
  reporter, the target, the reporter's text, the plaintext message as it was when reported, or the released text
  under the label "released by the reporter – not verified". Moderators assign reports to themselves, add a
  resolution note, resolve or dismiss them, and act from the report: delete the message, time out (with the usual
  durations), remove, ban (node ban for node reports) or delete the person's messages (with the count and a typed
  confirmation). The actions run with the moderator's own permissions and are noted in the audit log with the
  report. The room header's chevron, "Room settings" in its menu and the tabs show the number of open reports; new
  reports arrive in the bell and as a toast (not while notifications are set to nothing or the room is muted), and as
  a web push while no tab is open ("Notifications").
- **Forwarding to the home node** (protocol MODERATION.md §1.6, shown where the node announces `reports.v2`). In
  Admin → Reports, a report by a member about a user of another node offers **"Forward to the user's home node"**:
  only that node's admins can act on the account. A confirmation names the node and says what leaves this node (the
  category, the reporter's text, the reported message or the released text) and what does not (the reporter's
  address, which the other node sees only as a pseudonym, other people in the released text, notes, actions and the
  room's name); the reporter is not told. A report is forwarded once; it then shows "Forwarded to \<node>" with time
  and admin and stays in the inbox. Reports other nodes forwarded here are marked "Forwarded from \<node>", name the
  reporter by their pseudonym and the original time, and offer the account actions (node ban, delete the person's
  messages) but not the message ones (the content lives on the other node).
- **Auto-moderation.** Room settings → **Auto-moderation** shows the node's flood protection and edits the room's
  content rules: words and phrases (one per line, `*` within a word, optionally whole words only), link filters (block
  all, allow only some domains, block some domains), exempt roles and channels, and the action (block, remove
  silently, remove and time out). Members with `moderate_members` but without `manage_room` see the rules read-only.
  The rules never apply to end-to-end encrypted channels; the tab says so. A blocked message stays in the composer
  with an explanation that names the rule (or the node's own filter).
- **Welcome channel.** Its entries offer no "Delete": nobody can delete them, owners and node admins included.
- **Ownership.** Room settings → Overview → **Transfer ownership** hands the room to another member of the room's node
  (not a bot); the owner confirms with the password, a passkey or single sign-on. Deleting an account that still owns
  rooms lists them in the deletion dialog with "Transfer ownership" and "Delete room" for each.
- **Retention.** Room settings → Overview → **Message retention** (owner or "Manage room") deletes the room's messages
  after a number of days, with their attachments (PROTOCOL.md §7f); the section shows the node's period (`GET /node`
  `message_retention_days`), and a room can only choose a shorter one. Pinned messages and the welcome channel are
  kept. **Attachment retention** below it deletes only the files, earlier if set so.
- **Single sign-on groups.** Admin → SSO picks the rooms and their roles of a group by name.

## Applications, bots and webhooks

Settings → **Applications** creates and edits the user's applications (bots), manages their tokens (a secret is shown
exactly once, and the page says that a bot token is a single factor), transfers an application to another user of the
node and resets a bot's identity. Room settings → **Applications** lists the bots installed in the room (removing one
takes it out of the room and deletes its role), Admin → **Applications** the applications of the node (a disabled one
cannot act). Bots carry the BOT badge; channels show whether bots are kept out ("No bots") or may read an encrypted
channel. Room settings → **Webhooks** creates webhooks for services such as CI or monitoring; in end-to-end encrypted
channels their messages are sealed for the channel's members, by the service itself or by the node (which then saw
the text once), and a lock next to the WEBHOOK badge says which.

## Settings

| Page | Tabs |
|---|---|
| User settings | Profile, Privacy & safety, Security, Voice & video, Notifications, Emojis, Sounds, Applications, Language, Devices, Legal & privacy, and App in the desktop app |
| Room settings | Overview, My profile here, Roles, Channels, Members, Bans, Invites, Webhooks, Applications, Emojis, Soundboard, Moderation, Audit log; Reports, Auto-moderation and History requests where the node announces them; each tab only with its permission |
| Node administration | Overview, Users, Invites, Bans, Reports (with `reports.v1`), Entitlements, API tokens, Applications, SSO (when single sign-on is configured), Federation, Legal, Notices, Audit log |

## The desktop app

The same client also runs as the desktop app for Linux and Windows ([DESKTOP.md](DESKTOP.md)): it is bundled into a
shell instead of being served by a node (Electron on Linux, Tauri on Windows and later macOS; the client does not care
which), asks for the home node on the first start (the node picker at `/node`,
changeable under Settings → App, where the app also shows its version, installs signed updates and chooses the update
channel: stable or beta, kept by the shell, beta by default for a pre-release build) and talks to that
node over https and wss. The client's platform layer (`src/platform/`) tells the API client, the WebSocket and the link
builders where the node lives. The node picker and the login page take the account's address first
(`alice@home.example`): the shell finds the node of that domain (well-known, SRV, direct) and the app switches to it.
Flows that need the node's own origin (passkeys, single sign-on, the captcha) run on the node's own page in a window
of the app without any native API ("Sign in on \<node>'s page"), and the app takes over the session; a passkey used
there also unlocks the encrypted messages, and "Unlock with a passkey" on the app's unlock screen runs just the passkey
on that page; on nodes without app sessions the password with TOTP or a recovery code is what works. The Windows app
runs passkeys natively instead (the Windows WebAuthn API with the node's web origin, DESKTOP.md "Passkeys"): there the
passkey buttons work in the app itself and the node's page is optional. The Linux app does the same with FIDO2
security keys on USB while one is plugged in (the PIN in a dialog of the app, DESKTOP.md "Passkeys on Linux"); any
other passkey goes through the node's page in the browser. Web push is not offered. Details in DESKTOP.md
"Signing in" and "Limitations".

The app keeps the key that unlocks the local key store in the OS keychain (Secret Service, Credential Manager) instead
of IndexedDB, and moves an existing key there on its first start; without a keychain it keeps the browser's behaviour
and says so under Settings → App (with "Require the recovery key or a passkey every time" on, it stores no key at
all). Mentions, direct messages and incoming calls become native notifications while the window is not in front (a
click opens the conversation; Settings → Notifications switches them off for this device), and a tray icon shows the
voice state (in a channel, speaking, muted, deafened) with mute, deafen, leave voice, show/hide and quit in its menu;
closing the window keeps the app in the tray (Settings → App, which also has "Quit tavrn"; on desktops without a tray
closing the window quits the app).

**Links into the app:** `tavrn://` links (invites, rooms and channels, add links of applications) open the app,
which shows what the link opens and the link itself and goes there only on **Open**; an app without a home node yet
offers the node picker with the link's node first. After the sign-in on the node's page in a browser, **Open the tavrn
app** on that page brings the app to the front and lets it continue at once (DESKTOP.md "Links into the app").

**Game activity (privacy):** Settings → App → **Show the game I am playing** is off by default. While it is on, the
app compares the process name of the program in front with a list of games shown right there (built-in entries can
be switched off, own ones added) and sets "Playing \<game>" for the people who may see your status; it sends only the
game's name from that list, never window titles or other programs, and clears it when the game closes or the setting
goes off. With "Hide my activity" (Privacy & safety) nothing is published. The setting stays on the device
(DESKTOP.md "Game activity").

**Downloads** in the app open the system's save dialog; the app writes the file and says where it went ("Saved to
Downloads", with **Show in folder**); DESKTOP.md "Downloads".

**Voice and video:** the Linux app (Electron) runs voice, video, screen sharing, the soundboard and the background
effects in Chromium exactly as the browser does; sharing a screen opens the app's own picker of screens and windows (on
Wayland the desktop's portal dialog), without sound ("Screen share audio": Electron captures system audio on Windows
only; DESKTOP.md "Voice, video and screen sharing (Electron)").

**Native voice engine (Tauri app):** the Tauri app can send and play voice through its own native engine (LiveKit's
Rust SDK in the shell), always in its Linux bundles, whose web view has no WebRTC, and on Windows with the setting
**Native voice engine (experimental)** under Settings → Voice & video → Voice engine, which switches the next call to it
(default off; only shown in the desktop app). It is end-to-end encrypted exactly as in the browser and has the same
settings: devices of its own (Settings → Voice & video lists the engine's microphones and speakers), input volume, echo
cancellation, noise suppression (RNNoise becomes WebRTC's noise suppression there), automatic gain, the noise gate,
voice activation or push-to-talk (also through the system-wide hotkey while the window is in the background), per-user
volumes, mute and deafen, the speaking rings and the notification sounds. Audio only: camera, screen sharing,
soundboard clips and the priority speaker are not available with the native engine, and their buttons say so
(DESKTOP.md "Voice").

## The Android app

The same client runs as the Android app ([ANDROID.md](ANDROID.md)), the Tauri shell built for Android: the node picker,
the address-first sign-in and the connect flow work as in the desktop app, with the node's page in the browser instead
of a window ("Sign in on \<node>'s page"). What is different in the client:

- **Push** under Settings → Notifications comes through UnifiedPush (a distributor app such as ntfy, no Google
  services); the client registers the distributor's endpoint at the home node like a browser subscription. Without a
  distributor the section says where to get one and offers "Keep a connection for notifications" (a permanent
  notification keeps the app connected; it costs battery) and the battery-optimisation exemption.
- **Voice** keeps running in the background with a notification "In voice channel X" (Mute/Unmute, Leave); joining
  asks for the microphone, headsets (nearby devices) and once for notifications right before the first use, and a
  permission Android no longer asks for is explained with the way to the system settings.
- **The back gesture** closes the open dialog, menu or drawer, then goes back; from the first page it sends the app to
  the background. **Invite and add links** of app.tavrn.org and `tavrn://` links of any node open in the app, which
  asks before it opens them, as on the desktop.
- **Safe areas**: the layout pads itself with `--safe-top`, `--safe-bottom`, … (the system bars the app reports; the
  browser's `env(safe-area-inset-*)` otherwise); the keyboard shortens the page, so the composer stays above it.
- **Downloads** use Android's document picker; **updates** are announced from the project's releases and download in
  the browser. **Passkeys** run in the app through Android's Credential Manager (registration, sign-in,
  re-authentication, the PRF unlock) on Android 14+ when the home node lists the app's origin in `webauthn.origins`; otherwise on the node's page in the browser, with
  "This node does not accept the app's passkeys yet" where the node is the reason (ANDROID.md "Passkeys").
- **Unlock with fingerprint, face or PIN** (Android 11+, a screen lock set): after an unlock with the recovery key or
  a passkey the unlock screen offers it ("Unlock faster next time?"); then the key of the local key store is sealed in
  Android's keystore, and the next start opens the system's prompt by itself, with the recovery key or a passkey as
  the alternative. Settings → App turns it off (the sealed key is deleted); a removed screen lock invalidates it, which
  the unlock screen explains (ANDROID.md "Unlock with fingerprint, face or PIN").

## Translations

The web client ships English and German. It takes the language saved on this device, else the first of the browser's
languages it knows, else English; Settings → Language changes it. To add a language, copy `web/src/i18n/en.json` to
`web/src/i18n/<code>.json`, translate the values and register the file in `web/src/i18n/index.ts`. A unit test checks
that every language has exactly the keys of English, and that the texts write "tavrn" in lowercase, name no
authenticator app and contain no roadmap wording.

The language also decides the language of the home node's e-mails (address confirmation, password reset, account,
legal and app token mails): the client sends it as `locale` (`PATCH /users/me`) when the app starts and the node has
another one, and whenever the user switches the language under Settings → Language (`lib/mailLocale.ts`). The node
writes English where it has no texts for the language.

## Accessibility

The client aims at WCAG 2.2 level AA: every control works with the keyboard and has a name, menus and dialogs follow
the ARIA patterns, nothing is told by colour alone, targets are at least 24 × 24 px and animations stop under
reduced motion. [ACCESSIBILITY.md](ACCESSIBILITY.md) holds the audit, the automated checks per view, the known gaps
and a template for the accessibility statement operators may need.

## Testing

Vitest tests sit next to the code in `web/src` (unit, component and the static accessibility checks); the Playwright
suite in `e2e/` clicks through the flows of this document in real browsers against real nodes, on a desktop and a
phone viewport, with axe-core scans of the views. How to run both is in the [README](../README.md) ("Development" and
"End-to-end tests"); the desktop app's own tests are in DESKTOP.md "Tests".
