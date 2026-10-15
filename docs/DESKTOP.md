# The desktop app

The desktop app is a shell around the web client: the same React client, bundled into an installable app that talks to
the home node its user picks and updates itself from the project's releases. It has two shells around that client, one
for Linux and one for Windows and macOS.

- **Tauri (Windows, macOS)**: a [Tauri 2](https://v2.tauri.app) shell in [`apps/desktop`](../apps/desktop), the pnpm
  package `@tavrn/desktop` (the Tauri CLI) and the Rust crate `tavrn-desktop` in `apps/desktop/src-tauri` with a Cargo
  workspace of its own; Windows installers `.msi` and NSIS `.exe`, and an experimental, unsigned universal build for
  macOS (`.dmg`, [macOS](#macos)). On Linux it still builds
  for development and its tests, but ships no packages ([Builds and releases](#builds-and-releases)).
- **Electron (Linux)**: an [Electron](https://www.electronjs.org) shell in
  [`apps/desktop-electron`](../apps/desktop-electron), the pnpm package `@tavrn/desktop-electron`, packaged as `.AppImage`
  and `.deb`, and as the Windows fallback below ([The Linux shell (Electron)](#the-linux-shell-electron)).

**Why Linux has a shell of its own.** The WebKitGTK that Linux distributions ship has no WebRTC and differs from one
distribution to the next ([The webview's own WebRTC on Linux](#the-webviews-own-webrtc-on-linux)), and a prototype of
video in the Tauri app's native engine showed that every video feature would have to be built twice ([Video in the
native engine, a design note](#video-in-the-native-engine-a-design-note)). Chromium brings voice, video, screen
sharing (PipeWire on Wayland), the soundboard and the background effects to Linux with the client unchanged.

**Back to Tauri later?** If a future Tauri version offers a better way to solve this on Linux (a Chromium-based or
WebRTC-capable webview), the project may move the Linux app back to Tauri. Tauri stays the shell for Windows and macOS.

**A Windows fallback.** The Electron shell is built for Windows as well, as a fallback for machines where the
integrated WebView2 causes trouble: releases attach it as `tavrn-electron_<version>_x64-setup.exe`, clearly marked as
the fallback ("full version"), and the light Tauri installer stays the recommended one ([Builds and
releases](#builds-and-releases)).

Both shells run the same client and behave alike wherever this document describes a behaviour; sections that apply to
one shell only say so.

**The Android app** is the Tauri shell built for Android (identifier `org.tavrn.app`, its own signing key): the same
crate with the desktop-only modules left out and a Kotlin side for permissions, voice in the background, push through
UnifiedPush, links and the system bars. It is described in [ANDROID.md](ANDROID.md).

## What the app is

- **It bundles the client.** The app ships `web/dist` (built by Vite, exactly what a node embeds) and its main window
  never loads remote pages. Only the bundled client may call the shell's native commands; a node can never reach them.
  This matters for the keys in the OS keychain ("Keys in the OS keychain" below). The one remote page the app shows is the node's own
  sign-in page, in a second window without any capability ("Signing in").
- **It talks to the home node you choose.** The first start shows the node picker; the client then uses that node's
  API, WebSocket and media over https and wss. Rooms and conversations of other nodes work as in the browser
  (federated sessions, [CLIENT.md](CLIENT.md) "Several nodes in one client").
- **One version number, one name.** The app's version is `web/package.json`'s (`tauri.conf.json` points at it, and
  `electron-builder.config.mjs` reads it); the product name is "tavrn" in both shells and on Android (the Windows
  start menu and desktop shortcut, the installer and its uninstall entry, the Linux menu entry and window class, the
  macOS bundle `tavrn.app`, the Android launcher), as is everything the app itself shows (window title, tray,
  notifications). The identifier is `org.tavrn.desktop` in both shells (the project domain tavrn.org). The **release
  files keep their names** from the first releases (`Tavrn_<version>_x64-setup.exe`, `Tavrn_<version>_x64_en-US.msi`,
  `Tavrn-<version>.AppImage`, `Tavrn_<version>_universal.dmg`, `Tavrn_<version>_android-arm64.apk`: the website's
  download page and the update feeds read them, [What a release carries](#what-a-release-carries)): the bundlers name
  their files after the product, so `desktop.yml` renames the Tauri bundles after the build and the AppImage's
  `artifactName` is pinned. An update from a release that was still called "Tavrn" keeps everything: the
  identifiers, the settings and profile directories, the keychain entries and the `tavrn://` links never carried the
  product name; the MSI's upgrade code is pinned to the one the bundler derived from "Tavrn"
  (`bundle.windows.wix.upgradeCode`, a test keeps it); the NSIS installer finds the old installation in registry keys
  and folders that Windows compares without case and replaces the old shortcuts.

### Security of the shell

The properties of the Tauri shell (Windows, macOS; on Linux it builds for development and tests only); the Electron shell's are in
[Security of the shell (Electron)](#security-of-the-shell-electron).

| What | Where |
|---|---|
| The main window shows only the bundled client: `tauri://localhost` (Linux), `https://tauri.localhost` (Windows), in development the Vite dev server. Every other navigation is refused; web links (http, https, mailto) open in the system browser, new windows are never opened. Internal links never leave the app: a new-window request for the app's own address (a Ctrl-click or a middle click) is refused, never handed to the system browser. The click-to-play embeds load in their frames. | `src-tauri/src/guard.rs`, `src/lib.rs` |
| Content Security Policy: scripts only from the bundle (`script-src 'self' 'wasm-unsafe-eval'`, no eval, no inline scripts, no third-party scripts), `connect-src` https and wss to any node plus plain http/ws to `localhost` and `127.0.0.1` (development nodes), images and media from https, frames only for the embed providers. | `tauri.conf.json` `app.security.csp` |
| One capability for the main window: the app's commands, nothing else (no `remote` origins, no plugin or core permissions, no global Tauri object). No capability names the sign-in window (a test checks every capability file). | `src-tauri/capabilities/main.json`, `build.rs`, `src-tauri/src/conf_tests.rs` |
| The sign-in window (`connect`) shows only the chosen node's `/connect?session=…` page (`open_connect` checks origin, path and parameters) and follows https pages from there (identity providers redirect), plain http only on this computer; it never loads the bundled client or `tauri:`, `file:`, `data:`, `javascript:` or `blob:` URLs, and new windows go to the system browser. It refuses every download and every permission request (microphone, camera, location, notifications; a test checks both handlers). The node's web client there runs as a plain web client: only the main window counts as the app (`platform/tauriDetect.ts`). | `src-tauri/src/guard.rs`, `src/lib.rs` |
| The microphone and the camera are granted to the main window without a prompt of the webview (it shows only the bundled client); screen capture and every other permission keep the webview's default. | `src-tauri/src/media.rs` |
| The node URL is validated twice: in the client and again in the shell before it is stored. | `web/src/platform/nodeUrl.ts`, `src-tauri/src/node_url.rs` |
| `tavrn://` links are checked by the shell before the client sees them (a domain as the node, tokens, the handoff's session and state; nothing else), and the client asks before it opens one ("Links into the app"). The deep-link plugin has no permission in any capability. | `src-tauri/src/deeplink.rs`, `web/src/components/DeepLinkPrompt.tsx` |
| Downloads are written by the shell: the webview names only a file name to suggest and a save's id, never a path; the user picks the target in the native save dialog, the shell writes a temporary file next to it and renames it into place. The dialog, opener and fs plugins have no permission in the webview. | `src-tauri/src/download.rs` |

Unit tests in `src-tauri/src/conf_tests.rs` keep these properties of `tauri.conf.json` and the capability from eroding.

### The platform layer of the client

`web/src/platform/` decides where the client's node lives. The interface `Platform` (`types.ts`) has three
implementations: `browser.ts` (today's behaviour: the node is the origin the client was loaded from), `tauri.ts` (the
Tauri shell), detected at start with `isTauri()` from `@tauri-apps/api`, and `electron.ts` (the Electron shell),
detected by the bridge its preload exposes (`electronDetect.ts`). `initPlatform` tries Tauri, then Electron; both are
loaded lazily, so the browser never runs shell code. Everything that imports Tauri APIs lives under `platform/tauri*`;
the Electron shell is reached only through `window.tavrnShell` (`platform/electron*`). Both report `kind: "desktop"`:
the client does not care which shell it runs in. The table names the Tauri commands; the Electron bridge has the same
methods in camelCase.

| Member | Browser | Desktop |
|---|---|---|
| `nodeBase()` | `""` (same origin) | the chosen node, e.g. `https://tavrn.example` |
| `webOrigin()` | `location.origin` | the chosen node (links for other people: invites, messages, channels) |
| `openExternal(url)` | new tab | system browser (shell command `open_external`, http/https/mailto only) |
| `appVersion()` | `web/package.json` | the installed app |
| `node` | — | the chosen node with its identity domain and web origin; `set(url, details)` validates and persists them (shell command `set_node`), `resolve(domain)` finds the node of an address (shell command `resolve_node`) |
| `auth` | the connect flow with this origin (redirect to `<web>/connect`, back at `/connect/callback`) | the sign-in on the node's page: an app session, the page in the sign-in window (`open_connect`), polling, the exchange with the PKCE verifier, `close_connect` |
| `updater` | — | signed updates (absent while the build has no updater key) |
| `hotkeys` | — | system-wide hotkeys: `register(action, combo)`, `unregister(action)`, `subscribe(handler)`, `setEnabled(signedIn)` (shell commands `register_hotkey`, `unregister_hotkey`, `listen_hotkeys`, `set_hotkeys_enabled`) |
| `keystore` | — | the OS keychain for the key of the local key store (commands `keychain_get`, `keychain_set`, `keychain_delete`, `keychain_status`) |
| `notifications` | — | native notifications and their clicks (`notify`, `shell_events`) |
| `tray` | — | the tray icon with the voice state, close to tray, quit (`tray_set`, `tray_status`, `set_close_to_tray`, `quit_app`) |
| `saveFile(file)` | the browser's download (an anchor with `download` on an object URL) | the native save dialog, the shell writes the file ("Downloads"; `save_file_begin`, `save_file_chunk`, `save_file_end`, `save_file_abort`, `save_file_reveal`) |

The helpers `apiBase()`, `originUrl()`, `originWsUrl()`, `webOrigin()`, `originHost()` and `allowsInsecureNodes()`
of `platform/index.ts` are the single place the API client (`lib/api.ts`), the WebSocket, node discovery
(`stores/nodes.ts`) and the link builders take the node from.

## The node picker

On the first start every path shows the node picker (`/node`). It asks for **your address** (`alice@tavrn.example`, or
just the domain `tavrn.example`): the shell finds the node of that identity domain as FEDERATION.md §1.4 says, the app
keeps the identity domain and the endpoints (they may live on another host: delegation) and continues on the login
page with the username filled in. The resolution runs in the shell (`src-tauri/src/resolve.rs`, the Electron shell's
`resolve.ts`; a browser cannot query DNS, and before the first sign-in there is no node to ask):

1. `https://<domain>/.well-known/tavrn`, validated (`tavrn` = 1, `domain` equal, endpoints https/wss without
   credentials, query or fragment, `api` ending in `/api/v1`);
2. after a `404` or without an HTTPS server: the `_tavrn._tcp.<domain>` SRV records (system resolver, at most 3
   targets, lowest priority first, then highest weight), whose document must name the domain. The shell connects to
   the target's host and port but asks for the identity domain (TLS SNI and `Host` are the domain), so the target's
   certificate must be valid for the domain: a forged DNS answer pointing at a server with a certificate only for its
   own name ends in "cannot reach \<domain>". This is why a TLS failure of step 1 may still lead to SRV;
3. after a `404` only: `https://<domain>/api/v1`.

Errors are distinct and name the step that failed: "no node found for \<domain>", "the node's document is invalid",
"cannot reach \<domain>" (DNS or TLS failure, nothing listening). A development node on this computer is asked over
plain http (`alice@localhost:8080`). The login page of the app takes an address as well and switches the node when the
domain is another one.

**Advanced: node URL** is the picker of the earlier versions, for development nodes and special setups: the address of
the home node as you open it in the browser (`https://tavrn.example`; without a scheme https is assumed). Rules:

- https only; plain http only for a node in development mode on this computer: `http://localhost:<port>` and
  `http://127.0.0.1:<port>`;
- no user name or password, no path, query or fragment: the result is the origin;
- the node must answer its discovery document (`/.well-known/tavrn`) with its domain (`localhost` for a development
  node);
- the shell validates the address again and stores it in `config.json` in the app's config directory
  (Linux `~/.config/org.tavrn.desktop/`, Windows `%APPDATA%\org.tavrn.desktop\`; the Electron shell:
  `~/.config/tavrn-desktop/settings.json`, same schema). A missing or corrupt file means "no node yet"; a stored address
  that no longer passes the validation is dropped.

**Settings → App** (only in the app) shows the version, the node with "Change node" (the picker again; changing the
node signs out of the old one first), the updates, where the keys of this device are kept, close to tray and Quit.

## Keys in the OS keychain

The client keeps the account's encryption state in its local key store (IndexedDB, `web/src/crypto/store.ts`): the
master secret and the MLS client state with the device key, encrypted with AES-256-GCM under the account's *local
storage key*, which is derived from the master secret and the device id. A browser persists that key next to the data
(a non-extractable WebCrypto key in IndexedDB). The app keeps it in the OS keychain instead:

- **What is in the keychain:** exactly one 32-byte secret per account, the local storage key. That is the cleanest
  cut: it fits every keychain (the Windows Credential Manager limits a secret to 2560 bytes; the MLS state grows with
  the groups), and everything else of the store stays as in the browser. IndexedDB then holds ciphertext only.
- **Where:** the Secret Service on Linux (GNOME Keyring, KWallet), the Credential Manager on Windows, the Keychain on
  macOS later; through the keyring crates (`keyring-core` with `zbus-secret-service-keyring-store`,
  `windows-native-keyring-store`, `apple-native-keyring-store`), off the main thread. The Linux app (Electron) keeps the
  key with Electron's `safeStorage` under a secret in the same keyring: [Keys in the OS keychain
  (Electron)](#keys-in-the-os-keychain-electron).
- **Entries:** service `org.tavrn.desktop`, user `local-key/<home node origin>/<account address>`. The shell takes the
  node from its settings file, never from the page, and accepts only plain account addresses and 32-byte values.
- **Migration:** on the first start of a store of the browser kind (a key in IndexedDB) the client writes the key into
  the keychain, reads it back and compares, and only then removes the IndexedDB copy. This repeats at every start until
  it works.
- **Fallback, never silent:** without a keychain (no Secret Service on a bare Linux session, a locked or refusing
  keychain) the key stays in or returns to IndexedDB, exactly the browser's behaviour, and Settings → App shows a
  warning. When the keychain answers again, the next start moves the key. A missing keychain entry (deleted by hand)
  locks the store until the recovery key or a passkey unlocks it, which writes the entry again.
- **Lifecycle:** signing out deletes the entry with the local data; "Require the recovery key or a passkey every time"
  (lock on close) deletes it and stores nothing; turning that off writes it again.

**Threat model.** The keychain protects the local key store against someone who copies or reads the app's files (a
backup, another user account, a stolen disk without full-disk encryption): IndexedDB alone opens nothing. It does not
protect against malware running as the same user while the session is unlocked (it can ask the keychain too, as it can
read the client's memory), nor does it replace the recovery key. Who can reach the entries:

| Who | Can | Cannot |
|---|---|---|
| The bundled client in the main window | read and write the entries of the current home node's accounts (it needs them to unlock) | reach entries of another service; store anything but 32-byte keys |
| A node (any node, the home node included) | nothing: the app never loads its pages, the node gets API calls only, never key material (end-to-end encryption unchanged) | call any command |
| Embedded players (frames of the click-to-play providers), remote pages | nothing: the capability has no `remote` origins and covers the main window's own origin only | call any command |
| Other programs of the same user | ask the keychain like any program of that session (the OS decides; GNOME Keyring and the Credential Manager do not prompt per program) | — |

## Notifications

While the window is not focused, mentions, direct messages and incoming calls (whatever the notification settings let
through) become native notifications; while it is focused, the client shows its toasts as in the browser. Encrypted
messages show a fixed text, never their content. Settings → Notifications has a switch for this device ("System
notifications while tavrn is in the background"); the web push section and the browser permission switch are not shown
in the app, and the app never registers a service worker or a push subscription.

The Linux app shows them with Electron's `Notification` ([Notifications (Electron)](#notifications-electron)); the Tauri
shell (Windows, macOS) shows them with notify-rust (the backend of tauri-plugin-notification; the plugin itself offers no click
events on desktop and would replace the webview's `Notification` with an IPC bridge that needs plugin permissions):

| Platform | Shown by | Click |
|---|---|---|
| Linux | the desktop's notification server (D-Bus) | focuses the window and opens the conversation (the server's default action; GNOME, KDE and most others support it) |
| Windows | a toast under the app's id (the installer's Start menu entry; a development build shows the default id) | focuses the window and opens the conversation while the toast is on screen; a toast clicked later in the notification center starts the app, and the running one comes to the front (to be confirmed by hand on Windows) |
| macOS | (later) | — |

## Downloads

The Tauri shell's webviews (WebView2, WebKitGTK) do nothing with the blob downloads a browser handles, so every download
of the client (attachments, files channels, the data export, recovery keys and codes, whiteboard images) goes through
one entry point, `saveFile({ name, data, mime })` in `web/src/platform/saveFile.ts`. In the browser it is the anchor
download of before; in the app the shell shows the native save dialog and writes the file (the Tauri shell's `src-tauri/src/download.rs`
below; the Linux app's `downloads.ts` has the same methods, see [Downloads (Electron)](#downloads-electron)):

| Command | What it does |
|---|---|
| `save_file_begin(name, size)` | shows the save dialog (the name, cleaned of path parts and characters Windows refuses, is its suggestion; a filter for its extension) and answers `{ status: "ready", id }`, or `{ status: "cancelled" }` when the user closes it; at most 8 saves at once |
| `save_file_chunk` | appends a raw IPC body (header `x-tavrn-save: <id>`) to a temporary file next to the target; the client streams the blob in 4 MiB slices, so a large decrypted file never sits twice in memory; more bytes than `size` are refused |
| `save_file_end(id)` | checks that `size` bytes arrived, flushes the file and renames it into place; answers the path and the name of its folder |
| `save_file_abort(id)` | removes the temporary file (the client calls it when reading or writing fails) |
| `save_file_reveal(id)` | shows a finished save in the file manager (by its id: the webview never names a path) |

After a save the client shows "Saved to \<folder>" with a **Show in folder** button (in the live region of the toasts);
a cancelled dialog shows nothing. Previews and playback keep their object URLs. A download the webview still starts by
itself (an `<a download>` or a navigation to a file) is caught too: the webview writes it into the app's cache, then
the same save dialog asks where it goes (cancelled: the file is removed).

Test hook: when the app starts with `TAVRN_DESKTOP_TEST_SAVE_DIR=<dir>`, no dialog is shown and every save goes into
that directory (never overwriting: `name (1).ext`). It exists for the tests only (the Electron shell's smoke test; the
Tauri shell keeps it for its own); never set it otherwise.

## Tray and close to tray

The tray icon is the logo with a badge for the voice state; the icons are drawn at start from the bundled logo
(`icons/128x128@2x.png`): the logo is cropped to its visible mark and scaled to fill the 32 px canvas with at most 1 px
of margin (a unit test checks at 16, 22 and 32 px that the mark covers at least 85 % of the canvas), so it is as large
as its neighbours in the tray. Each badge has a dark outline, so it stands out on light and dark panels and against the
teal logo:

| State | Icon |
|---|---|
| not in a voice channel | the plain logo |
| in a voice channel | green badge |
| speaking (push-to-talk or voice activation lets the voice through) | white badge with a green ring |
| microphone muted | amber badge with a bar |
| deafened (speakers and microphone; wins over muted) | red badge with a cross |

The tooltip names the channel and the state ("tavrn · Lounge (Gaming) · Speaking"). The voice store drives it at most
every 150 ms, so speaking does not make the icon flicker. The menu (right click; in the Tauri shell on Linux any click):
Show/Hide tavrn, Mute microphone, Deafen, Leave voice channel, Quit tavrn; a left click on Windows shows the window.

**Close to tray** is on by default on every platform: closing the window hides it and the app keeps running (voice,
notifications). The tray menu brings it back, and so does starting the app again (a second start shows the running app
instead of opening another one; the Tauri shell on Linux needs the D-Bus session bus for it). Quit is in the tray menu
and in Settings → App, where close to tray can be turned off. GNOME shows tray icons only with the AppIndicator
extension; without it, start the app again to get the window back. The Linux app draws the same icons in its Electron
shell ([Tray and close to tray (Electron)](#tray-and-close-to-tray-electron)).

## Icons

The app icons are generated from the project logo, cropped first (the web icon keeps a wide margin for the browser's
masks; a window, taskbar or tray icon should fill its canvas):

```sh
magick web/public/icon-512.png -trim +repage -set option:side "%[fx:round(max(w,h)*32/30)]" -background none \
  -gravity center -extent "%[side]x%[side]" -resize 512x512 /tmp/tavrn-icon.png
pnpm --filter @tavrn/desktop tauri icon /tmp/tavrn-icon.png
```

This writes `src-tauri/icons/` (32, 64, 128 and 256 pixel PNGs and `icon.png` for Linux and the window, `icon.ico` for
the Windows installer, taskbar and window, `icon.icns` for macOS later); delete the generated `android/` (the Android
app's launcher and notification icons live in its project, `gen/android/app/src/main/res`, drawn from
`web/public/icon-512.png` on a white adaptive background, [ANDROID.md](ANDROID.md)), `ios/` and
Windows Store images, the app does not use them. Unit tests check that every icon of `tauri.conf.json` exists and that
the PNG icons fill at least 85 % of their canvas. The Electron shell's packages take the same icons from
`src-tauri/icons/` (`electron-builder.config.mjs`). The logo and the icons are not covered by the Apache License
([TRADEMARK.md](../TRADEMARK.md)).

## Licence and terms in the installers

`apps/desktop/LICENSE.txt` is what the installers of both shells show or carry: the Apache-2.0 licence of the app, its
NOTICE and the terms of use and privacy notice ([`apps/desktop/TERMS.md`](../apps/desktop/TERMS.md): no warranty, the
chosen node's operator handles accounts and content, update checks go to GitHub, no telemetry, what the app stores and
how to remove it, embedded players only after a click, contact). It is generated: edit `TERMS.md` (or the licence or
NOTICE) and run `pnpm --filter @tavrn/desktop license-txt`; a test fails while the committed file is not current, and it
must stay plain ASCII (the NSIS page shows it as is).

| Installer | Licence |
|---|---|
| Windows NSIS (`-setup.exe`, Tauri) | a licence page that must be accepted before installing (`bundle.licenseFile`) |
| Windows MSI (Tauri) | the licence dialog of the installer |
| Windows NSIS (`tavrn-electron_…-setup.exe`, the Electron fallback) | the same licence page to accept (`nsis.license` in `electron-builder.config.mjs`) |
| Linux `.deb` (Electron) | no accept step (Debian packages have none); the file is installed as `/usr/share/doc/tavrn/LICENSE.txt` |
| Linux AppImage (Electron) | no installer, no accept step; the terms are in the repository and on the release page, and the AppImage carries the file as `resources/LICENSE.txt` |

## Signing in

Passkeys are bound to the node's domain, the captcha to its host names and single sign-on to its web client: none of
them can run on the app's own origin. On nodes that announce `connect.app` (app sessions of the connect flow,
FEDERATION.md §8 step 3) the app signs in on the **node's own page** instead:

1. The login page offers "Sign in on \<node>'s page" and takes it by itself for "Sign in with a passkey", the SSO button
   and whenever the node asks for a captcha (login or registration: the registration then happens on the node's page).
2. The app creates an app session with a PKCE challenge (`POST /auth/connect/session`) and a fresh X25519 key pair,
   and the shell opens `<web>/connect?session=…[&method=passkey|sso]#k=<public key>` in the sign-in window, which has
   no native API at all. The passkey and SSO buttons add `method=`: the page starts that method at once and shows only
   "Signing in with a passkey…" with "Use another method". The key is in the URL fragment, which never reaches a
   server; the page keeps it for the window's session and removes it from the address bar.
3. The user signs in there with any method (password and second factor, passkey, SSO, registration with captcha) and
   confirms "Sign in to the tavrn app?" with the app's device name; the page says "return to the app". The page never
   creates device keys and skips the encryption step. After a passkey ceremony with the PRF extension (the passkey
   login, a passkey as second factor, or, when the app asked for the passkey and the page was already signed in, an
   assertion at the confirmation) the page seals the credential id and the PRF output to the app's key and sends the
   box with the confirmation ("sealed unlock material", FEDERATION.md §8 step 3).
4. The app polls the session every 2 seconds, gets the one-time code (and the sealed box) once, exchanges the code
   with its verifier (`POST /auth/connect/token`) for a session of its own device, closes the window and continues like
   after any sign-in: device keys are created in the app, and **the passkey unlocks the encrypted messages exactly as in
   the browser** (the app opens the box and unwraps the master secret from the secret storage entry of that passkey).
   Without a box (another method, a passkey without PRF, a node or page without the feature) or when it does not open,
   the recovery key unlocks them (or sets them up for a new account).

**Unlock with a passkey later.** An app that is signed in but locked (signed in with password and TOTP, a missing
keychain entry, lock on close) offers "Unlock with a passkey" on its unlock screen when the account has a passkey
entry and the node announces `connect.app`. The app creates an *unlock* session with its own session (`purpose:
"unlock"`), checks with one poll that the node knows it (otherwise it says so and keeps the recovery key), and opens
the sign-in window with `method=passkey`. The page asks only for the passkey ("Unlock the tavrn app?"; after a passkey
sign-in there it needs no second ceremony) and returns the sealed box without a code; the node accepts it only from
the account the app is signed in with. The app unlocks and stores the master secret in its (keychain-protected) local
key store.

The node only ever holds the sealed box, which it cannot open, hands it out once and never logs it. The trust is the
browser's: the node's web client in the window sees the PRF output, as it does in a browser tab. The box is libsodium's
sealed box (the construction of the webhook inbox keys), through the functions `@tavrn/crypto` already has
(`web/src/crypto/sealedUnlock.ts`).

While it waits the app offers "Open the page again", **"Open in the browser instead"** (the same page in the system
browser; the app keeps polling) and "Cancel" instead of its own form. On Linux the sign-in window cannot use passkeys
(WebKitGTK has no WebAuthn, and Electron offers no WebAuthn dialog of its own on Linux) and the app says so: passkeys
work through the browser there (the key in the fragment goes along, so the passkey unlocks the app from the browser
too), unless they live on a security key, which the Linux app uses itself ([Passkeys on Linux](#passkeys-on-linux));
on Windows (WebView2) they work in the window. Nodes without `connect.app` keep password and TOTP in the app;
their passkeys, SSO and captcha need a browser.

**The page's own session after the handoff.** Signing in on the node's page creates a session (a device) of the page
itself. In the sign-in window the page signs that session out once the handoff is done, so no orphan device of the page
stays in the account's device list: after an unlock at once (nothing is exchanged), after a sign-in as soon as the app
has exchanged the code (the node accepts a code only while the page's device still has a session, so the page watches
its own device list until the app's device appears or its last login moves; once the code expired after 120 seconds it
signs out anyway). The app continues at once and closes the window a few seconds later (`APP_CLOSE_GRACE_MS` in
`web/src/platform/appSession.ts`), after the page signed out. The page knows the sign-in window by the Tauri window
label `connect` (`inSignInWindow`, `web/src/platform/tauriDetect.ts`), in the Electron shell by a marker in its user
agent ([The node picker and signing in (Electron)](#the-node-picker-and-signing-in-electron)). The same page in a
browser tab (the Linux fallback, "Open in the browser instead") keeps its session, as a browser user expects. The
window's storage is persistent, not private: the node's page keeps its local settings (such as the language) between
handoffs; only the session goes, so every handoff asks for a sign-in on the page.

### Passkeys on Windows

The app's own window (WebView2 at `https://tauri.localhost`) can never run a passkey of the node: the relying party id
(`tavrn.org`) does not cover that origin. The Windows app therefore runs the ceremony **natively**, through the Windows
WebAuthn API (webauthn.dll, Windows 10 1903 and newer; the dialog of Windows Hello, security keys and phones), as a
browser does on Windows (`src-tauri/src/passkey.rs`, the commands `passkey_create` and `passkey_get`):

- The client passes the node's options unchanged (`web/src/platform/tauriPasskeys.ts`); the shell writes
  `clientDataJSON` itself with the **web origin of the node the app is connected to** (the settings' `web`, else the
  node URL; never an origin from the page) and refuses a relying party id that this origin's host is not equal to or a
  subdomain of (`passkey.refused`). The node verifies the result as it verifies a browser's: no node setting is
  needed for the Windows app.
- It answers with the credential as `PublicKeyCredential.toJSON()`; the PRF output (`prf.results.first`) travels
  apart, for the key store only, and never reaches the node.
- `app_info` reports `passkeys: true` when webauthn.dll is there (it is loaded at the first use from System32, so the
  app also starts without it). The client then runs registration (Settings → Security and at registration), the
  passkey sign-in and second factor, re-authentication and "Unlock with a passkey" in the app; "Sign in on
  \<node>'s page" stays for single sign-on and the captcha.
- **PRF (the key store unlock).** The shell asks for the PRF where the system offers it: at registration
  `bEnablePrf` (webauthn.h API version 6) or the hmac-secret extension (before), at an assertion the PRF input as
  `pHmacSecretSaltValues` (API version 4 and newer), which Windows turns into the hmac-secret salt exactly as WebAuthn's
  PRF extension does, so the output equals a browser's for the same passkey. At registration Windows reports only
  whether the authenticator enabled the PRF (`bPrfEnabled`; the PRF output at creation needs API version 8 and
  attestation version 7, which the `windows` crate this build uses does not have): the client therefore runs one
  more assertion right after the registration to store the passkey's secret storage entry, or offers **Enable message
  unlock** in Settings → Security later (CLIENT.md "Accounts and sign-in"). Security keys with hmac-secret enable
  it. **Windows Hello** (the platform authenticator) reports the PRF only on Windows 11 24H2 (build 26100.7840) and
  25H2 (26200.7840) with the February 2026 cumulative update (KB5077181) or newer; Windows 10 and earlier Windows 11
  builds never: such a passkey signs in, and the settings offer **Enable message unlock** for it as for any passkey
  without an entry: one assertion with that passkey stores the entry when it gives a PRF output (the node accepts it
  for any credential and marks the credential as PRF-capable), else the settings say "cannot unlock messages here"
  with that reason and keep the button, so after the update the same passkey is enabled without removing it. Phones (hybrid) depend on the phone's authenticator. Without a PRF output the passkey still signs in, and
  the app unlocks its key store from the OS keychain as before (or with the recovery key on a new device).
- Errors become the browser's: cancelled, timed out or no matching passkey → "The passkey prompt was cancelled";
  an excluded authenticator → "already holds a passkey".

On Linux the Electron shell runs passkeys on FIDO2 security keys itself ([Passkeys on Linux](#passkeys-on-linux));
on macOS they go through the node's page in the browser ([macOS](#macos)).

### Passkeys on Linux

Linux has no system WebAuthn API, Electron offers no WebAuthn dialog there, and the app's window (`app://tavrn`) can
never run a passkey of the node anyway. The Linux app (the Electron shell) therefore talks to **FIDO2 security keys
over USB** itself, with the contract of the Windows app (`passkey_create`, `passkey_get`; on the bridge
`passkeys.passkeyCreate`, `passkeys.passkeyGet`):

- The client passes the node's options unchanged; the shell takes the **web origin of the node the app is connected
  to** from its settings (`web`, else the node URL; never the page's), writes `clientDataJSON` with it as a browser
  does and hands its SHA-256 to the key; a relying party id this origin's host is not equal to or a subdomain of is
  refused (`passkey.refused`) before any key is asked. The node verifies the answer as a browser's; no node setting
  is needed. The answer is `PublicKeyCredential.toJSON()` (the attestation replaced by `none`, as browsers do when the
  node asks for none), the PRF output apart, for the key store only.
- **CTAP2 over USB HID** through the native module `apps/desktop-electron/native/passkeys` (napi-rs, like the key
  listener): its crate `fido/` maps the options to the requests of Mozilla's `authenticator` crate, a browser's CTAP
  library on Linux, with its pure-Rust crypto (no OpenSSL, no NSS). It finds the keys through udev (`libudev.so.1`,
  which every systemd distribution has; the `.deb` depends on `libudev1`), also keys plugged in while it waits, lets
  the user pick one of several by touching it, and speaks the PIN protocol (versions 1 and 2) when the node asks for
  user verification. Discoverable credentials (resident keys) where the key can store them, so "Sign in with a passkey"
  works without a user name; the node asks for them as "preferred".
- **The PRF (the key store unlock)** is WebAuthn's `prf` extension over the key's `hmac-secret`: the crate derives the
  salt as WebAuthn does (SHA-256 of `"WebAuthn PRF"`, a zero byte and the input), so a security key gives the same PRF
  output in the app as in a browser, and a passkey registered in either unlocks the encrypted messages in both. Keys
  without `hmac-secret` (older FIDO2 keys, U2F-only keys) still sign in; the recovery key unlocks.
- **The shell's dialog.** A ceremony opens a small modal window of the shell over the app (`src/main/passkey_window.ts`,
  `passkey_dialog.ts`, its preload `src/preload/passkey.ts`; static page, no script, the screen-share picker's
  hardening): "Plug in your security key and touch it", "Touch your security key", "touch the one you want to use"
  for several keys, the choice between several passkeys of the site on one key, and **the key's PIN**. The PIN is
  typed into that dialog, goes from there to the main process and the module, which hashes and encrypts it for the
  key's PIN protocol; it never passes through the web page, and nothing stores or logs it. A wrong PIN is asked again
  with the tries the key has left; a blocked PIN, too many wrong PINs, or a key without a PIN when the node requires
  user verification end the ceremony with a message in the dialog (`passkey.failed` to the client). Cancel, Escape or
  closing the dialog cancels (`passkey.cancelled`, the key stops blinking); the shell's timeout is the Windows app's
  (the node's, 30 s to 10 min). English or German after the system's language.
- **When the app offers it.** `passkeys.passkeyStatus` answers whether the module is there and how many FIDO keys are
  plugged in (HID interfaces with the FIDO usage page 0xF1D0 in sysfs; the keys are not touched) and how many of them
  the app may open. The client asks on demand: when a view with a passkey button appears, every 2 seconds while it is
  shown and when the window gets the focus (`usePasskeyBlocker` in `web/src/lib/passkeys.ts`). With a key plugged in,
  registration (Settings → Security and at registration), the passkey sign-in and second factor, re-authentication and
  the PRF unlock run in the app. Without one the passkey goes through the node's page in the browser as before
  ("Signing in"), and the app says that it takes security keys itself; the passkey form asks to plug one in.
- **Access to the key (udev).** The key's device node `/dev/hidraw*` belongs to root; systemd (244 and newer) marks
  FIDO keys (`60-fido-id.rules`) and gives the user of the local seat access (`70-uaccess.rules`), so on current
  distributions (Ubuntu 20.04, Debian 11, Fedora 32 and newer) nothing has to be set up. Where a key is plugged in but
  the app may not open it, Settings says so. On a system older than systemd 244, install the distribution's rules
  for FIDO keys (`libu2f-udev` on Debian and Ubuntu, the `libfido2` package's `70-u2f.rules` on Fedora and others).
  Where nobody holds a seat (no systemd-logind, so no `uaccess`), a rule gives a group access instead (as root; the
  user joins the group, then unplug and plug in the key):

  ```sh
  cat > /etc/udev/rules.d/70-tavrn-fido.rules <<'RULE'
  # FIDO security keys (HID usage page 0xF1D0, marked by systemd's fido_id): read and write for the group plugdev
  KERNEL=="hidraw*", SUBSYSTEM=="hidraw", ENV{ID_FIDO_TOKEN}=="1", GROUP="plugdev", MODE="0660"
  RULE
  udevadm control --reload-rules && udevadm trigger
  ```

  The `.deb` ships no rule of its own: systemd's covers every key on a desktop, and a rule of the app could only widen
  the access.
- **Not supported** (those passkeys keep going through the browser): platform authenticators such as fingerprint
  readers through fprintd (they are not FIDO authenticators, and Linux has no system passkey store), passkeys on a
  phone (hybrid over Bluetooth), password managers, keys over NFC readers or Bluetooth (the library has USB HID only).
  The Windows fallback build of the Electron shell has no native passkeys (the Tauri app has the Windows API).

## Links into the app

The apps open `tavrn://` links: the Windows installers register the scheme (tauri-plugin-deep-link; a second start
hands its link to the running app through the single-instance plugin), the Linux packages carry it in their `.desktop`
entry (`x-scheme-handler/tavrn`) and the Electron shell claims it at start (`app.setAsDefaultProtocolClient`; a second
start hands its link over in `second-instance`), the Android app has an intent filter next to its App Links
([ANDROID.md](ANDROID.md) "Links into the app"). A development build registers nothing (the Tauri one registers itself
on Windows and Linux).

| Link | Opens |
|---|---|
| `tavrn://invite/<node>/<code>` | the invite page of `<node>` (`/invite/<code>`; another node's with `?node=<its identity domain>`) |
| `tavrn://room/<node>/<room>[/<channel>]` | the room or channel (`/rooms/…`, another node's under `/n/<domain>/rooms/…`) |
| `tavrn://add/<node>/<id>`, `tavrn://add/<node>/<domain>/<id>` (optional `?room=`) | an application's add link |
| `tavrn://connect?session=<id>&state=<state>` | nothing: the browser's way back to the app after the sign-in on the node's page |

`<node>` is the node's host as its web links name it (its identity domain or its web client's host; the client finds
the identity domain as for invites). **Rules** (`src-tauri/src/deeplink.rs`, the Electron shell's `deeplink.ts`, again
in the client's `platform/deepLinks.ts`): `<node>` is a domain name with a dot (no port, no address, no `localhost`, so
a link never points the app at this computer), codes and ids are base64url of at most 64 characters, `connect` takes
exactly the 43-character session id and a 16 to 128 character state (the rules of the sign-in window's
`open_connect`), no fragment, no other parameter, at most 512 bytes. Everything else is dropped by the shell.

**The client shows the target before it acts.** A link never navigates by itself: a dialog names what it opens ("An
invite to a room on chat.example", "A channel of a room on chat.example") and shows the link; only **Open** goes there,
Cancel (focused first) and Escape drop it. An app without a home node yet offers **Choose node**: the node picker with
the link's node filled in, and the link is offered again once a node is chosen. Links that arrive before the client
listens (the link that started the app) wait in the shell (Tauri: with the notification clicks, then in the client's
platform until the prompt subscribes, `linkEvents` in `platform/shellEvents.ts`; Electron: until the client takes
them, `shell.takeLinks`).

**Back to the app after the sign-in** (RFC 8252 style). When the node's page ran in a browser (the Android app's Custom
Tab, "Open in the browser instead" on the desktop) its last screen offers **Open the tavrn app**, the link
`tavrn://connect?session=…&state=…` of that handoff. The app acts on it only when session and state are the ones of
the sign-in or unlock it waits for, and then only polls at once (at most every 2 seconds as always) and comes to the
front; the one-time code still comes from the node and is exchanged with the PKCE verifier, so the link carries no
secret. A phone that held back the app's timers while the browser was in front continues at once.

**The website's invite page** (tavrn.org) can offer "Open in the app" with `tavrn://invite/<node>/<code>` next to
the link to the web client; that is a change of the website.

## Game activity

**Opt-in, off by default.** Settings → App → **Show the game I am playing** lets the app set the device's activity
"Playing \<game>" (PROTOCOL.md §6a, `PUT /users/me/activity` to every node the client has a session on) while a game of
its list is in front, and clear it when the game closes, another program comes to the front, the setting goes off or
the client signs out.

- **The list** is visible and editable in the same place: a built-in list of well-known games (`web/src/games/known.ts`,
  process names of their Windows and Linux executables; each can be switched off) and the user's own entries (a
  process name such as `game.exe` without a folder, at most 64 bytes, and the name to show, at most 128 characters).
  The setting and the list stay on this device (`tavrn.games` in local storage).
- **The shell watches** only while the setting is on and the client is signed in: every 5 seconds it asks which program
  is in front and compares its **process name** with the list (without case and `.exe`; Linux' 15-byte `comm` of a
  Wine or Proton game matches the start of a longer name). Windows: `GetForegroundWindow`, the process with the least
  access right (`PROCESS_QUERY_LIMITED_INFORMATION`), the file name of its executable. Linux: the window manager's
  `_NET_ACTIVE_WINDOW` on X11 (also X11 programs under XWayland, which most games are), its `_NET_WM_PID`, the file
  name of `/proc/<pid>/exe` and its `comm`; a native Wayland window has no such answer, and then nothing is shown (the
  setting says so). macOS: nothing yet.
- **What leaves the shell**: only the display name of a listed game, as the shell event `game` when it changes. Window
  titles are never read; the names of other programs never leave the native code (`apps/desktop/crates/keywatch`
  `games.rs`, shared by both shells: the Tauri shell's `games.rs` command `games_watch`, the Electron shell's
  `games.ts` through the native module's `foregroundGame`).
- **The client** (`web/src/games/activity.ts`) publishes nothing for a user with "Hide my activity", never replaces an
  activity it did not set (one chosen in the status menu or one of an application's activity bridge) and clears only
  its own.

## Hotkeys

Push-to-talk and the priority speaker (while held), mute and deafen (toggles) have **one binding each**, and it works
in the window and system-wide, also while the app is in the background or minimized and a game has the focus. The
push-to-talk key is recorded under **Settings → Voice & video → Input mode**, the priority key under **Priority
speaker**, mute and deafen under **More hotkeys**. Each recorder: "Change", then press a key, a modifier alone or a
combination; Escape cancels, Backspace removes the binding. While an action is held its key lights up in the settings,
which also tests the binding (in the background too).

- **Bindings** are written as the client captures them: modifiers in the order `Ctrl+Alt+Shift+Super+` and one key as
  `KeyboardEvent.code` names it: `KeyV`, `F13`, `Ctrl+Shift+KeyM`, or a modifier alone as its own code: `ControlLeft`,
  `ShiftRight` (recorded when it is released without another key). A modifier in a combination means either side; a
  modifier alone is exactly that key. `Super` is the Windows key on Windows, Cmd on macOS and Super/Meta on Linux; the
  recorder shows these names ("Ctrl links" in German). Any key of the shell's table may be bound (letters, digits,
  punctuation, F1–F24, the numpad, navigation and media keys, every modifier); a plain key or a lone modifier is fine,
  because the keys are observed, not reserved. Escape and Backspace alone are the recorder's keys.
- **Matching:** an action is pressed when its key goes down while its modifiers are held (more may be held, e.g. Shift to
  run while holding push-to-talk; of `Ctrl+KeyM` and `Ctrl+Shift+KeyM` the more specific one wins) and released when its
  key or one of its modifiers goes up. Key repeat changes nothing. A key typed into a text field of the app never
  triggers (a character without Ctrl, Alt or Super).
- **Conflicts:** two actions never share a binding (the client refuses it with a message, the shell refuses it as well).
- **Where they live:** with the voice settings of the client (`hotkeys` in `tavrn.voice.settings`); settings from
  before (the window's `pttKey` and `priorityKey`, the separate `desktopHotkeys`) are migrated once: the window's key
  is the binding, a global one fills an empty or untouched key, mute and deafen come from the global ones. The shell
  keeps only the registry of the running app (`src-tauri/src/hotkeys.rs`, the Electron shell's `hotkeys.ts`); at
  every start the client hands it the stored bindings.
- **How they reach the call:** in the window the client's own key events (`web/src/voice/hotkeys.ts`, also the browser);
  in the desktop app also the shell's key listener, which reports presses and releases of the bound actions over a
  channel the client opened (`listen_hotkeys`). While the window has focus both see the same key; the client counts the
  window's events then and the shell's only while the window is in the background (`voice/hotkeyHolds.ts`), so a tap
  toggles once, and a key held while switching to the game stays held. Push-to-talk opens the gate while held (with the
  release delay of the settings) and needs the input mode "Push to talk"; the priority key also opens it there.
  Outside a call a toggle shows what the next voice channel gets.

### The key listener: observe, never grab, never log

The shells' listener (the crate `apps/desktop/crates/keywatch`, used by the Tauri shell and by the Electron shell's
native module) **observes** keys: it never takes a key away from the program that has
the focus, so a game still receives the push-to-talk key it also uses (a grab, as `RegisterHotKey`/`XGrabKey` do, would
take it away, and the system refuses grabs of a modifier alone).

| Platform | How | Notes |
|---|---|---|
| Windows | a low-level keyboard hook (`SetWindowsHookExW(WH_KEYBOARD_LL)`) on a thread of its own, which always passes the key on (`CallNextHookEx`); the scan code tells the physical key | Keys going to a window of a program that runs elevated (as administrator) are not seen by an app that is not elevated (UIPI): push-to-talk does not react in such a game. A release the hook misses (Ctrl+Alt+Del, an elevated window in front) is caught by a check every 500 ms (`GetAsyncKeyState`), so push-to-talk cannot stay open. |
| Linux, X11 | the X RECORD extension on two X connections of its own ([x11rb](https://crates.io/crates/x11rb), pure Rust); the keycode tells the physical key | The releases of X11's key repeat are dropped (the key is still down in the server's key map). The connections go to `DISPLAY` through its file socket or TCP and else, as libxcb does, through its Linux abstract socket (an X server that cannot create `/tmp/.X11-unix/X<n>`, such as Xvfb under WSLg, listens there only). |
| Linux, Wayland | the same through XWayland | Only keys going to X11 programs (many games, Wine and Proton) are seen, not those of native Wayland windows; without an X display the settings say that the keys work while the window has focus. |
| macOS | not yet | the keys work while the window has focus |

**Privacy:** the listener runs only while bindings exist and the client is signed in (`set_hotkeys_enabled`; signing
out stops it and releases what is held). The platform callback drops every key that is not part of a binding at once
(a 256-bit set of the bound keys and their modifiers); what passes becomes a press or release of an action, and only
that reaches the client. Nothing is stored, logged or sent anywhere: no key codes, no text, no timing.

**Anti-cheat:** the listener reads keys and injects nothing (no input is sent, no process is touched). Low-level
keyboard hooks are what voice chat programs commonly use for push-to-talk and are not known to be flagged by the
common anti-cheat systems; if one ever objects, removing the bindings stops the hook (no binding, no listener).

## Voice

The client has two voice engines behind one interface (`web/src/voice/engine.ts`); both run the same session logic
around the media (the channel's MLS group and the frame key of every epoch, the node's join, leave and state routes,
mute and deafen, per-user volumes, notification sounds, push-to-talk tones, speaking rings, rejoin, moves):

| Engine | Where | Media |
|---|---|---|
| Browser engine (`session.ts`) | browsers; the Linux app (Electron: Chromium, voice and video as in the browser, [Voice, video and screen sharing (Electron)](#voice-video-and-screen-sharing-electron)); the Tauri app on Windows (WebView2) by default; macOS | livekit-client in the webview, insertable streams |
| Native engine (`nativeSession.ts` + `src-tauri/src/voice`) | the Tauri shell only: on Linux (development builds and tests), always; on Windows with Settings → Voice & video → **Native voice engine (experimental)** (default off, applies from the next call) | the shell joins the room with LiveKit's Rust SDK (`livekit` crate on a prebuilt libwebrtc) |

A running call keeps its engine. A build without the Cargo feature `native-voice` answers `voice.native_unavailable`
and the client keeps the browser engine.

### The native engine

The webview keeps everything but the media: it joins the MLS group, gets the LiveKit URL and token from the node
(VOICE.md §3), derives the frame key of the current epoch (ENCRYPTION.md §5a) and hands it to the shell with
`voice_join`; every newer epoch's key follows with `voice_set_key` (never an older one; the webview wipes its copy, the
shell keeps keys in memory only and never logs them). The LiveKit URL must be `wss://` or `https://`; plain `ws://` and
`http://` are accepted only to this computer (`localhost`, `127.0.0.1`, `[::1]`), so the room token never travels
unencrypted (`voice.invalid_url` otherwise). The shell (`src-tauri/src/voice`):

- **End-to-end encryption** with exactly the web client's key provider configuration (`e2ee.rs`): one shared key per
  epoch at key index `epoch mod 256` in a ring of 256, HKDF with LiveKit's salt, AES-GCM, no ratcheting, no failure
  tolerance limit. The microphone is published only once the frame cryptor of the own track is active (otherwise
  `e2ee_failed`, nothing is sent); the sending key index follows every new epoch. `tests/voice_livekit.rs` proves
  that a participant with another key hears nothing, and `desktop-voice.spec.ts` that the browser engine and the
  native one decrypt each other.
- **Microphone** (`uplink.rs`, in the order of the browser pipeline): the device through cpal (PulseAudio, also
  PipeWire's PulseAudio server, else ALSA on Linux; WASAPI on Windows), mono at 48 kHz in 10 ms frames, WebRTC's audio
  processing for echo cancellation, noise suppression and automatic gain (the browser's capture constraints; RNNoise
  is the browser engine's, the native one uses WebRTC's noise suppression; music mode captures without processing),
  the input volume, then the gate (`gate.rs`, the same DSP as `web/src/voice/gate.ts`: threshold, 6 dB hysteresis,
  hold, 5 ms attack, 40 ms release) for voice activation, the noise gate and push-to-talk with its release delay.
  Opus with DTX and without RED, the channel's bitrate, as in the browser.
- **Subscriptions**: the room connects without auto-subscription; microphones (every remote audio track) are
  subscribed as they are published, cameras and screen shares never (`wants_subscription` in `engine.rs`): this engine
  plays no video, so a camera would only cost download bandwidth and decoding. Screen shares are opt-in in tavrn (a
  viewer receives a stream only after joining it, docs/CLIENT.md "Streams are joined"), and this engine has no video
  to join one with; joining a stream in the client says so.
- **Playback** (`mix.rs`): every subscribed remote audio track is decoded (and decrypted) by libwebrtc and mixed with
  the per-participant gain the client computes (`volume.ts`: per-user volume × output volume, 0 while deafened); the
  mix is also the echo canceller's reference. The loudest 10 ms RMS of each participant goes to the webview every
  50 ms, where the browser engine's `SpeakingDetector` turns it into speaking rings.
- **Push-to-talk** follows the system-wide hotkey directly (a tap of `hotkeys.rs`, so it also works while the window
  is in the background) and the webview's key and hold button.
- **Devices** of its own (`voice_devices`; Settings → Voice & video and the quick menus list them, kept apart from the
  browser's device ids as `nativeInputDeviceId` / `nativeOutputDeviceId`).
- **Connection**: the SDK resumes and reconnects by itself (`reconnecting`/`reconnected`); a room that is gone ends
  as `disconnected` with LiveKit's reason, and the webview rejoins or stops as the browser engine does. Server mutes
  arrive as permission changes.

**Not in this version:** camera, screen sharing (sharing and watching streams), soundboard clips and the priority speaker (the buttons are shown as
not available with the native engine, focusable and with the reason in their name), the microphone test of the
settings (it runs in the webview, `getUserMedia` exists there), macOS. Video in this engine was prototyped and not
pursued ([Video in the native engine, a design note](#video-in-the-native-engine-a-design-note)).

**Linux builds:** the app links ALSA (`libasound2`; building needs `libasound2-dev`).
PulseAudio is spoken in pure Rust. libwebrtc is linked statically (the `webrtc-sys` build downloads LiveKit's
prebuilt `webrtc-<tag>` once per target into the Cargo target directory).

**Windows:** the native engine cross-compiles with cargo-xwin (the NSIS installer builds). LiveKit's prebuilt
libwebrtc uses the static C runtime, so the shell links with `+crt-static` (`src-tauri/.cargo/config.toml`) and Tauri's
own hybrid runtime is switched off in `build.rs`; the installer needs no Visual C++ redistributable. With libwebrtc the
app binary is about 40 MB and the NSIS installer about 22 MB. Not yet started on a Windows machine.

**Measured** (release build, Linux under WSL2, fake audio backend, a two-person call with Chromium, 10 s each,
`desktop-voice.spec.ts`; budgets of `tavrn-node/perf/budgets.json`): talking, the shell (with the engine) 7.4 % and
the WebKit processes 2.1 % of one core, together 9.5 % (budget 15 %); muted, 2.8 % + 1.4 % = 4.2 % (budget 5 %).
On Windows the same comparison (the shell plus the `msedgewebview2` renderer, browser engine against native engine,
talking and muted, with real devices) decides whether the setting becomes the default there.

### Video in the native engine, a design note

A prototype (kept by the maintainers, not merged) measured how remote video gets from the Tauri shell's
native engine into the webview's tiles on Linux and at what cost; its result led to the Electron shell. Native capture
is the easy part (the SDK has camera and desktop capturers and publishes video tracks with the same frame cryptor);
showing frames inside the webview is the hard part. The SDK yields decoded, decrypted I420 frames only (no
encoded-frame sink on the receive side), so every path starts there. The prototype served them over a loopback
WebSocket (127.0.0.1, a random port and token per run, the webview's origin checked; Tauri's custom protocols cannot
stream on WebKitGTK and its JSON IPC would mean base64), one binary message per frame, and the webview drew them. The
webview (WebKitGTK 2.52) has MSE, WebCodecs `VideoDecoder` and `VideoFrame`, OffscreenCanvas and WebGL 2, but no
`RTCPeerConnection` and no `MediaStreamTrackGenerator`. A native child window layered over the webview at the tile's
rectangle (no copy, but window management per platform and no CSS for tiles) was not built.

Measured with a release build on WSL2 under xvfb without a GPU, a Chromium participant publishing its fake camera with
simulcast at 30 fps, 10 s per row. CPU is in % of one core; the shell's share includes the call's audio (about 6 %)
and libwebrtc's VP8 decoding; WebKit ran in its CPU-composited mode (its default mode, through Mesa's software GL here,
cost more on every path):

| Path | 360p: latency p50/p95, shell, WebKit | 720p | 1080p | Transport at 720p |
|---|---|---|---|---|
| decoded, not delivered | –, 9, 5 | –, 10, 4 | –, 12, 6 | – |
| A: RGBA, `putImageData` | 11/18 ms, 11, 24 | 14/21 ms, 16, 36 | 21/28 ms, 25, 62 | 111 MB/s |
| A: I420, WebGL shader | 9/17 ms, 11, 50 | 11/18 ms, 15, 132 | 14/21 ms, 19, 241 | 42 MB/s |
| A: I420, WebCodecs `VideoFrame` | 11/18 ms, 10, 24 | 13/21 ms, 14, 30 | 17/24 ms, 19, 49 | 42 MB/s |
| B: VP8 re-encoded in the shell, `VideoDecoder` | 78/85 ms, 14, 16 | 81/89 ms, 25, 27 | 87/94 ms, 40, 42 | 0.13 MB/s |
| B: VP8 in WebM, MSE | 316/355 ms, 16, 54 | 336/367 ms, 29, 67 | 347/378 ms, 44, 77 | 0.12 MB/s |
| Chromium receiving the same camera (all processes) | 43 | 59 | 64 | – |

Path A with I420 is fit for camera tiles (10–17 ms from the SDK to the paint; at 1080p30 the shell and WebKit together
need about as much CPU as Chromium alone) and for 1080p30 screen shares; re-encoding (B) saves only loopback bandwidth
and adds 70 ms (WebCodecs) or 330 ms (MSE). Still missing for production were tile-size driven layer selection and
pausing hidden tiles, the own camera (capture, publishing, its preview), screen sharing through the PipeWire portal,
fullscreen and pop-out, the colour space of VP8 frames and measurements with a GPU: every video feature the browser
engine already has, built a second time in the shell and its renderer. A Chromium shell brings all of it at once, at the
price of a second shell (keychain, tray, hotkeys, updater and downloads ported), a bundled Chromium (about 100 MB more)
and its security updates; that is the Electron shell.

### The webview's own WebRTC on Linux

WebKitGTK runs WebRTC through GStreamer and keeps it off unless the app switches it on: the Tauri shell turns on
`enable-webrtc` and `enable-media-stream` of the webview's settings (`src-tauri/src/media.rs`). At runtime these
GStreamer plugins must be installed (Linux builds of the Tauri shell are for development and tests only):

```sh
sudo apt install gstreamer1.0-plugins-bad gstreamer1.0-plugins-good gstreamer1.0-gl gstreamer1.0-pipewire   # or gstreamer1.0-pulseaudio
```

**The distributions' WebKitGTK is built without WebRTC.** WebKitGTK compiles WebRTC only with its experimental
features (`ENABLE_WEB_RTC` follows `ENABLE_EXPERIMENTAL_FEATURES`, off in release builds); Ubuntu 24.04 and 26.04 ship
`libwebkit2gtk-4.1` 2.52 that way (it does not link `libgstwebrtc-1.0`). There the switch has no effect:
`getUserMedia` works, `RTCPeerConnection` does not exist; that is why the Tauri app on Linux always runs voice in the
native engine, and why the Linux app moved to the Electron shell.
Check a system with `ldd /usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0 | grep gstwebrtc`.

## Limitations

What the browser gets from "the client is served by the node" and what the app does instead, in the Tauri shell
(Windows, macOS) and in the Linux app (Electron); "same" means as in the Tauri shell:

| Flow | Tauri shell (Windows, macOS) | Linux app (Electron) | Why |
|---|---|---|---|
| Password with the second factor (TOTP, recovery code) | works | same | ordinary API calls with bearer tokens (the node allows every origin, without cookies) |
| Registration, account settings, encryption, rooms, DMs, federation | work | same | same |
| Sign-in with an account of another node | the app signs in at the account's own node instead: the address (`alice@home.example`) switches the app to that node; "Sign in with an account of another node" keeps password with TOTP or a recovery code | same | the origin connect flow returns the code to an `https://<domain>` origin, which the app does not have; the sign-in window is bound to the app's own node. |
| Passkeys (WebAuthn) as second factor or sign-in | Windows: in the app through the Windows WebAuthn API ("Passkeys on Windows"), also registration and the PRF unlock; macOS: on the node's page in the sign-in window ("Signing in"), which also unlocks the encrypted messages (sealed unlock material) | with a FIDO2 security key on USB in the app ("Passkeys on Linux"), also registration and the PRF unlock; any other passkey (a phone, a password manager) through the system browser ("Open in the browser instead"), which unlocks the app as well | passkeys are bound to the node's domain; the app's origin is not the node's. On Linux the sign-in window has no WebAuthn (Electron offers no dialog of its own there, nor does the Tauri shell's WebKitGTK). Without `connect.app` on the node (and without the native path): not offered, TOTP or a recovery code is required. |
| Single sign-on (OpenID Connect) | on the node's page in the sign-in window | same | the node sends the browser back to its own web client (`<web>/sso/callback`), which is the page in the sign-in window. Without `connect.app`: not offered, an SSO-only node shows a notice. A later step may add an app-scheme callback (RFC 8252) as an accelerator. |
| Captcha on login or registration | on the node's page in the sign-in window | same | the widget is a third-party script (CSP `script-src 'self'`) bound to the node's host name; the node's page loads it. Without `connect.app`: a notice, use the browser for that step. |
| Web push | not offered | same | there is no service worker in the app (its pages are not served by the node). The app shows native notifications instead while it runs (also from the tray); nothing reaches a device where the app is not running. |
| Desktop notifications of the browser | replaced | same | native notifications ("Notifications" above). |
| Voice and video | Windows (WebView2, Chromium): voice and video as in Chromium (to be confirmed by hand), or audio only with the native engine setting; a screen share with the system's sound, the call left out (Edge 141 or newer, [CLIENT.md](CLIENT.md) "Screen share audio") | voice, video, screen sharing (the shell's picker, or the desktop portal on Wayland), the soundboard and the background effects as in Chromium; no sound with a shared screen | the Tauri shell on Linux runs voice in the native engine, audio only, because the WebKitGTK of Ubuntu 24.04 and 26.04 has no WebRTC ("Voice"), which is why Linux ships the Electron shell; Electron captures system audio on Windows only, with the app's own playback in it. |
| Popping out the whiteboard, "open original" in the media viewer | not offered | same | the app opens no window for content (only the sign-in window); maximize and the download icon cover it. |
| The terms and other pages that open in a new tab | open on the node's web client in the system browser | same | the app opens no window for content. |
| Ctrl-, Shift- or Cmd-click and middle click on a link (a tab of its own in the browser) | internal links never leave the app: they act as a plain click and open the view in place; links to other sites open in the system browser | same | the app has no tabs, and the shell never hands the app's own address (`https://tauri.localhost` on Windows) to the system browser (`platform/links.ts`, `guard.rs` `new_window`, the Electron shell's `newWindow`; the Android app the same). |
| Updates while the repository is private | do not download | the check fails quietly | the updaters fetch their feeds (`latest.json`, `latest-linux.yml` and its `.minisig`) through the website's redirect and the installers from the public release URLs. |

## The Linux shell (Electron)

The Linux app is an Electron shell around the same bundled client ([`apps/desktop-electron`](../apps/desktop-electron),
Electron pinned to an exact version of the newest stable major, packages by electron-builder). It behaves like the
Tauri shell wherever this document describes a behaviour; this section names what is specific to it. Its subsections
follow the order of the document: a subsection named after a section with "(Electron)" adds to that section, the
others (layout, bridge, profile, packages) exist for this shell only.

### Layout

| Path | What |
|---|---|
| `src/main/index.ts` | app lifecycle: the `app` scheme registered before start, the profile directory, one instance per user (a second start shows the running window), the IPC registry, the session's permission handlers, the main window |
| `src/main/context.ts` | what every part of the shell gets from `index.ts` (registry, events, settings, main window) |
| `src/main/windows.ts` | the main window (1280×800, at least 360×560, title "tavrn", no menu bar) and its navigation guards |
| `src/main/protocol.ts` | `app://tavrn`: the bundled `web/dist` (inside the asar archive) with its content types; `index.html` for document requests of the client's routes; `Cache-Control: immutable` for Vite's hashed `assets/`, `no-cache` for the rest; the Content Security Policy on every document |
| `src/main/csp.ts` | the policy (the Tauri shell's, see [Security of the shell (Electron)](#security-of-the-shell-electron)) |
| `src/main/guard.ts` | the decisions of navigations, new windows, external links, permissions and the dev server URL (pure functions, unit-tested) |
| `src/main/ipc.ts` | the registry of the bridge's IPC channels: sender check, argument checks, handlers |
| `src/main/events.ts` | the shell's events for the client (one channel) |
| `src/main/config.ts`, `node_url.ts` | the settings file and the node URL rules (the Tauri shell's `config.rs` and `node_url.rs`, with their test cases) |
| `src/main/shell.ts` | the `shell` namespace: settings, version, external links, node resolution, the sign-in window |
| `src/main/resolve.ts` | address first: well-known, SRV, direct (the Tauri shell's `resolve.rs`, with its test cases) |
| `src/main/connect.ts` | the sign-in window |
| `src/main/keychain.ts` | the `keychain` namespace: the local storage keys over `safeStorage` ([Keys in the OS keychain (Electron)](#keys-in-the-os-keychain-electron)) |
| `src/main/notify.ts` | the `notify` namespace: native notifications and their clicks ([Notifications (Electron)](#notifications-electron)) |
| `src/main/downloads.ts` | the `files` namespace: the save dialog, chunked writes, the safety net ([Downloads (Electron)](#downloads-electron)) |
| `src/main/tray.ts`, `tray_icon.ts` | the `tray` namespace, the tray icon and its menu, close to tray; the badged icons drawn from the logo ([Tray and close to tray (Electron)](#tray-and-close-to-tray-electron)) |
| `src/main/hotkeys.ts` | the `hotkeys` namespace over the key listener module ([Hotkeys (Electron)](#hotkeys-electron)) |
| `src/main/passkeys.ts`, `passkey_dialog.ts`, `passkey_window.ts` | the `passkeys` namespace over the passkeys module, the shell's dialog for the touch prompt, the PIN and the choices ([Passkeys on Linux](#passkeys-on-linux)); `passkeys_mock.ts` the software key of the specs |
| `src/main/capture.ts`, `picker.ts` | screen sharing through the shell's own picker ([Voice, video and screen sharing (Electron)](#voice-video-and-screen-sharing-electron)) |
| `src/main/updater.ts`, `minisign.ts` | updates: electron-updater, gated by the signed feed (minisign signatures verified with Node's Ed25519; [Updates](#updates)) |
| `src/preload/` | `window.tavrnShell` (`index.ts` composes the namespaces, `invoke.ts` the calls, `events.ts` the subscription); `picker.ts`, the picker's preload; `passkey.ts`, the passkey dialog's |
| `src/shared/bridge.ts` | the bridge's methods and channels, used by the preload and the main process |
| `native/keywatch/` | `@tavrn/keywatch-native`: the system-wide key listener as a Node-API module |
| `native/passkeys/` | `@tavrn/passkeys-native`: passkeys with FIDO2 security keys over USB as a Node-API module, around its crate `fido/` (Linux) |
| `scripts/` | `dev.mjs` (`pnpm dev`), `copy-native.mjs` (the native modules into `dist/native/`), `verify-feed.mjs` (the release's check of the signed feeds) |
| `e2e/` | the Playwright specs and `launch.ts`, which starts the app for them |
| `electron-builder.config.mjs` | the `.AppImage` and `.deb` packages, the Windows fallback's NSIS installer, Electron's fuses, the update key in the package |

### The bridge

The preload exposes one object to the bundled client, `window.tavrnShell`, with `kind: "electron"` and
`window: "main"` (the only window with a preload) and the namespaces `shell`, `updater`, `files`, `keychain`, `notify`,
`tray`, `hotkeys`, `passkeys` (Linux; [Passkeys on Linux](#passkeys-on-linux)) and `events`. Its TypeScript shape is
`TavrnShellBridge` in the client
([`web/src/platform/electronBridge.ts`](../web/src/platform/electronBridge.ts), types only, without imports); the
preload type-checks against it through a path alias of its `tsconfig.json` (`@tavrn/web/electronBridge`), and a
compile-time check keeps the method list of `src/shared/bridge.ts` equal to it. The method names are the Tauri
commands' in camelCase (`get_config` → `shell.getConfig`, `save_file_chunk` → `files.saveFileChunk`), with the same
arguments in the same order and the same answers; a refusal rejects with the value the Tauri command rejects with (an
error code such as `node_url.insecure`, or the resolve failure object). The Tauri shell's two event channels
(`shell_events`: notification clicks and tray actions; `listen_hotkeys`: presses and releases) arrive through
`events.subscribe(handler)` as `{ channel: "shell_events" | "hotkeys", event }` with their payloads unchanged.

Every method is one IPC channel, `tavrn:<namespace>.<method>`; the main process listens to all of them
(`src/main/ipc.ts`) and answers `{ ok, value }` or `{ ok: false, error }`. A part of the shell registers its handlers
with `IpcRegistry.handle(namespace, method, argumentCheck, handler)`. The preload is bundled into one CommonJS file
(`vite.preload.config.ts`): a sandboxed preload cannot load other files.

### Security of the shell (Electron)

| What | Where |
|---|---|
| The main window shows only the bundled client: `app://tavrn`, a standard and secure custom scheme (own origin, secure context) that serves `web/dist` from the app's asar archive; `file://` is never used. In development the Vite dev server instead (`TAVRN_DESKTOP_DEV_URL`, only `http://localhost` or `http://127.0.0.1`, ignored by a packaged app). Every other navigation of the window and its frames is refused (`will-frame-navigate`, `will-redirect`); web links (http, https, mailto) open in the system browser, new windows are never opened (`setWindowOpenHandler`), `<webview>` is refused. The click-to-play embeds load in their frames. | `src/main/guard.ts`, `windows.ts`, `protocol.ts` |
| Content Security Policy: the Tauri shell's without its IPC origins (a unit test compares both), sent with every document of `app://tavrn`: scripts only from the bundle (`script-src 'self' 'wasm-unsafe-eval'`, no eval, no inline scripts, no third-party scripts), `connect-src` https and wss to any node plus plain http/ws to `localhost` and `127.0.0.1`, images and media from https, frames only for the embed providers. The Vite dev server runs without it (its hot reload needs inline scripts). | `src/main/csp.ts`, `protocol.ts` |
| The renderer: `contextIsolation`, `sandbox`, no Node integration (also not in frames and workers), `webSecurity`, no insecure content, no `<webview>`, DevTools only in development; no application menu. The page never sees `ipcRenderer`, `require` or `process` (the smoke test checks). | `src/main/windows.ts`, `src/preload/` |
| The bridge: only the main window's top frame showing the bundled client may call it (`event.sender` and `event.senderFrame` checked, its URL must be the app's), so the embeds cannot; every method's arguments are checked before its handler runs (hand-written guards: types, lengths, ranges, exact arity, no unknown fields; refused with `ipc.invalid_arguments`). Event subscribers get the payload only, never Electron's IPC event. | `src/main/ipc.ts`, `index.ts`, `src/preload/` |
| Permissions: exactly these are granted, without a prompt and only to the main window's own origin (`app://tavrn`): the microphone and the camera (`media` with the types `audio` and `video`), `clipboard-sanitized-write` (the client's copy buttons), `fullscreen` (video) and `speaker-selection` (the output device); the Tauri shell's webviews allow the last three by default. Screen capture goes through the shell's picker (next row). Everything else is denied, for every page, and so are device permissions (HID, USB, serial). | `src/main/guard.ts`, `index.ts` |
| Passkeys: the bridge's `passkeys` methods take the node's options (a plain object of at most 64 KiB) and run with the node's web origin from the settings, one ceremony at a time; the passkey dialog is static HTML without any script (`script-src 'none'`), filled by its own preload, which talks to its own window only (checked by sender); the PIN is typed there and never reaches a web page; the software key of the specs exists in development builds only. | `src/main/passkeys.ts`, `passkey_window.ts`, `src/preload/passkey.ts` |
| Screen capture: `getDisplayMedia` of the main window's own page only, through the shell's picker window (screens and windows of other programs from `desktopCapturer`); the picker's page is static HTML without any script (`script-src 'none'`), filled by its own preload, which answers only one of the offered sources; Escape, Cancel or closing it refuses. | `src/main/capture.ts`, `picker.ts`, `src/preload/picker.ts` |
| The sign-in window shows only the chosen node's `/connect?session=…` page (`openConnect` checks origin, path and parameters, as `guard.rs` does) and follows https pages from there (identity providers redirect), plain http only on this computer; it never loads the bundled client or `app:`, `file:`, `data:`, `javascript:` or `blob:` URLs, new windows go to the system browser. It has no preload and no IPC; its session (`persist:tavrn-connect`, apart from the app's) denies every permission, download and screen capture. | `src/main/connect.ts`, `guard.ts` |
| The node URL is validated twice: in the client and again in the shell before it is stored. | `web/src/platform/nodeUrl.ts`, `src/main/node_url.ts` |
| Electron's fuses in the packages: no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no `--inspect` (the smoke test starts the package with both and checks), the app only from `app.asar`, embedded asar integrity validation (Electron enforces it on macOS and Windows only; on Linux the fuse has no effect), cookie encryption, no extra privileges for `file://`. | `electron-builder.config.mjs` |
| The renderer's Chromium sandbox is never switched off (no `--no-sandbox`, also not in tests): the `.deb` installs an AppArmor profile that lets the app use user namespaces (Ubuntu 24.04 and later restrict them), and makes `chrome-sandbox` setuid only where user namespaces do not work ([Packages and the Chromium sandbox](#packages-and-the-chromium-sandbox)). | electron-builder's `.deb` scripts |
| Updates: nothing is downloaded unless the feed of the release is signed with the update key of `tauri.conf.json` (the Tauri updater's, one key for both shells), names this feed file and its version, and lists every file to download with the SHA-512 that electron-updater then checks; everything else electron-updater parsed from its own copy of the feed (path, release date, administrator rights, staged rollout, file sizes) must equal the signed feed, a feed with web-installer `packages` is refused and the web installer is off; a refusal is logged and shown. | `src/main/updater.ts`, `src/main/minisign.ts` |
| No contact before a node is chosen: the spellchecker is off in the app's session and the sign-in window's (their Chromium `Preferences` are seeded with it off before the app is ready, because Chromium starts it when it creates a profile; once ready both sessions switch it off and drop its languages again), so Chromium downloads no dictionaries from Google's servers (the smoke test reads Chromium's net log of a first start and finds only this computer). A package refuses to start with `--remote-debugging-port` or `--remote-debugging-pipe` (the packaged Playwright specs allow it with `TAVRN_DESKTOP_ALLOW_DEBUGGING=1`). | `src/main/hardening.ts`, `index.ts`, `connect.ts` |

### Settings and profile

The settings file is `~/.config/tavrn-desktop/settings.json` (`$XDG_CONFIG_HOME/tavrn-desktop/`) with the schema of the
Tauri shell's `config.json` (`node`, `web`, `domain`, `close_to_tray`) and the same rules: a missing or corrupt file
means "no node yet", a stored node that no longer passes the validation is dropped, writes are atomic. The same
directory holds Chromium's profile of the app (the client's IndexedDB and local storage) and the single-instance lock.

**Switching shells.** On its first start (no `settings.json` yet) the Electron shell takes over the home node of the
Tauri app's settings (`~/.config/org.tavrn.desktop/config.json`) once: the node URL with its web origin and identity
domain, validated like fresh input (an invalid node imports nothing; close to tray stays the default); the log says
so. The local key store is not taken over (another engine, another profile): the app starts signed out, and the
recovery key or a passkey unlocks the account as on any new device.

### The node picker and signing in (Electron)

The node picker works as in "The node picker": `resolveNode` runs in the shell (`resolve.ts`) with the rules, steps and
errors of the Tauri shell. Its requests go through Chromium's network stack (`net.fetch`: TLS verified against the
system's trust store, the system's proxy settings), at most 3 redirects to https on the same host, 5 s until the
answer's headers and 10 s in total (Chromium has no separate connect timeout), the document capped at 64 KiB; SRV
records come from the system's DNS configuration (`/etc/resolv.conf`). The SRV step alone uses Node's TLS
(`https.request` to the target with `servername` and `Host` set to the identity domain), because Chromium's fetch
cannot connect to one host while verifying the certificate for another; it trusts Node's bundled Mozilla roots plus
the system's certificate store.

Signing in on the node's page works as in "Signing in", in the window of `connect.ts`. The page knows the sign-in window
by the marker `TavrnDesktopSignIn/1` that the window's session adds to the user agent (`inSignInWindow`,
`web/src/platform/tauriDetect.ts` and `electronDetect.ts`; the Tauri shell names its window `connect` instead) and signs
its own session out after the handoff. The window's storage is persistent (`persist:tavrn-connect`), kept apart from the
app's profile. Passkeys: Electron offers no WebAuthn dialog of its own on Linux, so the window keeps saying that passkeys
work through the browser there ("Open in the browser instead"); a passkey on a security key runs in the app itself
([Passkeys on Linux](#passkeys-on-linux)), and the hint says so.

### Keys in the OS keychain (Electron)

The same entries, rules and lifecycle as [Keys in the OS keychain](#keys-in-the-os-keychain): one 32-byte local storage
key per account, named `local-key/<home node origin>/<account address>` with the node taken from the settings file,
never from the page; `keychain.invalid`, `keychain.no_node`, `keychain.unavailable` and `keychain.corrupt` as refusals;
Settings → App shows the backend (`secret-service`) or the fallback warning.

**Backend: Electron's `safeStorage`.** Chromium keeps one random secret of the app in the desktop's keyring (the Secret
Service through libsecret: GNOME Keyring, KeePassXC, KWallet's Secret Service; on KDE KWallet directly) and encrypts
with it; the shell stores the encrypted keys in `keychain.json` of the profile directory (`~/.config/tavrn-desktop/`,
mode 0600, written atomically). That keeps the property of the Tauri shell: the files of the profile alone open nothing
(the IndexedDB holds ciphertext under the local storage key, `keychain.json` holds that key under the keyring's
secret). It needs no native module (a direct Secret Service library for Node would be one, built per Electron version)
and works headless with gnome-keyring in a D-Bus session. Two details make it as strict as the Tauri shell:

- Chromium falls back to a fixed, built-in key when no keyring answers (ciphertext prefix `v10`; its asynchronous API
  even reports itself available then). The shell writes only `v11` ciphertext, a key from the keyring, and treats
  everything else as "no keychain", so the client keeps the key in IndexedDB with the warning, exactly the fallback of
  the Tauri shell.
- Chromium picks the keyring by the desktop and uses the fixed key on desktops it does not know (sway, Hyprland, i3,
  a bare X session). The shell asks for the Secret Service on every desktop except KDE (`--password-store=gnome-libsecret`,
  unless the user passed a `--password-store` of their own), as the Tauri shell does everywhere.

Differences that are not user-visible: the keyring holds one entry for the app ("tavrn Safe Storage") instead of one per
account; the entries of the Tauri shell (service `org.tavrn.desktop`) are not read, which does not matter because the two
shells have separate web profiles anyway (a switch of shells signs in on a new device, like a new browser). A keyring
secret that was deleted by hand makes the stored keys unreadable (`keychain.corrupt`): the store then locks until the
recovery key or a passkey unlocks it, as with a deleted entry in the Tauri shell. `TAVRN_DESKTOP_KEYCHAIN=memory` and
`=unavailable` work as in the Tauri shell.

### Notifications (Electron)

Electron's `Notification` (libnotify, the desktop's notification server over D-Bus) with the Tauri shell's fields and
checks: title (at most 200 characters), body (at most 1000), an optional path of the client (at most 512 bytes, inside
the client, no whitespace or control characters; otherwise `notify.invalid`), the app icon. The client decides when
(the window is not focused), as before. A click on the notification (the server's default action) brings the main
window to the front, also out of the tray, and the client opens the path. At most 16 notifications wait for their click
at once (each is kept referenced until it is clicked or closed); later ones are shown without one. Without a
notification server nothing is shown and the call still succeeds.

### Downloads (Electron)

The `files` namespace behaves like the Tauri commands of [Downloads](#downloads): `saveFileBegin(name, mime, size)`
shows the native save dialog (the cleaned name as suggestion, a filter for its extension; it opens in the directory used
last, at first in Downloads) and answers `{ status: "ready", id }` or `{ status: "cancelled" }`, at most 8 saves at once;
`saveFileChunk(id, bytes)` appends at most 4 MiB (more than the announced size: `download.too_large`) to a temporary
file next to the target, readable by the user only; `saveFileEnd(id)` checks the size, flushes and renames it into place
and answers the path and its folder's name; `saveFileAbort(id)` removes it; `saveFileReveal(id)` shows the file in the
file manager (`shell.showItemInFolder`). Temporary files of saves still running when the app quits are removed. The
client's "Saved to \<folder>" toast with **Show in folder** works unchanged.

The safety net: a download the main window starts itself (an `<a download>`, a navigation to a file) arrives at the
session's `will-download` and gets the same save dialog (Electron's own, with the same options); downloads of any other
web contents, and of schemes other than blob, data, http(s) and the app's own, are cancelled.
`TAVRN_DESKTOP_TEST_SAVE_DIR=<dir>` saves into that directory without a dialog, never overwriting (`name (1).ext`), for
both paths.

### Tray and close to tray (Electron)

The same icons, tooltip, menu and rules as [Tray and close to tray](#tray-and-close-to-tray): the five icons are drawn
at start from the Tauri app's `icons/128x128@2x.png` by a port of its drawing code (`tray_icon.ts`, the same unit tests
on the same logo), the menu has Show/Hide tavrn, Mute microphone, Deafen, Leave voice channel and Quit tavrn in the
client's language, the voice items reach the client as tray actions, close to tray is on by default (only while there is
a tray icon) and Quit ends the app. A left click on the icon shows the window, a right click opens the menu.

Electron's tray speaks the StatusNotifierItem protocol on Linux, like the libayatana-appindicator of the Tauri shell:
KDE, Xfce, Cinnamon, MATE, Budgie, Ubuntu's GNOME session and GNOME with the AppIndicator extension show it. Plain GNOME
without the extension shows no icon (Electron then has nowhere to put it, the app keeps running); start the app again to
get the window back. Under xvfb (the smoke test) the icon is created but nothing displays it, so the test reads the
tray's state through `trayStatus`.

### Hotkeys (Electron)

The hotkeys behave as "Hotkeys" above describes (one binding per action, the matching, the conflicts, the window's own
keys and the shell's listener counted once). Electron's `globalShortcut` is **not** used: it grabs the key (the game
behind the app would no longer get its push-to-talk key), refuses a lone modifier and fails when another program
grabbed the combination first. The Electron shell uses the Tauri shell's listener instead:

| Part | What |
|---|---|
| `apps/desktop/crates/keywatch` | the listener of both shells (the crate `tavrn-keywatch`: X RECORD on Linux, the low-level hook on Windows, the key table `keys.rs`); the Tauri shell uses it as a path dependency |
| `apps/desktop-electron/native/keywatch` | `@tavrn/keywatch-native`: the crate as a Node-API module (napi-rs, `napi build --release`, `keywatch.linux-x64-gnu.node`): `setKeys(codes)` (the filter), `start(callback(code, pressed))`, `stop()`, `isRunning()`; errors `keywatch.invalid`, `keywatch.running`, `keywatch.unavailable: <why>` |
| `src/main/hotkeys.ts` | the Tauri shell's `hotkeys.rs` in TypeScript: the bindings and their canonical spelling, the matching (the most specific combination wins, key repeat changes nothing, a rebind or a stop releases what is held), the listener only while bindings exist and the client is signed in, the bridge's `hotkeys` namespace; presses and releases of actions go to the client on the `hotkeys` event channel with the Tauri payloads (`{ action, pressed }`) |

The build copies the module to `dist/native/keywatch.node`; the packages keep it outside the asar archive
(`app.asar.unpacked/dist/native/`, a native module cannot be loaded from inside it). A build without it runs, and
registering a binding answers `hotkey.unavailable` (Settings says that the keys work while the window has focus).

| Session | What the listener sees |
|---|---|
| X11 | every key of the bindings, whatever program has the focus |
| Wayland with XWayland | the keys going to X11 programs (many games, Wine and Proton): the listener talks to XWayland (`DISPLAY`), whichever platform the app's own window uses; keys going to native Wayland windows are not seen (the app's own window reports its keys itself while it has the focus) |
| Wayland without XWayland | nothing: `hotkey.unavailable`, and the log line says "a Wayland session without XWayland"; the keys work while the window has focus |

The desktop portal's `GlobalShortcuts` interface is not used: it reserves shortcuts with the compositor instead of
observing keys (a game would lose them), and it is not available everywhere; it remains an option for sessions without
XWayland. **Privacy** is the Tauri shell's: the filter holds only the bound keys and their modifiers, every other key
is dropped in the X callback of the module, the main process turns what passes into actions, and only actions reach
the client; nothing is stored or logged.

### Voice, video and screen sharing (Electron)

Voice and video run in Chromium with the browser engine (`session.ts`), exactly as in a browser: the Electron binding
has no native engine (`voice` stays absent in `web/src/platform/electron.ts`), so the camera, screen sharing, the
soundboard, the priority speaker and the background effects work in the app as they do in Chromium. The microphone and
the camera need no prompt ([Security of the shell (Electron)](#security-of-the-shell-electron)).

`getDisplayMedia` of the client opens the shell's picker (`capture.ts`): a small modal window with the screens and the
windows of other programs (thumbnails and names, the app's own windows left out), in English or German after the
system's language, keyboard first (the first source has the focus, Escape cancels, a visible focus ring, 44 px targets,
light and dark theme; axe finds no WCAG 2.2 AA violation). The chosen source goes to Chromium; a refusal reaches the page
as `AbortError` (Electron's answer, which the client takes as a closed picker), and with nothing to share the picker says
so. On X11 the sources come from the X server (its screen capturer can fail on its first use right after the start; the
shell asks once more). On Wayland Chromium asks the desktop portal (PipeWire): the portal's own dialog picks
the screen or window, and the shell takes that one source without a second picker. The sound follows the client's
choice in its share dialog ([CLIENT.md](CLIENT.md) "Screen share audio"): on Windows (the fallback build) "Whole
system" becomes Electron's loopback capture (`captureAudio` in `picker.ts`), which carries the app's own playback as
well (Electron has no way to leave a process out, and its `loopbackWithMute` would silence the call for the sharer),
so the dialog starts with "No sound" and says so; on Linux no sound is offered at all: Electron's loopback exists on
Windows only, and neither X11 nor the PipeWire portal gives Electron any audio.

### Updates (Electron)

electron-updater reads the website's feed of the chosen update channel: before every check the shell points its
generic provider at `https://tavrn.org/updates/desktop/<channel>/` ([Updates](#updates)), where `latest-linux.yml`
(`latest.yml` on Windows) and the packages it names redirect to the right GitHub release. electron-builder generates the
feed next to the packages (`latest-linux.yml` with the SHA-512 and size of the `.AppImage` and the `.deb`; `latest.yml`
for the Windows fallback) and writes the repository into the package (`resources/app-update.yml`, from the `publish`
entry of `electron-builder.config.mjs`), which the signed-feed check uses; the release attaches both feeds with their
minisign signatures. The channel is `update_channel` in `settings.json` (the bridge's `getUpdateChannel` and
`setUpdateChannel`). Settings → App offers the update as for the Tauri app, once the shell has verified the signed feed
([Updates](#updates): one key for both shells, and how the check works). A development run and a package without a
valid key offer no updates (`updater: false`).

### Packages and the Chromium sandbox

`just electron-package` writes `Tavrn-<version>.AppImage`, `tavrn_<version>_amd64.deb` and `latest-linux.yml` into
`apps/desktop-electron/release/` (the app in `/opt/tavrn`, `/opt/Tavrn` before version 0.4.0, the command `tavrn`,
the menu entry `tavrn.desktop`, the licence and terms of "Licence and terms in the installers" as
`resources/LICENSE.txt` and, in the `.deb`, as `/usr/share/doc/tavrn/LICENSE.txt`; Electron's and Chromium's
licences ship next to the binary). The `.deb` depends on electron-builder's list plus ALSA and GBM
(`libasound2t64 | libasound2`, `libgbm1`), which minimal systems lack, and `libudev1` for the passkeys module.

Chromium's renderer sandbox needs unprivileged user namespaces, or a setuid `chrome-sandbox`. Ubuntu 24.04 and later
restrict user namespaces with AppArmor; the `.deb`'s `postinst` therefore installs an AppArmor profile for
`/opt/tavrn/tavrn` that allows them (`/etc/apparmor.d/tavrn`, on systems whose AppArmor supports it), and makes
`chrome-sandbox` setuid root only where user namespaces do not work at all. So the `.deb` runs sandboxed out of the box
and is the recommended package on Ubuntu. Checked in an `ubuntu:noble` container: the package installs with its
dependencies (no library missing), the profile, the licence and the menu entry are in place; where user namespaces work
(`--security-opt seccomp=unconfined`) `chrome-sandbox` stays 0755 and the app runs sandboxed; where they do not (Docker's
default) `chrome-sandbox` becomes setuid root, but Docker also forbids the namespaces the setuid helper creates, so the
app cannot start there (a limit of the container, not of a desktop). A container without AppArmor cannot show the
profile at work. The same holds for the tests: the Playwright specs start the app sandboxed, so the CI job runs them only on a runner that can create user
namespaces (it checks with `unshare -U` and otherwise skips them with a warning while still building the packages); the
self-hosted runner stack of the organization allows them for the runner containers.

The AppImage cannot carry a setuid helper or install a profile. Where user namespaces work (most distributions) it runs
sandboxed as it is. On Ubuntu 24.04 and later it does not start until the system allows it: install the `.deb` instead,
or add a profile like the `.deb`'s by hand, as root:

```sh
cat > /etc/apparmor.d/tavrn-appimage <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
profile tavrn-appimage /home/*/Applications/Tavrn-*.AppImage flags=(unconfined) {
  userns,
}
PROFILE
apparmor_parser -r /etc/apparmor.d/tavrn-appimage
```

Adjust the path to where the AppImage lives; the profile covers the processes the AppImage starts. This is not verified
on a real Ubuntu 24.04 desktop yet (the containers used for the checks have no AppArmor). The app is never started with
`--no-sandbox`.

### Development and tests (Electron)

Requirements: the web client's (Node.js 24, pnpm); for the key listener module a Rust toolchain; for the specs
`xvfb-run`. Electron's binary is not downloaded by `pnpm install`: the first start fetches the pinned version from
Electron's GitHub releases into `~/.cache/electron` (`node apps/desktop-electron/node_modules/electron/install.js` does
it ahead). An environment that exports `ELECTRON_RUN_AS_NODE` (some editors and tools do) makes the binary behave as
plain Node; the recipes and the launcher of the specs (`e2e/launch.ts`) remove it.

| Recipe | What it does |
|---|---|
| `just electron-dev` | the client's Vite dev server (`E2E_WEB_PORT`, default 5173) and the app in development mode on it (`TAVRN_DESKTOP_DEV_URL`); restart it after changing the shell |
| `just electron-check` | `tsc` (main process, preload against the client's bridge types, harness), `node --test` of the main-process modules, SPDX headers and dependency licenses; typecheck and tests also run in `just check` |
| `just electron-native` | the key listener module and, on Linux, the passkeys module (`napi build --release`, a Rust toolchain, for the passkeys `libudev-dev`; Cargo builds in `CARGO_TARGET_DIR` when set) |
| `just electron-native-check` | the crates' and the modules' `cargo fmt`, `clippy`, the crates' tests (the passkeys crate's against a software authenticator and webauthn-rs, which build a vendored OpenSSL for the tests only: `perl` and `make`), `cargo deny check` of the modules (licenses, advisories, bans, sources), their node tests (the key listener's under `xvfb-run`) |
| `just electron-package` | `web/dist`, the module, then `Tavrn-<version>.AppImage`, `tavrn_<version>_amd64.deb` and `latest-linux.yml` (electron-builder's update feed) in `apps/desktop-electron/release/`; on Windows `pnpm --filter @tavrn/desktop-electron package:win` writes the fallback's `tavrn-electron_<version>_x64-setup.exe` and `latest.yml` |
| `just electron-e2e` | the Playwright specs under `xvfb-run` against the development build (`E2E_NODE_BIN` or `E2E_NODE_URL`, ports `E2E_NODE_PORT` and `E2E_WEB_PORT`, default 8300 and 5300); the packaged-app test takes the package from `E2E_ELECTRON_APP`, `TAVRN_DESKTOP_APP` or `release/linux-unpacked/tavrn` and is skipped without one |
| `just electron-e2e-packaged` | every Playwright spec as CI runs them: the full smoke test and the packaged-app test against a package (`E2E_ELECTRON_APP`, default the AppImage of `release/`), the specs that reach the main process against the development build |

The tests:

- `node --test` (`src/main/*.test.ts`, run as TypeScript by Node): node URL validation and node domains, the settings
  file and `setNode` (the Tauri shell's cases) and the one-time import of the Tauri app's node, the CSP against
  `tauri.conf.json`, the `app://tavrn` handler (types, caching, routes, 404s, no way out of the bundle, streaming), the
  navigation, new-window, external-link and permission decisions of both windows, the sign-in page URL (the Tauri shell's
  cases), the dev server URL, the resolver with a fake fetcher and SRV lookup for every step and error plus the real
  fetcher against a local server (user agent, redirects, size cap), the picker's page, sources and answers, the updater
  (feed settings, the update key, notes, both commands, the signed feed: a signature made by the real Tauri CLI with a
  throwaway key, and unsigned, foreign, changed and mismatched feeds refused before any download), minisign's formats
  (`minisign.test.ts`, throwaway Ed25519 keys written by the test; `scripts/verify-feed.test.mjs` for the release's
  check), the IPC registry (every channel registered, the sender decision, argument
  checks, refusals as values, not implemented), the events and the `shell` handlers; the keychain (the Tauri shell's cases,
  the memory and unavailable modes, the `safeStorage` store with a fake cipher: only ciphertext in the file, a
  foreign keyring secret opens nothing, the fixed fallback key counts as no keychain, the password-store switch),
  notifications (validation, the click path, the limit), the tray (states, menu, labels, close to tray, the
  handlers) and its icons (the Tauri shell's drawing tests on the same logo, the PNG codec), downloads (the chunk
  writer, names that cannot leave the directory, the test hook, the safety net, 100 MB in 4 MiB pieces through the
  handlers with a fake dialog), the hotkeys (`src/main/hotkeys.test.ts`: the cases of `hotkeys.rs`, the key table
  against `keys.rs`, the listener's life cycle with a fake listener, the bridge's handlers), the passkeys
  (`passkeys.test.ts` with a fake module and a recording dialog: the origin from the settings, the steps in the
  dialog, PIN and choices back to the module, cancel, one at a time, the codes, the handlers' argument checks;
  `passkey_dialog.test.ts`: the page without script, the texts in both languages, the answers checked;
  `passkeys_mock.test.ts`: the software key's signatures, PIN, choice and cancel).
- The passkeys module (`native/passkeys`): the crate's tests (`cargo test -p tavrn-fido`: the options and their
  bounds, the relying party rule and `clientDataJSON` with the Windows app's cases, the CTAP requests, the answers'
  JSON with the PRF apart, the error codes, the PIN and choice plumbing, the FIDO report descriptors; and
  `tests/soft_authenticator.rs`: tavrn-node's own options from webauthn-rs through the mapping to the software passkey
  of `webauthn-authenticator-rs`, whose bytes are parsed as Mozilla's crate parses a key's, and back, accepted by
  webauthn-rs exactly as the node verifies: registration, sign-in, the PRF request, another origin refused) and a node
  test of the built module (refusals before any key is asked, one ceremony at a time, a cancel while it waits for a
  key). A real key cannot be tested in CI.
- The key listener: the crate's unit tests (and its X test, `xvfb-run -a cargo test -- --ignored`) and a node test of the
  built module (`native/keywatch/test/`: unknown keys refused, no X display, real key presses through xdotool under
  `xvfb-run` only).
- Vitest (`web/src/platform/electron.test.ts`, `electronFiles.test.ts`, `index.test.ts`): the detection, the detection
  order, and the binding with a fake bridge (node choice, delegation, refusals, external links, updater and its refused
  signature, hotkeys,
  events, keychain, tray, downloads in 4 MiB pieces, passkeys and the keys plugged in); `web/src/lib/passkeys.linux.test.ts`
  (in-app passkeys while a security key is plugged in, asked on demand and on focus); also the sign-in window's marker (`inSignInWindow` with and
  without it).

The Playwright specs (no WebDriver) all start the app through `e2e/launch.ts`: sandboxed, driven over the DevTools
protocol (`--remote-debugging-port=0` on 127.0.0.1 and `connectOverCDP`), the development build's main process reached
through Node's inspector (`--inspect=0`; the packages keep it off). Playwright's own Electron driver is not used: it
switches Chromium's sandbox off. The node runs in development mode with a fresh database in `data-dev/electron-<port>`
and names this checkout's client on a Vite dev server as its web client (`TAVRN_WEBAUTHN_ORIGIN`), so the sign-in window
shows the client under test; the app gets its own `XDG_CONFIG_HOME`, always on xvfb's X display (24-bit,
`WAYLAND_DISPLAY` removed, `--ozone-platform=x11`), so no window appears on the desktop. Screenshots land in
`apps/desktop-electron/test-results/`.

- `e2e/smoke.spec.ts`: the app starts on `app://tavrn` in a secure context with the bridge and nothing of Node, the CSP
  blocks an inline script; the shell's resolver reports a domain without a node, the advanced URL refuses `http://evil`,
  the address of an account (registered over the API with TOTP) on the development node finds its login page with the
  username filled in; that account signs in with password and TOTP in the app (the recovery key is set up there);
  another one signs in on the node's page in the sign-in window (no bridge there, the marker in its user agent, password
  and TOTP, the confirmation), the app takes over and the window closes, and the page signed its own session out (two
  devices, no orphan); `getUserMedia` gets Chromium's fake microphone and camera without a prompt, notifications stay
  denied, and `getDisplayMedia` opens the shell's picker (no bridge, focus on the first screen, axe WCAG 2.2 AA clean):
  a screen is shared, Escape refuses. Last, the packaged app over CDP with `ELECTRON_RUN_AS_NODE=1` and `--inspect`
  (both ignored by the fuses) shows the bundled client and reaches the login page; it runs only when there is a package
  (`just electron-package` first).
- `e2e/electron-passkeys.spec.ts`: passkeys with the software security key of a development build
  (`TAVRN_DESKTOP_TEST_PASSKEYS=pin=<PIN>` or `nopin`; a package ignores it) in place of the native module, against the
  node: the node's registration and sign-in options through the bridge, a wrong and the right PIN in the shell's dialog
  (axe WCAG 2.2 AA on it), the node accepts both answers and the origin in `clientDataJSON` is the node's web client,
  Escape cancels, a foreign relying party is refused without a dialog; then in the client: Settings → Security → Add
  passkey (two touches with the PIN: the registration and the PRF), signing out, "Sign in with a passkey", and the
  passkey's PRF unlocks the encrypted messages without the recovery key.
- `e2e/electron-services.spec.ts`: a key survives a restart of the app in the real keyring (skipped without a Secret
  Service in the session, see below), a notification's click brings the hidden window back and the page receives its
  path (xvfb has no notification server: the test replaces `Notification` in the main process by a recorder and clicks
  that, so the shell's real click path runs), the client's voice state and texts reach the tray, close to tray hides the
  window, the setting is persisted and Quit ends the app, a save goes into `TAVRN_DESKTOP_TEST_SAVE_DIR` byte for byte,
  "show in folder" names exactly that file (the file manager replaced by a recorder) and the page's own `<a download>`
  lands there too.
- `e2e/electron-smoke.spec.ts`, **the full smoke test**: the development build by default, the package of
  `E2E_ELECTRON_APP` when set; the second user's Chromium is sandboxed too, and the node runs with voice (its
  livekit-server on ports derived from `E2E_NODE_PORT`). Steps, each with its time in the report and a screenshot: the
  node picker; sign-in with TOTP on the node's page in the sign-in window and the recovery key; an encrypted message in
  both directions with a second user (Chromium, the node's own web client), checked to be ciphertext on the node; an
  encrypted image in the media viewer; voice with Chromium's fake microphone (the other side sees the app speaking); the
  fake camera (the other side sees the video); a screen share through the shell's picker (the axe gate, WCAG 2.2 AA, on
  the picker window; the first source; the other side joins the stream, as shares are opt-in, and sees it);
  push-to-talk on the left Ctrl alone, pressed through the X server with xdotool while the second user's Chromium window
  has the X focus (the app transmits, and its page itself receives no key event); close to tray (the call stays) and
  restore by starting the app again (against a package only the restore: closing the window needs its main process, out
  of reach there); quit through the shell.
  `E2E_ELECTRON_PARTIAL=1` turns the steps whose part of the shell a branch lacks (the sign-in window, the picker, the
  tray) into notes instead of failures; CI never sets it. An AppImage runs with `APPIMAGE_EXTRACT_AND_RUN=1` (no FUSE).

The keychain step with the real keyring runs the specs in a D-Bus session of its own with an unlocked gnome-keyring
(as the Tauri job's "The real Linux keychain" step), so nothing touches the keyring of the desktop session:

```sh
xvfb-run -a dbus-run-session -- bash -c 'echo e2e-keyring | gnome-keyring-daemon --components=secrets --daemonize --unlock >/dev/null &&
  cd apps/desktop-electron && env -u WAYLAND_DISPLAY -u ELECTRON_RUN_AS_NODE E2E_NODE_BIN=/path/to/tavrn-node pnpm exec playwright test --config e2e/playwright.config.ts'
```

Set `XDG_DATA_HOME` to a scratch directory around it to keep the test keyring's files out of `~/.local/share/keyrings`.

The app reads `TAVRN_DESKTOP_DEV_URL` (development runs only). The Tauri shell's test hooks keep their names where the
feature exists in the Electron shell (`TAVRN_DESKTOP_KEYCHAIN`, `TAVRN_DESKTOP_TEST_SAVE_DIR`); `TAVRN_DESKTOP_FAKE_AUDIO`
has no counterpart: Chromium's fake devices (`--use-fake-device-for-media-stream`) replace it.

### Builds and releases (Electron)

**CI**: the job `Desktop (Linux, Electron)` of `.github/workflows/desktop.yml` on `tavrn-heavy` (`ubuntu-latest` for
forks, Dependabot and release tags, which it builds from the tag) runs, in this order: `pnpm install`, the web bundle,
the shell's checks, the key listener (the crate's and the module's checks, `napi build`, the node test under xvfb), the
packages, which it uploads at once as `desktop-linux-electron` (the `.AppImage`, the `.deb`, `latest-linux.yml` and
the `.sha256` of both packages), then the tools of the specs (Chromium, `just` from its release with a pinned checksum,
livekit-server checked by `just livekit-install`) and every Playwright spec (the full smoke test and the packaged-app
test against a copy of the AppImage, the others against the development build, the keychain spec with gnome-keyring in
a D-Bus session of its own; the node binary copied out of the node image, for a release one pinned by digest), and
uploads `desktop-linux-electron-screenshots`.

**Downloads of a build** (the egress allowlist of a runner): the Electron runtime
(`github.com/electron/electron/releases`) and electron-builder's AppImage runtime, fpm and 7-Zip
(`github.com/electron-userland/electron-builder-binaries/releases`), both redirected to
`release-assets.githubusercontent.com` or `objects.githubusercontent.com`; npm packages (`registry.npmjs.org`, with
`@napi-rs/cli`) and crates (`crates.io`, `static.crates.io`, with `napi`). Electron and electron-builder cache them in
`ELECTRON_CACHE` and `ELECTRON_BUILDER_CACHE` (default `~/.cache/electron`, `~/.cache/electron-builder`).

**The Windows fallback** is the job `Desktop (Windows, Electron fallback)` on `windows-latest` (release tags, or by hand
with `electron-windows: true`): `pnpm install`, the web bundle, the key listener module built with the MSVC toolchain
(the crate's Windows hook), `pnpm --filter @tavrn/desktop-electron package:win` (NSIS, `latest.yml`), a check of the
file names; artifact `desktop-windows-electron`. The shell's tests run in the Linux job.

**Releases** carry the Linux packages, the Windows fallback and their signed feeds ([What a release
carries](#what-a-release-carries)).

## Development

This section and its tests are the Tauri shell's; the Electron shell's are in [Development and tests
(Electron)](#development-and-tests-electron). On Linux the Tauri shell builds for development and its tests only (Linux
ships the Electron shell). System packages on Linux (Debian/Ubuntu names): `libwebkit2gtk-4.1-dev libgtk-3-dev
libayatana-appindicator3-dev librsvg2-dev`; for the native voice engine `libasound2-dev`, for the webview's own media
the GStreamer plugins of "Voice", for the voice test between a browser and the app `tauri-driver`, the WebKit WebDriver
(`webkit2gtk-driver`, on Ubuntu 26.04 `webkitgtk-webdriver`) and `xvfb`. A Rust toolchain (stable, at least 1.90) and the requirements of the web client (README "Development"). On
Windows: the Microsoft C++ build tools and WebView2 (preinstalled on Windows 10 and 11).

```sh
pnpm install
just desktop-dev        # the app with the client from the Vite dev server (hot reload)
just build              # web/dist, which the shell embeds
just desktop-check      # cargo fmt, clippy, tests, cargo deny (licenses) of the shell
just desktop-build      # Windows: the .msi and NSIS installers; Linux: the binary only (no bundles)
```

The installers land in `<cargo target dir>/release/bundle/`, the binary in `<cargo target dir>/release/tavrn`
(`apps/desktop/src-tauri/target` unless `CARGO_TARGET_DIR` is set). A node for the app: any node over https, or `tavrn-node --dev` on this computer (the
picker accepts `http://127.0.0.1:8080`).

### Tests

- Rust: `cargo test` in `apps/desktop/src-tauri` (node URL validation, settings file, navigation guards of both windows,
  the sign-in page URL, the resolver with a fake fetcher and SRV lookup for every step and error plus the real fetcher
  against a local server, updater key, the hotkeys: bindings (single keys, lone modifiers, combinations, Super/Cmd/Win,
  duplicates), the matcher (most specific binding, release by a modifier, key repeat), the key table of both platforms,
  the key filter and the listener's lifecycle (only while signed in with bindings, holds released when it stops); the
  media permissions; the security properties of `tauri.conf.json` and the capabilities, the bundle targets (Windows
  only), the keychain with the in-memory mock store of keyring-core and its entry names, notification
  validation, the tray's states, icons and labels, the installer licence and the icons of the bundle; downloads: the
  chunk writer (temporary file, rename, size limit, abort and cleanup), the registry of running saves (no second begin
  with the same id, at most 8), file names from the webview that cannot leave the chosen directory).
  The native voice engine: the gate and level meter (thresholds, hysteresis, hold, ramps, push-to-talk), the
  microphone path (any device rate and channel count to 10 ms frames at 48 kHz, processing before the volume, the
  push-to-talk release delay, nothing sent while muted), the mix (gains, deafen, start buffer, bounded delay,
  speaking levels), the resampler, the key index and key ring, the validation of every command argument (keys and
  tokens never in the debug output) and the events as the client reads them.
  `just desktop-voice-test` (`cargo test --test voice_livekit -- --ignored`, needs `livekit-server`): two native
  engines with the fake audio backend join one room end-to-end encrypted with a fixed key and hear each other, a third
  engine with another key hears nothing, the voice keeps flowing after a key change, mute and deafen stop it.
  `cargo test -- --ignored os_keychain` writes, reads and deletes an entry in the real keychain of the machine;
  desktop.yml runs it with gnome-keyring in a D-Bus session. `xvfb-run -a cargo test` in `apps/desktop/crates/keywatch`
  drives the X11 key listener with `xdotool` (a lone modifier, an unwatched key, key repeat) and connects to the display
  (its file socket or else its abstract socket) and to its abstract socket with the Xauthority cookie; without
  `xvfb-run` these tests are skipped.
- Vitest, with the other tests of the client (`just test`): the platform detection and both implementations (Tauri
  mocked with `@tauri-apps/api/mocks`), the node picker, Settings → App, the API base plumbing, the flows the app
  does not offer, the key store with the keychain (migration, fallback, lock on close, sign-out), the routing of
  notifications, the notification settings of the app, the tray wiring; the hotkeys (the settings and their migration,
  conflict check, recorder with lone modifiers, matching the window's keys, merging them with the shell's, the bridge to
  the shell and its listener switch, the voice session's reaction to presses and releases); downloads (`saveFile` in the
  browser and through the shell: 4 MiB chunks, cancel, abort on errors, the "saved to" toast).
- `node --test` of the release scripts (`latest.json`, the checksums, the asset set of a release as the website's
  download page reads it, the release notes' table) and of the installer licence (`pnpm --filter @tavrn/desktop test`).
- Playwright (`e2e/tests/desktop.spec.ts`, simulated shell): the node picker with address first and the advanced URL,
  Settings → App, the sign-in on the node's page with the page in a second browser context (as a browser tab, which
  keeps its session, and as the sign-in window, which signs itself out: no extra device), "Unlock with a passkey" and
  a passkey sign-in through the page that unlocks the app; `desktop-connect.spec.ts`: the node's `/connect` page in
  session mode with password and TOTP, registration with a passkey, a passkey-only sign-in and single sign-on,
  `method=passkey` with the sealed unlock material (opened with libsodium in the test) and an unlock session; `desktop-shell.spec.ts`: the keychain fallback and migration, native notifications and
  their click, close to tray and quit, and the tray following a real voice connection.
- The WebDriver smoke test of the built Tauri app on Linux retired with the Linux bundles; the built Tauri app is driven
  only by the voice test below. The Electron shell's full smoke test covers the shared client in a built app
  ([Development and tests (Electron)](#development-and-tests-electron)); on Windows the Tauri app is checked by hand (a
  real passkey ceremony in the sign-in window among it).

- Voice between a browser and the app (`e2e/tests/desktop-voice.spec.ts`, `just desktop-voice-e2e`, under xvfb-run):
  a Chromium participant with the fake microphone and the built Linux app with its native engine
  (`TAVRN_DESKTOP_FAKE_AUDIO=1`: a tone in, a level meter out, for machines without sound hardware) join one channel
  of the test node; Chromium sees the app's microphone track encrypted and decodes its tone, the app shows the
  browser user speaking (decrypted and measured by the engine), axe (WCAG A/AA) scans the app's Settings → Voice and
  the joined channel, and the app's CPU is measured talking and muted (`test-results/desktop-voice-cpu.json`).

  ```sh
  pnpm --filter @tavrn/web build && pnpm --filter @tavrn/desktop tauri build --no-bundle
  E2E_NODE_BIN=/path/to/release/tavrn-node E2E_NODE_PORT=8600 E2E_WEB_PORT=5600 just desktop-voice-e2e
  ```

### Recipes and test hooks

| Recipe | What it does |
|---|---|
| `just desktop-dev` | the app in Tauri's development mode, the client from the Vite dev server |
| `just desktop-build [args]` | from `web/dist`: on Windows the `.msi` and NSIS installers, elsewhere the binary only (Linux ships the Electron shell); extra arguments go to `tauri build` |
| `just desktop-check` | cargo fmt, clippy, tests and `cargo deny check` of the shell (licenses, advisories, bans, sources) (needs `web/dist`) |
| `just desktop-voice-test` | the native engine's LiveKit test (`cargo test --test voice_livekit -- --ignored`, needs `livekit-server`) |
| `just desktop-voice-e2e` | voice between Chromium and the built app (`desktop-voice.spec.ts`) under `xvfb-run`; the app from `TAVRN_DESKTOP_APP` or `<cargo target dir>/release/tavrn`, a release node from `E2E_NODE_BIN` |

The app reads these environment variables, all for tests only; each one only ever makes the app store or send less
(`TAVRN_UPDATE_BASE` only changes where a development build looks for updates):

| Variable | Effect |
|---|---|
| `TAVRN_DESKTOP_KEYCHAIN` | `memory`: the keyring crates' in-memory mock store instead of the OS keychain; `unavailable`: behave as if there were no keychain |
| `TAVRN_DESKTOP_TEST_SAVE_DIR` | saves go into this directory without a dialog (never overwriting: `name (1).ext`) |
| `TAVRN_DESKTOP_FAKE_AUDIO` | `1`: the native engine's fake audio backend (a tone in, a level meter out) for machines without sound hardware |
| `TAVRN_UPDATE_BASE` | development builds only: the host of the update feeds instead of `https://tavrn.org/updates/desktop` ([Updates](#updates)) |

`just desktop-voice-e2e` takes `TAVRN_DESKTOP_APP` (the built binary) and `E2E_NODE_BIN`, `E2E_NODE_PORT`, `E2E_WEB_PORT`
like `just e2e`.

## Builds and releases

`.github/workflows/desktop.yml` ([GITHUB.md](GITHUB.md)) builds both shells:

| Job | Runner | When | What |
|---|---|---|---|
| `Tauri shell (Linux checks)` | self-hosted `tavrn-heavy` (`ubuntu-latest` for forks, Dependabot and `dependabot/*` branches) | pushes to `main` that touch `apps/desktop`, `apps/desktop-electron`, `web`, the lockfile or the workspace; by hand (also for a pull request's branch); not for release tags | the Tauri shell's checks on Linux: cargo fmt, clippy, the tests of `src-tauri` and of the key listener crate, `cargo deny check` (licenses, advisories, bans, sources), the real Secret Service, the release scripts' tests; no bundles and no artifact (Linux ships the Electron shell; `just desktop-check` is the local equivalent) |
| `Desktop (Windows NSIS, cross-compiled)` | self-hosted `tavrn-heavy` | as above, never for forks, Dependabot or release tags | `tauri build --target x86_64-pc-windows-msvc --runner cargo-xwin --bundles nsis`; artifact `desktop-windows-nsis` (the current Tauri installer of `main` is always there) |
| `Desktop (Linux, Electron)` | self-hosted `tavrn-heavy` (`ubuntu-latest` for forks, Dependabot and release tags) | as above; release tags | the Electron shell's checks, the key listener module, `.AppImage`, `.deb` and `latest-linux.yml` (uploaded with their sums before the specs run), every Playwright spec (the full smoke test against a copy of the AppImage); artifact `desktop-linux-electron` ([Builds and releases (Electron)](#builds-and-releases-electron)) |
| `Desktop (Windows)` | GitHub-hosted `windows-latest` | release tags; by hand with `windows: true` | the Tauri `.msi` and NSIS installers, built without any secret; artifact `desktop-windows` |
| `Desktop (Windows, Electron fallback)` | GitHub-hosted `windows-latest` | release tags; by hand with `electron-windows: true` | the Electron shell's NSIS installer `tavrn-electron_<version>_x64-setup.exe`, its block map and `latest.yml` (the key listener module built with the MSVC toolchain of the runner); artifact `desktop-windows-electron` |
| `Desktop (macOS, universal, unsigned)` | GitHub-hosted `macos-latest` | release tags; by hand with `macos: true` | the Tauri app as one universal build (Apple Silicon and Intel): `Tavrn_<version>_universal.dmg` and the updater's app archive `Tavrn_<version>_universal.app.tar.gz`, signed ad hoc only, built without any secret; artifact `desktop-macos`. `continue-on-error`: a failure never fails a release ([macOS](#macos)) |
| `Release assets` | GitHub-hosted `ubuntu-latest`, environment `release` | release tags, once the owner approved | the only job with the updater key: signs the Tauri installers (and the macOS app archive) and the Electron feeds, writes the checksums and `latest.json`, verifies every signature, attests the build provenance, checks the asset set and attaches it to the release ([The release procedure](#the-release-procedure)) |

All artifacts are kept for 7 days.

- **The self-hosted route** runs on the organization's runner image (`just-tavrn/.github`, `runner/README.md` "Desktop
  builds"): WebKitGTK, xvfb, xdotool, gnome-keyring, livekit-server, `cargo-xwin`, NSIS and LLVM are in the image, the
  jobs install nothing, and Cargo builds in the runner's cache slot (`CARGO_TARGET_DIR`). The Microsoft CRT and Windows
  SDK that cargo-xwin links against come from the runner's cache (`XWIN_CACHE_DIR`, prepared when the runner starts);
  the job fails with a clear message when it is missing and never downloads it itself (the SDK's licence forbids
  publishing it, so it is never part of an artifact either).
- **Pull requests** start no desktop build: they run the quick checks of `ci.yml` only. A pull request's branch is
  built by hand (`gh workflow run desktop.yml --ref <branch>`); changes to the workflow file alone start nothing either.
- **Trusted events only:** a self-hosted runner executes the code it checks out, so the jobs keep the trust rule of the
  organization's `rust-ci.yml`: code from forks, from Dependabot and from `dependabot/*` branches builds on
  `ubuntu-latest` and skips the cross-compiled installer. A manual run executes the dispatched branch on the runner:
  dispatch only branches you reviewed. **Release builds are GitHub-hosted throughout** (`ubuntu-latest`,
  `windows-latest`), and **the build jobs hold no secret**: a compromised dependency in a build (a crate's build script,
  an npm package) never sees the updater key. Only `Release assets` holds it, in the environment `release` (tags `v*`,
  the owner's approval): it installs the Tauri CLI alone without lifecycle scripts, runs no build, no cargo and no
  cache, and signs the finished files (`apps/desktop/scripts/release-workflow.test.mjs` fails when another job names
  the key or `Release assets` starts building).
- **The Linux packages are uploaded before the specs run**: `Desktop (Linux, Electron)` hashes the `.AppImage`, the
  `.deb` and the feed and uploads them right after packaging, then downloads the node binary, Chromium and
  livekit-server for the specs and tests a copy of the AppImage; `Release assets` checks the sums before it signs. A
  release's specs run against a node image pinned by digest (`TAVRN_RELEASE_NODE_IMAGE`, GITHUB.md).
- **Limits of the cross-compiled installer** (experimental upstream, [Tauri: build Windows apps on
  Linux](https://v2.tauri.app/distribute/windows-installer/#build-windows-apps-on-linux-and-macos)): NSIS only (the
  `.msi` needs WiX, which runs on Windows), x86_64 only, built but not started (no Windows on the runner), no updater
  signature. It is for testing by hand; releases ship the installers of `windows-latest`.
- By hand for any branch: `gh workflow run desktop.yml --ref <branch> -f windows=true -f electron-windows=true` adds
  the `windows-latest` builds of both shells; `-f macos=true` the macOS build.

### What a release carries

| Platform | File | With it |
|---|---|---|
| Windows (recommended) | `Tavrn_<version>_x64-setup.exe`: the Tauri app, an NSIS installer for the current user | `.sig` (updater signature), `.sha256` |
| Windows (recommended) | `Tavrn_<version>_x64_en-US.msi`: the same app as an MSI package | `.sig`, `.sha256` |
| Windows (fallback) | `tavrn-electron_<version>_x64-setup.exe`: the Electron app, **marked as the fallback** for computers where WebView2 causes trouble ("full version", about 100 MB larger) | `.sha256`, `.blockmap` (electron-updater's differential download) |
| Linux | `Tavrn-<version>.AppImage`: the Electron app, runs without installing | `.sha256` |
| Linux (Debian, Ubuntu) | `tavrn_<version>_amd64.deb`: the Electron app with the sandbox profile for Ubuntu, the recommended Linux package there ([Packages and the Chromium sandbox](#packages-and-the-chromium-sandbox)) | `.sha256` |
| macOS (experimental, when its build succeeded) | `Tavrn_<version>_universal.dmg`: the Tauri app for Apple Silicon and Intel, **not signed or notarized** ([macOS](#macos)) | `.sha256` |
| macOS (update) | `Tavrn_<version>_universal.app.tar.gz`: the app archive the Tauri updater installs | `.sig`, `.sha256` |
| Update feeds | `latest.json` (the Tauri updater: the Windows installers and the macOS app archive with their `.sig`), `latest.yml` (the Windows fallback), `latest-linux.yml` (Linux) | `latest.yml.minisig`, `latest-linux.yml.minisig` ([Updates](#updates)) |
| Node operators | `tavrn-web-<version>.tar.gz`: the web client bundle (from `release.yml`) | `.sha256` |

The names are the ones the website's download page reads (tavrn-website `src/lib/releases.ts`): every Linux package and
every file with "electron" in its name counts as the Electron shell, every other installer as Tauri (so the Windows
fallback must carry "electron" in its name; electron-builder's default `tavrn Setup <version>.exe` would be ignored),
an AppImage without an architecture in its name counts as x64, and feeds, sums, signatures and block maps are not
downloads. `apps/desktop/scripts/release-assets.mjs` keeps the list: it checks a release against it with those rules
re-implemented (a file missing, unexpected or misread fails the release), and writes the table of downloads at the top
of the release notes, the fallback marked, before GitHub's generated notes. `<asset>.sha256` is in `sha256sum` format
(`apps/desktop/scripts/checksums.mjs`): check a download with `sha256sum -c tavrn_<version>_amd64.deb.sha256` in its
folder. `latest.json` carries no checksums (its format has no field for them; the Tauri updater checks the `.sig`).

The installers are not signed with an OS code-signing certificate yet (Windows SmartScreen warns on the first start of
either Windows installer); the project applies for one once the repositories are public (electron-builder then signs
with `CSC_LINK` and `CSC_KEY_PASSWORD` or Azure Trusted Signing, Tauri with `bundle.windows.certificateThumbprint` or a
`signCommand`, and electron-updater checks the publisher of a downloaded Windows installer). Until then the updater
signatures are the only signatures.

### macOS

The Tauri app (macOS 11 or newer) builds for macOS on GitHub's `macos-latest` runner (the repositories are public, so these runners cost
no minutes): `tauri build --target universal-apple-darwin --bundles app,dmg`, one universal binary for Apple Silicon and
Intel. **Nobody of the maintainers has a Mac**: the job is `continue-on-error`, so a failed macOS build never fails a
release (the release then has no macOS files; `release-assets.mjs` accepts the macOS group complete or absent, never
half), and a contributor with a Mac verifies the builds (help wanted: issue just-tavrn/tavrn-web#91).

**Not signed, not notarized.** Without an Apple Developer ID (99 USD a year, not planned) the app is signed ad hoc only
(`signingIdentity: "-"`). Gatekeeper therefore blocks the first start of a downloaded copy:

- macOS 14 and older: right-click (or Control-click) the app in Applications → **Open** → **Open**;
- macOS 15 and newer: open it once, then System Settings → **Privacy & Security** → "tavrn was blocked…" → **Open
  Anyway**, and confirm;
- if macOS calls the app "damaged" (an older download, a copy without its signature): `xattr -dr com.apple.quarantine
  /Applications/tavrn.app` in Terminal (`Tavrn.app` for a copy installed before version 0.4.0).

Check the download first: `shasum -a 256 -c Tavrn_<version>_universal.dmg.sha256`. Updates come through the Tauri
updater like on Windows (`latest.json`'s `darwin-aarch64` and `darwin-x86_64` entries name the signed
`.app.tar.gz`), checked with the update key; the updater's own download carries no quarantine flag, so Gatekeeper
does not ask again after an update.

What differs from Windows: no global hotkeys yet (the key listener has no macOS backend; the keys work while the
window has focus), passkeys on the node's page in the browser, the key store in the macOS keychain
(`apple-native-keyring-store`). The native voice engine is built in as on the other systems but untested on a Mac.

### The release procedure

1. Bump the version and tag (GITHUB.md "Releases"): `vX.Y.Z`, or `vX.Y.Z-rc.N` for a pre-release, which GitHub marks as
   such, so it is never "latest" for the updaters and the download page. A pre-release's MSI gets the product version
   `X.Y.Z` (WiX accepts numbers only; the file name keeps the full version).
2. `release.yml` checks the tag against `web/package.json`, runs the checks, attaches the web bundle and creates the
   GitHub release with the table of downloads in front of the generated notes.
3. It calls `desktop.yml` with `release-tag`: `Desktop (Linux, Electron)`, `Desktop (Windows)` and `Desktop (Windows,
   Electron fallback)` build from the tag on GitHub-hosted runners, without any secret. `Release assets` waits for the
   owner's approval of the environment `release` (check that the run belongs to the tag you pushed), then
   - refuses to go on while `tauri.conf.json` carries the placeholder key or the secret `TAURI_SIGNING_PRIVATE_KEY` is
     missing ([Updates](#updates));
   - downloads each build job's artifact by the id its upload reported into a directory of its own and copies only
     the files that job may deliver (`release-assets.mjs collect`: no signature, no file of another job);
   - checks the Linux packages against the sums written at packaging;
   - signs each Tauri installer (`tauri signer sign`, the Tauri CLI pinned by the lockfile, installed alone with
     `--ignore-scripts`: `<installer>.sig`, the same signature `createUpdaterArtifacts` would write during the build)
     and `latest-linux.yml` and `latest.yml` (`tauri signer sign --app-version <version>`), publishing the plain
     minisign files `<feed>.minisig`;
   - writes a `.sha256` per installer and `latest.json` (the Tauri installers only; the Electron Windows installer is
     never a Tauri update), verifies every signature exactly as the apps will (`apps/desktop-electron/scripts/
     verify-feed.mjs`, `apps/desktop/scripts/verify-tauri.mjs`), records GitHub's build provenance for every installer
     and feed (`actions/attest-build-provenance`; from the public switch on, GitHub's Free plan offers artifact
     attestations for public repositories only), checks the directory against the expected set, uploads it
     (`--clobber`), and checks the whole release including the web bundle.
4. The website's download page reads the latest release through GitHub's API by itself (tavrn-website serves the
   release data from a cached server-side proxy), so nothing tells it: the new version appears within minutes.

When a desktop job fails, the release exists with the web bundle and whatever was uploaded before: re-run the failed
jobs of the run (the upload replaces files), never tag again.

**The Windows fallback.** The Electron shell built for Windows (`pnpm --filter @tavrn/desktop-electron package:win` on
Windows, after `pnpm --filter @tavrn/keywatch-native build`): an NSIS installer for the current user with the licence
page and the icon of the Tauri installer, installed to `%LOCALAPPDATA%\Programs\tavrn` with the start menu entry "tavrn
(Electron)" and an app id of its own (`org.tavrn.desktop.electron`), so it can live next to an installed Tauri app; its
first start takes over the Tauri app's home node, as on Linux ([Settings and profile](#settings-and-profile)). It
updates itself through `latest.yml`. CI builds and packages it on `windows-latest`; its behaviour on Windows has not
been checked by hand yet. Cross-building it on Linux is not part of the setup.

**Moving from the Tauri Linux app.** Releases before the Electron packages shipped a Tauri app for Linux
(`Tavrn_<version>_amd64.deb`, `Tavrn_<version>_amd64.AppImage`). It does not update to the Electron app by itself: the
two updaters read different feeds, and `latest.json` no longer has Linux entries. Install the Electron package once by
hand; from then on it updates itself. Its first start takes over the home node from the Tauri app's settings
([Settings and profile](#settings-and-profile)); the local key store is not taken over, so you sign in again and unlock
the encrypted messages with the recovery key or a passkey, as on a new device. The old Tauri package can then be
removed.

## Updates

Both shells update themselves from the GitHub releases of tavrn-web, checked once per start (the client announces a
newer version; Settings → App installs it), and **one key** vouches for every update: the minisign key pair of the
Tauri updater.

**Channels.** Settings → App chooses the update channel: **stable** offers releases only, **beta** the pre-releases
(`-rc.N`, `-beta.N`) too. Without a choice a pre-release build follows beta and a release stable; a choice sticks
(`update_channel` in the shell's settings file, the commands `get_update_channel` and `set_update_channel`). The
updaters only ever offer a higher version (semantic versions: `0.4.0` > `0.4.0-rc.10` > `0.4.0-rc.9`), so switching an
rc build to stable never goes back: it waits for the release. The Android app's check follows the same setting
([ANDROID.md](ANDROID.md) "Updates").

**Where the feeds come from.** The apps ask the project's website, one feed per channel:
`https://tavrn.org/updates/desktop/<channel>/latest.json` (Tauri), `…/latest.yml` and `…/latest-linux.yml` with their
`.minisig` (Electron). The website answers with a redirect to that file of the right release on GitHub (stable: the
highest version that is no pre-release; beta: the highest of all; each only among the releases that carry the file),
so the signed files come from GitHub exactly as the release workflow uploaded them; the website only chooses the
release (tavrn-website `deploy/README.md`, "Desktop update feeds"). GitHub's own
`releases/latest/download/…` cannot serve a beta channel: "latest" never points at a pre-release, so every check of an
rc build was a 404. The release workflow and the asset names are unchanged: the feeds stay attached to each release.

**What a failed check says.** The shells answer one of four codes, which Settings → App names in the user's language
(`web/src/platform/updateErrors.ts`): `update.unreachable` (no network, or the website has no release list right now:
its 503), `update.no_release` (the website's 404 `no_release`: the channel has no release of this app yet; also a
release without this platform's build), `update.signature_invalid` (the update is not signed with the app's key) and
`update.failed` (anything else). The shells log the underlying reason (`tavrn: the update check at <url> failed: …`).

**Development.** A development build of the Tauri shell takes another feed host from `TAVRN_UPDATE_BASE`, e.g.
`http://127.0.0.1:18089/updates/desktop` for the website's container with its fake GitHub API (tavrn-website
`just gh-proxy-test`, or the image with `GITHUB_READ_TOKEN` set); release builds ignore it and accept https only.
To watch a check, build an older version (`pnpm --filter @tavrn/desktop tauri build --debug --no-bundle --config
'{"version":"0.4.0-rc.1"}'`) and call `check_update` from the app's page (WebDriver under `xvfb-run`).

| | Tauri (Windows) | Electron (Linux, the Windows fallback) |
|---|---|---|
| Feed | `https://tavrn.org/updates/desktop/<channel>/latest.json`, set at every check (`updater.rs`) | `https://tavrn.org/updates/desktop/<channel>/`: electron-updater's generic provider reads `latest-linux.yml` or `latest.yml` there and downloads the packages it names next to it (redirects by the version in the name); the package's `resources/app-update.yml` names the repository for the signed-feed check |
| What the key signs | every installer (`<installer>.sig`), checked by the Tauri updater | the feed (`<feed>.minisig`), checked by the shell; the feed holds the SHA-512 of every package, which electron-updater checks after the download |
| Install | download, signature check, install, restart; on Windows the installer runs in passive mode | the AppImage replaces itself and restarts; the `.deb` is installed with the system's package tools (an administrator password is asked); on Windows the NSIS installer runs |

**The signed feeds of the Electron shell.** electron-updater itself checks only the SHA-512 that the feed names (and on
Windows the publisher of a code-signed installer, which the fallback is not yet), so whoever could change a feed on a
release could ship any package. The release therefore signs each feed with the updater key (the trusted comment of the
signature names the feed file and the version), and before the shell offers an update, and again right before the
download, `apps/desktop-electron/src/main/updater.ts`

1. fetches the feed of the version electron-updater found and its `.minisig` straight from that release,
   `https://github.com/<owner>/<repo>/releases/download/v<version>/` (not through the website, so a channel that moves
   on in between cannot mix two releases),
2. verifies the signature with the public key of `tauri.conf.json` `plugins.updater.pubkey` (electron-builder writes it
   into the package's `package.json`; `src/main/minisign.ts` parses minisign's key and signature formats and checks the
   algorithm, the key id, the Ed25519 signature of the feed and the global signature over the trusted comment with
   Node's own crypto, no dependency),
3. requires the trusted comment to name this feed file and the feed's version, the signed feed to announce the version
   electron-updater found, and every file electron-updater would download to be listed in the signed feed with the same
   SHA-512.

Otherwise nothing is downloaded: the reason is logged (`tavrn: refused the update to <version>: <reason>`) and Settings →
App shows "The update was refused" (`update.signature_invalid`). A package whose key is missing or the placeholder offers
no updates, like a development run. By hand: see [Checking a download](#checking-a-download).

The key pair:

1. The owner creates the key pair once, on a trusted machine:
   `pnpm --filter @tavrn/desktop tauri signer generate -w ~/.tauri/tavrn-updater.key` (with a password).
2. The **public** key (the content of `tavrn-updater.key.pub`) replaces the placeholder
   `REPLACE_WITH_THE_OWNERS_MINISIGN_PUBLIC_KEY` in `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`)
   and is committed; both shells take it from there. Until then the apps offer no updates (Settings → App says so) and
   the release workflow refuses to build the desktop assets. The repository carries the key of the project's own
   releases; a fork that ships its own builds replaces it with its own.
3. The **private** key (the content of `tavrn-updater.key`) and its password become the secrets
   `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` of the environment `release`
   (`gh secret set TAURI_SIGNING_PRIVATE_KEY --env release < ~/.tauri/tavrn-updater.key`), never repository secrets.
   Only the `Release assets` job of a tag's run, after the owner's approval, sees them; every build, including the
   Tauri build on `windows-latest`, runs without them. Never commit the private key; losing it means installed apps
   cannot update to releases signed with a new key (they need a manual install once).

For a local signed build use a throwaway key: `TAURI_SIGNING_PRIVATE_KEY=$(cat throwaway.key)
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=… just desktop-build --bundles nsis --config
'{"bundle":{"createUpdaterArtifacts":true},"plugins":{"updater":{"pubkey":"<throwaway public key>"}}}'` on Windows; a
feed of the Electron shell is signed as the release does it:
`pnpm --filter @tavrn/desktop exec tauri signer sign --app-version <version> "$PWD/apps/desktop-electron/release/latest-linux.yml"`
with the same variables, then `base64 -d latest-linux.yml.sig > latest-linux.yml.minisig`.

### Checking a download

The `<asset>.sha256` next to every installer comes from the same release as the installer: it shows that a download
is complete and unchanged on the way, not who made it. Whoever could replace a release asset could replace its sum
too. Updates are protected by the signature (above); for the **first install**, check the download against the signed
feed or GitHub's build provenance.

The project's update key (`plugins.updater.pubkey` of `apps/desktop/src-tauri/tauri.conf.json`, base64-decoded), key
id `0A228491B01D1644`:

```
untrusted comment: minisign public key: 0A228491B01D1644
RWREFh2wkYQiCvEndPJNukS8PFRiauKz3KjZBnqNfeEHYgcg3DuNUUcn
```

Compare it with the one published on the project's website and in this repository's history before you trust it.

**Linux (AppImage, .deb) and the Windows fallback**, against the signed feed, with
[minisign](https://jedisct1.github.io/minisign/):

```sh
# in the folder with the download, latest-linux.yml and latest-linux.yml.minisig of the same release
minisign -V -P RWREFh2wkYQiCvEndPJNukS8PFRiauKz3KjZBnqNfeEHYgcg3DuNUUcn -m latest-linux.yml -x latest-linux.yml.minisig
# the trusted comment names the file and the version; then the SHA-512 of the download must be the feed's:
openssl dgst -sha512 -binary tavrn_<version>_amd64.deb | base64 -w0; echo
grep -A2 'url: tavrn_<version>_amd64.deb' latest-linux.yml      # its sha512: line must show the same value
```

(`latest.yml` and `latest.yml.minisig` the same way for `tavrn-electron_<version>_x64-setup.exe`.)

**Windows (Tauri)**: the installer's own signature `<installer>.sig` is the minisign signature base64-encoded once
more:

```sh
base64 -d Tavrn_<version>_x64-setup.exe.sig > setup.minisig
minisign -V -P RWREFh2wkYQiCvEndPJNukS8PFRiauKz3KjZBnqNfeEHYgcg3DuNUUcn -m Tavrn_<version>_x64-setup.exe -x setup.minisig
```

**Build provenance** (every installer and feed of a release built after the repository went public): GitHub's attestation names the
repository, the workflow and the commit that built the file:

```sh
gh attestation verify tavrn_<version>_amd64.deb --repo just-tavrn/tavrn-web
```
