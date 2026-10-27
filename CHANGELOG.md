# Changelog

Changes of the web client and the desktop apps, newest first. Releases are the tags `vX.Y.Z` of this repository: the
release carries the web bundle (`tavrn-web-X.Y.Z.tar.gz` with its SHA-256) and the desktop installers with their
checksums and update files. The node's container image embeds the web client of a release.

## Unreleased

- **Accessibility (WCAG 2.5.3 Label in Name)**: controls are named with the text they show, for speech input. The
  initials of avatars and room icons without a picture are part of the picture; the search button shows "Search
  messages" (or the query); voice channel links name their participant count; a category's permissions button in the
  channel settings is named like "General: Permissions of the category". The accessibility gate runs axe-core 4.14.
- **Whisper controls**: the tile's hold control is a labelled "Whisper" button next to the participant menu (marked
  when the participant is the chosen whisper target); indicators, the voice bar and the group settings show display
  names instead of addresses. The member menu chooses a whisper target ("Choose … as whisper target", with a hint and
  a × in the voice bar to forget it) and creates a numbered group with that member ("New group with …", a toast
  links to the room settings). Room Settings → Whisper groups: the shortcut row is labelled "Shortcut (hold)",
  member suggestions open below the search field, the new-group field has a placeholder, empty states and member
  counts, and the help text names the actual user settings path (Voice & video → More hotkeys).
- Move personal whisper groups to their own room settings category with room-member autocomplete and a voice-channel
  menu shortcut. Keep the reply shortcut under Voice & video → More hotkeys. The channel-scoped Voice permission
  controls initiation; an actual server-confirmed whisper can still be replied to without it. `voice.whisper2`
  binds encrypted tracks to server authorization, confirms removal before restoring normal voice, and preserves
  ordinary camera/audio for other listeners. Signal reconnects establish a fresh SFU connection before new
  whisper authorization; native receivers continue to quarantine whisper tracks.

- Native voice now admits remote audio to playback only after successful frame decryption; startup and
  key-error frames are discarded, including buffered audio.

- **Whisper in voice channels** (`voice.whisper1`): hold a tile control or a configured room-group/reply
  hotkey to speak to selected participants through a second encrypted, SFU-restricted microphone track.
  EN/DE indicators and soft cues identify addressed whispers; outsiders receive neither audio nor control
  signals. The shared epoch-key privacy boundary is documented in the protocol. Native voice uses the
  explicit browser-engine fallback. Sender cleanup preserves normal mute/PTT behavior, and soundboard
  signals retain their own channel permission checks. A pinned LiveKit ESM patch preserves targeted routing
  when data encryption replaces the inner packet.

First public release of the web client and the desktop apps.

- **Web client**: rooms with text, voice, announcement, forum and files channels, threads, direct messages and
  friends across nodes, voice, video, screen sharing, the soundboard and background effects, the whiteboard, roles
  and layered permissions with editors, moderation and the admin pages; end-to-end encryption everywhere a
  conversation is encrypted, with history for new members and history restore after a key reset; phones, tablets
  and desktops; English and German; WCAG 2.2 AA as the accessibility target.
- **Desktop app for Windows** (Tauri): `.msi` and NSIS installer, signed self-updates, sign-in through the node's own
  page with passkey unlock, the OS keychain, global hotkeys (push-to-talk, priority speaker, mute, deafen), tray,
  native notifications and downloads.
- **Desktop app for Linux** (Electron): `.AppImage` and `.deb` with the same client in Chromium (voice, video and
  screen sharing as in the browser), the desktop's keyring, tray, notifications, global hotkeys, passkeys on FIDO2
  security keys and its own updater.
- **Android app** (Tauri, `org.tavrn.app`, Android 8 and newer, an APK for arm64 on the release): the same client with
  push through UnifiedPush (no Google services; ntfy or another distributor, or a kept connection without one), voice
  in the background with a notification (mute, leave), permissions asked right before their first use, the back
  gesture, safe areas and the keyboard, invite links of app.tavrn.org and `tavrn://` links, downloads through the
  document picker and update notices from the releases; passkeys, single sign-on and the captcha on the node's page
  in the browser ([docs/ANDROID.md](docs/ANDROID.md)).

### Added

- **Private select forms** (#209): application forms support single-choice dropdowns with required or optional
  choices, preselection and exact option validation; values stay encrypted in encrypted conversations.
- **Message components** (protocol APPLICATIONS.md §5.10, `components.v1`): buttons (primary, secondary, success,
  danger, link) and select menus (one or several choices) under the messages of applications' bots, and the forms
  (modals) bots open in answer, drawn from the client's own controls and palette inside the message on every screen
  (rows wrap, labels truncate with a tooltip, a hard height limit). Answers appear under the message they belong to:
  "Only you can see this" replies, "… is thinking", the bot's errors, an updated message; forms check required fields
  and lengths before sending. Link buttons name the full address before opening it; expired components and those of
  removed applications stay visible but disabled with the reason. Values are encrypted for the members in encrypted
  conversations. The role and channel permission editors list the new *Use buttons and menus of apps* permission
  (docs/CLIENT.md "Message components").
- **Who reacted** (protocol PROTOCOL.md §7 "Reactions", tavrn-protocol#43): hovering, focusing or long-pressing a
  reaction chip shows the reactors (up to ten names and "and n more"), loaded when first shown and cached per message,
  emoji and count; the text is the chip's accessible description too, Escape hides it.

- **Reorder channels and categories** (#179): Room settings → Channels lets channel managers drag channels and
  categories by a handle (or use the ▲/▼ buttons) to reorder them, drop a channel on a category to move it there, or
  out of every category; the category dropdown of the channel editor appends to the end of the new category. Only
  changed positions are saved and the sidebar follows at once; the sidebar itself stays without drag and drop. The
  tree in the settings now lists the channels without category first, as the sidebar does (docs/CLIENT.md
  "Reordering channels").
- **Room rules as Markdown** (#180, tavrn-protocol#59): the rules on the invite page and in the join dialog show
  paragraphs, lists, bold, links, quotes and headings (the legal pages' renderer: raw HTML stays text, no images), in
  a scroll box when long; Room settings → Overview says that Markdown works and has a **Preview** toggle under the
  field (docs/CLIENT.md "Room rules").
- **Log join timings** for slow voice joins: Settings → Voice & video → Connection test → "Log join timings" (or
  `localStorage` `tavrn.debug.voice=1`) prints one table to the browser console after each join with every stage's
  duration (`vj:*` performance marks), the opening of the `/rtc` WebSocket, each peer connection from creation through
  ICE checking to connected and the selected candidate pair (candidate types, UDP or TCP, RTT); off by default, nothing
  is recorded without it (docs/CLIENT.md "Voice troubleshooting").
- **View the room as a role** (#130): Room settings → Roles → "View room as this role" opens the room as a member
  holding only the chosen roles (or `@everyone` alone) sees it, with a join date for the encrypted history window: the
  channels and categories the role may view with its access marks, the composer and message actions, the member
  list's moderation items, the settings tabs and, in voice and files channels, a list of what the role may do. A banner
  "Viewing as <role>" with "Exit preview" stays on every page of the room; leaving the room, a reload or signing out
  ends it. The preview is a simulation on the device with the shared permission evaluation and strictly read-only:
  every request that would change something is refused before it leaves the device, typing, voice joins, moves,
  uploads and pasted files are off, and nothing of the hidden channels shows up (notifications, counts, search hits,
  deep links). Encrypted history from before the window is cut behind "History for this role starts here".
- **Polls and date polls** (protocol PROTOCOL.md §7g, `polls.v1`, #134): the composer's ＋ menu (**Poll**, **Date
  poll**) and `/poll [question]` open the poll composer: 2 to 20 options with single or multiple choice, or days of a
  calendar with all-day slots or times in the creator's time zone (up to 60); results always, after voting or after
  the close; votes public or hidden until the close; an optional close time. Polls render with vote buttons, results
  bars, voters, the best date slots and a grid of answers, in the viewer's time zone. Votes are one encrypted (or
  signed plaintext) record per member, checked against the poll's exact version, changed or retracted until the close;
  the author or a moderator closes a poll early. The role editors list the new *Create polls* permission.
- **A hint when you talk while muted** (#125): with "Remind me when I talk while muted" (Settings → Voice & video →
  Input mode, on by default) the client keeps listening to your microphone locally while it is muted (nothing is sent:
  the gate is closed and the track muted) and, once your voice is picked up for about 0.7 seconds, plays a soft double
  tap (the new cue "Talking while muted"), pulses the microphone button and your tile's microphone flag, and says
  "You are talking, but your microphone is muted." once per mute; the sound repeats at most every ten seconds. Not
  while deafened or server-muted, and a released push-to-talk key is not a mute.
- **Mute for you** (#124): a participant's menu (the row in the channel list, the stage tile) offers "Mute for you",
  which silences their voice and their stream's audio on this device only, remembered until the page is reloaded;
  nobody else is told. A muted person carries a crossed speaker on their tile and in the member list (the marker is
  the one-click undo, the tooltip says "Muted for you"), they are never shown speaking, and the stage header counts
  "Muted for you: n" so a forgotten mute is noticed.
- **Voice session timer and channel status** (protocol VOICE.md §5, §2a; fixes #126, #127): the voice header shows
  how long the session has been running (from the node's `session_started_at`, right for late joiners and for
  members outside the call; hidden while the channel is empty; announced once a minute) and the channel's status
  line under its name, edited in place by members with the new permission *Set voice channel status*
  (`voice_status`; Enter saves, Escape cancels, 128 characters with a counter). The channel list's tooltip of a
  voice channel names both. The role and override editors list the permission in the voice group.
- **Forwarding reports to the reported user's home node** (protocol MODERATION.md §1.6, `reports.v2`): node admins
  forward a report about a user of another node from Admin → Reports after a confirmation that says what is shared
  (never the reporter's address); forwarded reports show where they went, and reports other nodes forwarded show
  their origin and the reporter's pseudonym.
- **Links into the apps** (`tavrn://`): `tavrn://invite/<node>/<code>`, `tavrn://room/<node>/<room>[/<channel>]`
  and the add links of applications open in the desktop apps (registered by the Windows installers and the Linux
  packages; a second start hands its link to the running app) and in the Android app. The app shows what a link opens
  and the link itself and goes there only on **Open**; without a home node yet it offers the node picker with the
  link's node. After the sign-in on the node's page in a browser, **Open the tavrn app** on that page
  (`tavrn://connect`, checked against the waiting sign-in's session and state) brings the app back at once. The
  Android app's earlier `tavrn://<host>/invite/<code>` form is replaced by these ([docs/DESKTOP.md](docs/DESKTOP.md)
  "Links into the app").
- **Screen sharing in the Android app** (protocol VOICE.md §4b, docs/ANDROID.md "Screen sharing"): the screen share
  button asks Android's consent and shares the whole screen through the LiveKit Android SDK as the device's screen
  publisher, end-to-end encrypted with the device's frame key, which the client hands to the native side over the
  app's bridge; optionally with the sound of other apps (Android 10+, off by default). It stops from the "You are
  streaming" bar, the voice controls or the notification's **Stop sharing**, and with the voice session. Everybody
  else sees it as the sharer's stream, joined on demand like every screen share; the client lists screen publishers
  of any device as their owner's stream (`screen_of`), never as a person.
- **Game activity in the desktop apps**, opt-in: Settings → App → **Show the game I am playing** sets "Playing
  \<game>" while a game of the visible, editable list (built-in entries and your own) is in front, and clears it when
  the game closes. Only the game's name from the list is sent, never window titles or other programs; nothing is
  published with "Hide my activity". Windows and X11 (also games under XWayland); native Wayland windows and macOS
  show nothing ([docs/DESKTOP.md](docs/DESKTOP.md) "Game activity").
- **macOS builds (experimental)**: releases carry the Tauri app as one universal build for Apple Silicon and Intel
  (`Tavrn_<version>_universal.dmg`, and the `.app.tar.gz` the updater installs, signed with the update key). Not signed
  with an Apple Developer ID and not notarized: Gatekeeper blocks the first start until the app is opened by hand
  (right-click → Open; macOS 15: System Settings → Privacy & Security → Open Anyway). A failed macOS build never fails
  a release; the maintainers have no Mac, so these builds wait for a contributor with one to verify them
  ([docs/DESKTOP.md](docs/DESKTOP.md) "macOS").

### Changed

- **Channel sidebar sizes** (#185): channel rows have 16 px medium text (was 14 px) with 20 px SVG kind icons (was 14 px
  glyphs and emoji) of one shared size for every row kind (text, announcement, forum, files, voice, welcome, "Create
  channel"), 8 px gap, 34 px rows on desktop (was 40 px) and 44 px touch targets; category labels 12 px (was 11 px);
  the muted and bot markers are 16 px SVGs instead of small emoji; voice participants 14 px (was 13 px); the room
  header's name, the home sidebar's links and the direct message rows (32 px avatars) follow (docs/CLIENT.md "UI
  conventions").
- **No text selection on the app chrome** (#186): pressing and dragging over the room rail, the sidebars, the member
  list, the headers, the settings navigation, tab bars, voice controls, context menus and dialog titles no longer
  paints a text selection (`user-select: none`, also in WebKit); messages, the channel topic, code, dialog bodies,
  documents and fields stay selectable, and images in the chrome no longer drag a ghost image (docs/CLIENT.md "UI
  conventions").
- **Faster message list**: decryption, signature checks and the device archive handle only new or changed messages
  (unchanged rows no longer re-render), poll votes are checked once per vote, the typing line renders on its own,
  the composer measures its height only while it can grow, rendered markdown (emojis and mentions in one pass) is
  cached across scrolling, and message avatars of room members come from the member list instead of one profile
  request per author. Settings, administration, add-application and legal pages load on first use (the startup
  bundle is about 9 % smaller). Decrypted attachments are kept within a 192 MB budget: what no view shows is dropped
  and its object URL revoked.
- **Polls show the results after voting** (#156): once you voted a poll shows its results instead of the vote form;
  **Change vote** reopens the form with your vote filled in, **Keep** or **Save** return to the results and **Retract
  vote** stays in the form; closed polls show the results only. Date polls with many slots are compact: the form
  groups the slots by day with the answers on one line, and the results are a grid with the days as columns and the
  times as rows (yes / maybe counts, a totals bar, ★ for the best slots summarised on top, your answer as a badge;
  arrow keys move between the slots and a slot opens its answers; phones scroll the grid sideways with the times
  fixed). Your own vote is clearly marked in the results of choice polls.
- **Faster voice joins**: the microphone, the playback and the encryption worker start at the click; the node's
  pending leaf removals are fetched with the group join, the members' device keys in parallel (and not again for an
  unchanged group), the self update no longer fetches the handshake log a second time, and `voice/join` goes out as
  soon as the device is in the group while the cleanup and the self update run; the call connects meanwhile and only
  the own sending key and the microphone wait for the fresh epoch. Switching channels leaves the previous one in the
  background; the join's group work runs in the MLS manager's priority lane and pauses the background group joins.
  Measured to the published microphone: locally 0.15–0.28 s instead of 0.18–0.33 s, at 40 ms to the node 0.45–0.62 s
  instead of 0.63–0.91 s, a join right after a member left 0.15 s / 0.45 s instead of 9.7 s / 10.2 s
  (docs/CLIENT.md "Voice troubleshooting").
- **A voice join never waits for the ghost cleanup's election**: a join while a background cleanup of the channel
  waited for another device (after a member left, up to ten seconds) cuts that wait short; when another device is
  elected the join goes on and the cleanup follows in the background. Background cleanups elect only devices that may
  do the removal (room managers for departed members) and users the presence lists show online.

- **Room administration answers at once and costs one request** (#153, #155): saving a role, creating a category or
  channel and saving overrides no longer reload the whole room before the confirmation and again on the realtime
  event. The client writes the node's answer and the events' payloads into its cached room; only changes of a role
  the viewer holds, the own membership and a new owner fetch the room again, once per burst (250 ms), and the room
  list and the command palettes refresh only on the events that change them (measured with 60 ms latency: 4 requests,
  55 KiB and 145 to 195 ms per action before, 1 request, under 1 KiB and 30 to 120 ms after). The channel list
  evaluates permissions and access marks once per room version instead of per row and render, and its rows render
  only when they change.
- **The talking-while-muted hint is off by default on Android** (#147): it keeps the microphone capture open while
  muted, which holds an Android device in its call audio mode, so in the browser on Android and in the Android app
  it now starts off; Settings → Voice & video turns it on. Elsewhere it stays on by default, and a choice made in
  the settings is kept.
- **Emojis are a little larger**: emojis in message text are shown at 1.25× the text size (baseline aligned, the
  line height does not change), a message of one to three emojis and nothing else at twice the text size (custom
  emojis alike), and reaction chips show an 18 px glyph next to the count at the same chip height (#117).
- **Mentions stand out**: `@name`, `@name@domain`, `@Role` and `@everyone`/`@here` in messages are pills; mentions
  of yourself and @everyone/@here use the warning colour with a border, and a message that mentions you keeps its
  left border with a stronger tint (#122).
- **Voice cues and the ringtone** (#123): the ringtone of incoming calls is a tune now, two bars in C major
  pentatonic that climb to a question and walk back down to the tonic (group calls get the calmer, lower variant);
  the join, leave and stream cues are a little louder with a clearer onset, so they are not lost in a lively call,
  while the mute, deafen, connection and push-to-talk tones stay as quiet as before. The volume, the switch and the
  preview per sound in Settings → Voice & video are unchanged.
- **The apps are called "tavrn"** wherever the system shows the name (tavrn-web#114): the Windows start menu and
  desktop shortcut, the installer and its uninstall entry, the Linux menu entry and window class, the macOS bundle and
  the Android launcher said "Tavrn" before. An update from an earlier release keeps everything: the identifiers
  (`org.tavrn.desktop`, `org.tavrn.app`), the settings and profile directories, the keychain entries and the
  `tavrn://` links never carried the product name; the MSI's upgrade code is pinned to the one the earlier installers
  carry (the bundler would otherwise derive a new one from the new name and install a second product); the NSIS
  installer finds the old installation in registry keys and folders that Windows compares without case. The release
  files and the update feeds keep their names (`Tavrn_<version>_x64-setup.exe`, `Tavrn-<version>.AppImage`, …).
- **A limit per external store** (protocol FILES.md §5): the storage settings of a files channel on WebDAV or S3 get
  "Limit on the store (GB)" (empty = no limit), which the channel's meter shows; the node's own quota no longer
  applies to external stores.
- **Files channels on nodes without their own storage for them** (`TAVRN_FILES_INTERNAL=off`, protocol FILES.md §5):
  a channel without an external store shows "Choose a store first" instead of the upload button (a link to its
  storage settings for its managers, a note for everybody else), and the storage settings offer only WebDAV and S3.
- **Update channels for the desktop apps.** "Check for updates" of the rc builds said "Something went wrong": the apps
  asked GitHub's "latest" release, which never is a pre-release. Both shells now read the website's feed of their
  channel (`https://tavrn.org/updates/desktop/<stable|beta>/…`, a redirect to the right release's signed feed on
  GitHub). Settings → App chooses the channel: **stable** (releases only) or **beta** (pre-releases too), beta by
  default for a pre-release build; switching never installs an older version. A failed check now says why: the update
  server is unreachable, the channel has no release yet, the update is not signed with the app's key, or another
  failure. The Android app's check follows the same channel.
- Screen shares are opt-in: nobody receives a stream until they join it. A share shows as a tile with the streamer's
  name, LIVE and **Join stream**; joining (the button, a double-click on the tile, or a double-click or Enter on the
  LIVE member in the voice member list) receives its video and audio, **Leave stream** (tile or full screen controls)
  stops it again, as often as wanted and without reconnecting; each of several streams is joined on its own. The
  sharer gets a preview they can hide and a "You are streaming" bar with Stop. The desktop app's native voice engine
  never subscribes screen shares.
- A stream in full screen on a phone or tablet turns the screen to landscape when the video is wider than tall (where
  the browser can lock the orientation; the lock ends with full screen) and fills the screen after every rotation.
- The whiteboard on the voice stage no longer replaces the presenter's camera tile: it is a tile of its own like a
  screen share ("Whiteboard · <name>", its badge and live thumbnail, **Join whiteboard**; a double-click joins as
  well), joined it fills a large tile with focus, fullscreen and **Leave whiteboard**, and every camera tile stays as
  it is. The presenter gets a preview they can hide and a "Whiteboard is open" bar with the joined count and Close.
  The voice member list marks the presenter with a board badge next to LIVE; a double-click or Enter joins the board
  from inside the channel. A whiteboard and a focused stream sit side by side (stacked on phones), and a board wider
  than tall turns a phone to landscape in full screen like a stream.
- The camera button has a quick menu (a long press on touch, a right-click): **Front camera** and **Back camera** on
  phones and tablets (the front one by default, remembered on the device), the cameras and **Settings…** on desktops.
  A switch while the camera is on swaps the video without leaving the call; the back camera's preview is not mirrored.
- Android app: **unlock with fingerprint, face or PIN** (Android 11 and newer, tavrn-web#78). After an unlock with the
  recovery key or a passkey the app offers to seal the key of the local key store in Android's keystore (AES-256-GCM,
  every use needs the system's prompt, StrongBox where the phone has one, gone with the screen lock); the next
  start asks for a fingerprint, the face or the phone's PIN, with the recovery key as the alternative. Settings → App
  turns it off; signing out deletes the sealed key ([docs/ANDROID.md](docs/ANDROID.md)).
- Linux app: **passkeys on a security key in the app** (tavrn-web#97). With a FIDO2 security key plugged in (USB), the
  passkey sign-in and second factor, adding a passkey in Settings → Security, re-authentication and "Unlock with a
  passkey" run in the app with the node's web origin, as in the Windows app; the key's PIN is typed into a small dialog
  of the app (never into the web page), which also asks to touch the key and to choose between several keys or
  passkeys. The key's `hmac-secret` gives the same PRF output as in a browser, so the passkey unlocks the encrypted
  messages in the app too. Without a key the passkey goes through the browser as before (phones, password managers),
  and the app says it takes security keys; a key the system does not let the app open is named, with the udev rule
  in [docs/DESKTOP.md](docs/DESKTOP.md) "Passkeys on Linux". The `.deb` now depends on `libudev1`.
- Android app: an audio output switch in the voice controls (**Speaker**, **Earpiece**, **Wired headset**, **Bluetooth
  headset**, the one in use shown). A connected headset plays the call, otherwise the speaker (also in voice channels:
  a group call is not held to the ear); the choice holds while its device is connected and with the screen off.

### Fixed

- Restoring and focusing the Windows app from the tray no longer deadlocks its window (#207).
- The notification bell acknowledges messages read directly, marked read from menus or read on another session,
  preserving recent history and newer unread messages (#208).
- The account bar shows the avatar and name set on another device: the own account is taken over from the home node on
  every connection, not only at sign-in (#193).
- **Android screen share after rotating the phone**: a share started in portrait came out the wrong way round, so a
  phone turned to landscape reached the viewers as a tiny picture letterboxed into a portrait frame (#190). The
  capture now follows the phone's orientation (and a fold or unfold) and a landscape screen fills the viewers' 16:9
  tile.
- **Override editor hints**: the grey value under a neutral permission or file type of a category or channel override
  now applies the edited layer's own `@everyone` override and, for a member, the overrides of the member's roles
  (#182). A category that denies "View channel" to `@everyone` showed a neutral role as "allowed by the roles"; it now
  reads "denied by @everyone here". The permissions themselves were always evaluated correctly.
- **Message edits and uploads**: a refused edit keeps the editor open with the new text, an edit of a message that is
  not decrypted on this device is refused with a notice; removing a pending upload (or leaving the conversation)
  drops it and its key at once. A failed animated avatar falls back to the still, and a changed avatar shows again
  after a load error.
- **Reaction highlights of other people** (tavrn-node#83): a live reaction change no longer shows the reactor's own
  highlighted chips to every viewer for a moment; the client keeps its own flags from its requests and takes a change
  only when the event names you as the reactor (another tab or device).
- **Ctrl-click and middle click on an internal link no longer open the app's own page in the system browser** (#163):
  in the desktop apps and the Android app a Ctrl-, Shift- or Cmd-click or a middle click on a sidebar entry or a
  settings link opened `https://tauri.localhost/…` in the browser. Internal links now act as a plain click and open
  the view in place, the shells never hand the app's own address to the system browser, and links to other sites still
  open there; in the browser such a click still opens a tab.
- **The room views no longer render twice per room update after a "view as role" preview** (#154): the previewed
  room was handed on as a copy of the whole query result, which subscribed the sidebar, the channel page and the
  settings to every fetch-status change for the rest of the session.
- **A passkey added later unlocks the messages too** (#120): Settings → Security now says for every passkey whether it
  *unlocks messages* (its secret storage entry exists), *can unlock messages: not enabled yet* with **Enable message
  unlock** (one PRF assertion with that passkey from an unlocked device stores the entry: a passkey added while the
  device was locked, or whose assertion after the registration was cancelled), or *cannot unlock messages* with the
  reason: the authenticator did not enable the PRF extension when the passkey was created (Windows Hello does so only
  on Windows 11 24H2/25H2 with the February 2026 update or newer). Before, the badge followed the node's flag alone
  and a missing entry could not be added afterwards.
- **"Enable message unlock" for passkeys whose registration announced no PRF** (#140): some authenticators report
  the extension only when used or gain it with a system update (Windows Hello), and the node now accepts the entry
  for any passkey and marks the credential with it (tavrn-node#69). Such a passkey says *message unlock not
  confirmed* and offers the button too: one PRF assertion with exactly that passkey; with a PRF output the entry is
  stored and the passkey unlocks the messages, without one the settings show *cannot unlock messages here* with the
  reason (and the Windows versions on Windows) and keep the button for another try. Removing and adding the passkey
  again is no longer needed.

- Country flag emojis render as flags on Windows, where the system's emoji font shows regional-indicator pairs as
  letters ("DE"): the client detects the missing glyphs and registers a bundled flag-only font (Twemoji flags,
  CC-BY-4.0, see NOTICE) for messages, reactions, the emoji picker, status lines and the composer; every other
  emoji keeps the platform's font (#118).
- Member lists mark verified contacts with a small shield icon (named "verified", with the tooltip) instead of the
  text chip that cut names off; long names still truncate with an ellipsis. The member drawer is 280 px wide on
  phones and tablets in landscape (portrait keeps 240 px) (#121).
- The account menu (status, custom status, activity, sign out) no longer adds a horizontal scrollbar at the bottom of
  the sidebar: it spans the account bar instead of a fixed width wider than the sidebar (#115).
- Settings pages no longer scroll the whole app: the content of a tab (user settings, room settings, node
  administration) is the containing block of its positioned helpers, so a long Roles tab scrolls inside its own
  container and the app shell keeps its height (#116).
- Voice: your own row in the channel list can be dragged onto another voice channel to switch to it (#119); it used
  to be the only row that could not be dragged. A drag over a voice channel highlights it, a channel that cannot take
  the drop (you may not join it, or a moderator's drag without `move_members` there) shows a red outline and refuses
  it. Clicking the channel and the participant menu remain the non-drag ways.
- **Screen share sound** (tavrn-web#128): the share dialog has one choice, **No sound** or **Whole system** (and
  **This window only** where a platform can capture it, which no browser or app does today), instead of a box that
  depended on what the browser's own picker offered; a line under the choice says what it means where the client
  runs. With the whole system's sound the call's own playback is left out (`restrictOwnAudio`, Chrome and Edge 141 or
  newer on Windows and macOS, the Windows app's WebView2 included), so nobody hears themselves; where it cannot be
  left out (the Windows fallback with Electron, older browsers) the dialog starts without sound and warns. The Linux
  app, the macOS app, Firefox and Safari share no sound and say so; the Android app offers the sound of other apps
  as before ([docs/CLIENT.md](docs/CLIENT.md) "Screen share audio").

- An image pasted from the clipboard no longer keeps the name the system made up (`image.png`, `{GUID}.png` on
  Windows): it is named "Image <date> <time>.<ext>" (de: "Bild …"); a file copied from a file manager keeps its
  real name, nobody is asked (#95).
- The message composer's input row has one height again: the text field, the attach, spoiler, emoji, GIF and send
  buttons are all 40 px tall and centred, so the cursor of a single line sits in the middle of the row; the growth on
  line breaks and the focused overlay growth are unchanged (#93).
- Android app: the whiteboard's full page drew its header under the status bar (the back arrow behind the clock) and
  its canvas toolbar under the navigation bar; it now keeps to the safe areas like the other full-screen views (#82).
- Android app: the full screen button of streams and cameras did nothing (the app's webview refused the Fullscreen
  API). Full screen now fills the screen with the system bars hidden (a swipe shows them for a moment), a wide video
  turns the phone to landscape, and the back gesture leaves full screen first (issue #74).
- A device whose local key store was lost while its session lived on (the Android app killed during a call, cleared
  browser storage) no longer creates a second key for the same device when it is unlocked with the recovery key;
  every voice join then failed with "The commit is not from this device" (#83). The client now says that the device
  lost its keys and offers "Sign in again" (a new device, unlocked with the recovery key as usual); a device left in
  that state by an earlier version is found on the next start and asked the same.
- The first message after a member left a group stayed in the composer ("ghost"): the departed member's device stays
  in the encryption group until a removal goes through, the member elected to remove it may be away and everyone else
  waited ten seconds before doing it, and the message was refused meanwhile. Sending now removes the device at once and
  goes through (#86).
- The registration form follows the node's e-mail policy: "Email" and required when the node requires an address,
  "Email (optional)" when it is optional, no field when the node accepts none.
- Voice on phones: a mute now releases the microphone capture after two seconds and an unmute opens it again with the
  same device and settings (push-to-talk keeps it between key presses). On Android an open capture with echo
  cancellation keeps the phone in its call audio mode, in which remote voices played very quietly.
- Incoming calls on phones: the first tap after signing in unlocks the sound, so a later call can ring; while the
  browser still blocks the sound the banner says to tap the page, phones vibrate while it rings, and a hidden tab or a
  blocked sound shows a system notification through the service worker (with push or browser notifications on).
  Call rings are now also pushed while a tab is connected (the node change of the same release): the service worker
  stays silent while a page of the client is visible and replaces the page's own notification without a second alert.
- Desktop app for Linux: the global hotkeys also work with an X server that listens on the Linux abstract socket only
  (`@/tmp/.X11-unix/X<n>`, for example Xvfb under WSL2 with WSLg, where `/tmp/.X11-unix` is read-only). The key
  listener tried only the file socket and TCP and said "Global hotkeys unavailable" while the window itself showed;
  it now tries the display's abstract socket as well, with the same Xauthority cookie.
- Push-to-talk (#47): the other side's speaking light did light up after every press; the tests that sometimes saw it
  stay dark fed a steady test tone as the microphone, which the browser's noise suppression takes down by about 20 dB,
  close to the speaking threshold. The test microphone now plays speech-like sound, and a test covers the other side
  of push-to-talk (every press seen within five seconds, the voice well above the threshold).

### Security

- Realtime events of a node change only that node's rooms, channels, conversations, messages and member lists in the
  client's cache; ids another node lists are ignored, and notification lookups never cache another node's room under
  a home room's id.
- The desktop and Android apps use a node's announced web origin for the sign-in window and native passkeys only
  when it is bound to the node (its host, the identity domain or a subdomain of them); another site's origin is
  replaced by the node's own.
- The attachment cache is keyed by node, id and the checked hash, so a cached copy never stands in for another
  node's attachment or another hash.
- A session ended by the node (revoked elsewhere, expired) locks the key store, drops the session manager and forgets
  decrypted attachments and rendered messages, as an explicit sign-out does; signing in again needs the recovery key
  or a passkey when the account asks for it every time.
- Android: notification taps open their view through a private activity with an allow-list of the app's views; the
  exported main activity no longer takes a path from other apps' intents.
- The device's history archive hands out archived content only for the same author, device, epoch, edit and
  ciphertext; entries of the earlier format are decrypted again.
- Plaintext in end-to-end encrypted conversations is shown as "not end-to-end encrypted", never as the author's
  content (list, replies, notifications, push); a person's plaintext message without a device id is marked unverified.
- Every encrypted write path (edits, thread titles, forum posts, file records, whiteboard scenes) shows the
  unknown-device warning and encrypts nothing until it is acknowledged.
- Plaintext attachments are checked against their signed SHA-256 before they are shown or saved.
- Pinned keys and verified contacts survive a sign-out (encrypted trust record with the backups).
- Decrypted attachment and thumbnail object URLs are revoked on sign-out.
- A node reporting "no identity key" no longer makes a device with local keys set up anew; an own identity change is
  judged against the key the device follows now.
- Rendered messages are no longer edited as HTML strings after sanitising: link attributes, custom emojis, room
  emojis and bot mention badges are applied to DOM nodes, so text in a link title can no longer escape the
  attribute on browser engines that do not escape `<` in attribute values; `blob:` links are no longer kept.
- Legal documents no longer keep links starting with `/\`, which browsers resolve to another host.
- A forced sign-out (the home node refuses the session) now ends and forgets the sessions on other nodes like an
  explicit one; a new account never uses federated sessions of a previous one. Signing out also empties the cached
  room, DM and contact lists and removes the account's per-browser data.
- The first sign-in on a node the account has nothing on asks for confirmation instead of happening on a link visit.
- GIFs in messages follow the image preview setting and load without a referrer.
- Link previews while typing in end-to-end encrypted conversations are off by default (new privacy setting).
- No typing indicators are sent while the status is invisible.
- Object URLs of attachments keep only concrete image, audio and video types; "open original" only for those.
- Bidi control characters are stripped from displayed names and file names; profile links of other nodes are links
  only for http(s) and mailto, role colours only as `#rrggbb`; the confirmation dialog renders its word as text; the
  SSO start follows only an https provider URL.
- Desktop apps: the node picker's SRV step requires the target's certificate to be valid for the identity domain.
- Linux app (Electron): no spellchecker dictionary downloads at start; a package refuses remote debugging switches; the
  updater compares the whole parsed feed with the signed one and refuses web-installer packages.
- Windows app (Tauri): the sign-in window refuses downloads and permission requests; the native voice engine refuses
  plain `ws://`/`http://` LiveKit URLs except to this computer.
- The installers' terms describe the Electron app's folders, keychain item and update feeds.
- Invitations and call rings that a node forwards for a person of a third node show "via <node>" with an explanation.
- Release builds no longer see the updater signing key: a separate job in a protected `release` environment signs the
  finished installers and feeds, installs only the signer without lifecycle scripts and verifies every signature.
- The Linux packages of a release are hashed and uploaded before the end-to-end specs download and run anything; the
  specs test a copy and use a node image pinned by digest.
- CI installs `just` and `livekit-server` only from downloads with pinned checksums.
- Release assets carry GitHub build provenance attestations; the docs explain how to verify a first install against
  the signed feed.
- Self-hosted CI runners refuse `dependabot/*` branches even when a run is dispatched by hand.
- `cargo deny` checks advisories, bans and sources (not only licenses) for both desktop shells.
- The publication check prints only file and line of a private match, never the matching text.

