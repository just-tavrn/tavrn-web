# Changelog

Changes of the web client and the desktop apps, newest first. Releases are the tags `vX.Y.Z` of this repository: the
release carries the web bundle (`tavrn-web-X.Y.Z.tar.gz` with its SHA-256) and the desktop installers with their
checksums and update files. The node's container image embeds the web client of a release.

## Unreleased

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

- **Mentions stand out**: `@name`, `@name@domain`, `@Role` and `@everyone`/`@here` in messages are pills; mentions
  of yourself and @everyone/@here use the warning colour with a border, and a message that mentions you keeps its
  left border with a stronger tint (#122).
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

- **A passkey added later unlocks the messages too** (#120): Settings → Security now says for every passkey whether it
  *unlocks messages* (its secret storage entry exists), *can unlock messages: not enabled yet* with **Enable message
  unlock** (one PRF assertion with that passkey from an unlocked device stores the entry: a passkey added while the
  device was locked, or whose assertion after the registration was cancelled), or *cannot unlock messages* with the
  reason: the authenticator did not enable the PRF extension when the passkey was created (Windows Hello does so only
  on Windows 11 24H2/25H2 with the February 2026 update or newer). Before, the badge followed the node's flag alone
  and a missing entry could not be added afterwards.

- Member lists mark verified contacts with a small shield icon (named "verified", with the tooltip) instead of the
  text chip that cut names off; long names still truncate with an ellipsis. The member drawer is 280 px wide on
  phones and tablets in landscape (portrait keeps 240 px) (#121).
- The account menu (status, custom status, activity, sign out) no longer adds a horizontal scrollbar at the bottom of
  the sidebar: it spans the account bar instead of a fixed width wider than the sidebar (#115).
- Settings pages no longer scroll the whole app: the content of a tab (user settings, room settings, node
  administration) is the containing block of its positioned helpers, so a long Roles tab scrolls inside its own
  container and the app shell keeps its height (#116).
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

