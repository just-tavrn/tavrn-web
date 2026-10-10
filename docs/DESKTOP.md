# The desktop app

The desktop app is a [Tauri 2](https://v2.tauri.app) shell around the web client: the same React client, bundled into
an installable app for Linux (`.deb`, `.AppImage`) and Windows (`.msi`, NSIS `.exe`), that updates itself with signed
releases. macOS follows later. It lives in [`apps/desktop`](../apps/desktop): the pnpm package `@tavrn/desktop` (the
Tauri CLI) and the Rust crate `tavrn-desktop` in `apps/desktop/src-tauri` with a Cargo workspace of its own.

## What the app is

- **It bundles the client.** The app ships `web/dist` (built by Vite, exactly what a node embeds) and its main window
  never loads remote pages. Only the bundled client may call the shell's native commands; a node can never reach them.
  This matters for the keys in the OS keychain ("Keys in the OS keychain" below). The one remote page the app shows is the node's own
  sign-in page, in a second window without any capability ("Signing in").
- **It talks to the home node you choose.** The first start shows the node picker; the client then uses that node's
  API, WebSocket and media over https and wss. Rooms and conversations of other nodes work as in the browser
  (federated sessions, [CLIENT.md](CLIENT.md) "Several nodes in one client").
- **One version number.** The app's version is `web/package.json`'s (`tauri.conf.json` points at it); the product
  name is "Tavrn", the identifier `org.tavrn.desktop` (the project domain tavrn.org).

### Security of the shell

| What | Where |
|---|---|
| The main window shows only the bundled client: `tauri://localhost` (Linux), `https://tauri.localhost` (Windows), in development the Vite dev server. Every other navigation is refused; web links (http, https, mailto) open in the system browser, new windows are never opened. The click-to-play embeds load in their frames. | `src-tauri/src/guard.rs`, `src/lib.rs` |
| Content Security Policy: scripts only from the bundle (`script-src 'self' 'wasm-unsafe-eval'`, no eval, no inline scripts, no third-party scripts), `connect-src` https and wss to any node plus plain http/ws to `localhost` and `127.0.0.1` (development nodes), images and media from https, frames only for the embed providers. | `tauri.conf.json` `app.security.csp` |
| One capability for the main window: the app's commands, nothing else (no `remote` origins, no plugin or core permissions, no global Tauri object). No capability names the sign-in window (a test checks every capability file). | `src-tauri/capabilities/main.json`, `build.rs`, `src-tauri/src/conf_tests.rs` |
| The sign-in window (`connect`) shows only the chosen node's `/connect?session=…` page (`open_connect` checks origin, path and parameters) and follows https pages from there (identity providers redirect), plain http only on this computer; it never loads the bundled client or `tauri:`, `file:`, `data:`, `javascript:` or `blob:` URLs, and new windows go to the system browser. The node's web client there runs as a plain web client: only the main window counts as the app (`platform/tauriDetect.ts`). | `src-tauri/src/guard.rs`, `src/lib.rs` |
| The microphone and the camera are granted to the main window without a prompt of the webview (it shows only the bundled client); screen capture and every other permission keep the webview's default. | `src-tauri/src/media.rs` |
| The node URL is validated twice: in the client and again in the shell before it is stored. | `web/src/platform/nodeUrl.ts`, `src-tauri/src/node_url.rs` |
| Downloads are written by the shell: the webview names only a file name to suggest and a save's id, never a path; the user picks the target in the native save dialog, the shell writes a temporary file next to it and renames it into place. The dialog, opener and fs plugins have no permission in the webview. | `src-tauri/src/download.rs` |

Unit tests in `src-tauri/src/conf_tests.rs` keep these properties of `tauri.conf.json` and the capability from eroding.

### The platform layer of the client

`web/src/platform/` decides where the client's node lives. The interface `Platform` (`types.ts`) has two
implementations: `browser.ts` (today's behaviour: the node is the origin the client was loaded from) and `tauri.ts`
(the desktop app), detected at start with `isTauri()` from `@tauri-apps/api` and loaded lazily, so the browser never
runs Tauri code. Everything that imports Tauri APIs lives under `platform/tauri*`.

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
page with the username filled in. The resolution runs in the shell (`src-tauri/src/resolve.rs`; a browser cannot query
DNS, and before the first sign-in there is no node to ask):

1. `https://<domain>/.well-known/tavrn`, validated (`tavrn` = 1, `domain` equal, endpoints https/wss without
   credentials, query or fragment, `api` ending in `/api/v1`);
2. after a `404` or without an HTTPS server: the `_tavrn._tcp.<domain>` SRV records (system resolver, at most 3
   targets, lowest priority first, then highest weight), whose document must name the domain;
3. after a `404` only: `https://<domain>/api/v1`.

Errors are distinct and name the step that failed: "no node found for <domain>", "the node's document is invalid",
"cannot reach <domain>" (DNS or TLS failure, nothing listening). A development node on this computer is asked over
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
  (Linux `~/.config/org.tavrn.desktop/`, Windows `%APPDATA%\org.tavrn.desktop\`). A missing or corrupt file means
  "no node yet"; a stored address that no longer passes the validation is dropped.

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
  `windows-native-keyring-store`, `apple-native-keyring-store`), off the main thread.
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
notifications while Tavrn is in the background"); the web push section and the browser permission switch are not shown
in the app, and the app never registers a service worker or a push subscription.

The shell shows them with notify-rust (the backend of tauri-plugin-notification; the plugin itself offers no click
events on desktop and would replace the webview's `Notification` with an IPC bridge that needs plugin permissions):

| Platform | Shown by | Click |
|---|---|---|
| Linux | the desktop's notification server (D-Bus) | focuses the window and opens the conversation (the server's default action; GNOME, KDE and most others support it) |
| Windows | a toast under the app's id (the installer's Start menu entry; a development build shows the default id) | focuses the window and opens the conversation while the toast is on screen; a toast clicked later in the notification center starts the app, and the running one comes to the front (to be confirmed by hand on Windows) |
| macOS | (later) | — |

## Downloads

The webview of the app (WebView2, WebKitGTK) does nothing with the blob downloads a browser handles, so every download
of the client (attachments, files channels, the data export, recovery keys and codes, whiteboard images) goes through
one entry point, `saveFile({ name, data, mime })` in `web/src/platform/saveFile.ts`. In the browser it is the anchor
download of before; in the app the shell shows the native save dialog and writes the file (`src-tauri/src/download.rs`):

| Command | What it does |
|---|---|
| `save_file_begin(name, size)` | shows the save dialog (the name, cleaned of path parts and characters Windows refuses, is its suggestion; a filter for its extension) and answers `{ status: "ready", id }`, or `{ status: "cancelled" }` when the user closes it; at most 8 saves at once |
| `save_file_chunk` | appends a raw IPC body (header `x-tavrn-save: <id>`) to a temporary file next to the target; the client streams the blob in 4 MiB slices, so a large decrypted file never sits twice in memory; more bytes than `size` are refused |
| `save_file_end(id)` | checks that `size` bytes arrived, flushes the file and renames it into place; answers the path and the name of its folder |
| `save_file_abort(id)` | removes the temporary file (the client calls it when reading or writing fails) |
| `save_file_reveal(id)` | shows a finished save in the file manager (by its id: the webview never names a path) |

After a save the client shows "Saved to <folder>" with a **Show in folder** button (in the live region of the toasts);
a cancelled dialog shows nothing. Previews and playback keep their object URLs. A download the webview still starts by
itself (an `<a download>` or a navigation to a file) is caught too: the webview writes it into the app's cache, then
the same save dialog asks where it goes (cancelled: the file is removed).

Test hook: when the app starts with `TAVRN_DESKTOP_TEST_SAVE_DIR=<dir>`, no dialog is shown and every save goes into
that directory (never overwriting: `name (1).ext`). It exists for the WebDriver smoke test only; never set it otherwise.

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

The tooltip names the channel and the state ("Tavrn · Lounge (Gaming) · Speaking"). The voice store drives it at most
every 150 ms, so speaking does not make the icon flicker. The menu (right click; on Linux any click): Show/Hide Tavrn,
Mute microphone, Deafen, Leave voice channel, Quit Tavrn; a left click on Windows shows the window.

**Close to tray** is on by default on every platform (the owner's choice): closing the window hides it and the app
keeps running (voice, notifications). The tray menu brings it back, and so does starting the app again (a second start
shows the running app instead of opening another one; on Linux this needs the D-Bus session bus). Quit is in the tray
menu and in Settings → App, where close to tray can be turned off. GNOME shows tray icons only with the AppIndicator
extension; without it, start the app again to get the window back.

## Icons

The app icons are generated from the project logo, cropped first (the web icon keeps a wide margin for the browser's
masks; a window, taskbar or tray icon should fill its canvas):

```sh
magick web/public/icon-512.png -trim +repage -set option:side "%[fx:round(max(w,h)*32/30)]" -background none \
  -gravity center -extent "%[side]x%[side]" -resize 512x512 /tmp/tavrn-icon.png
pnpm --filter @tavrn/desktop tauri icon /tmp/tavrn-icon.png
```

This writes `src-tauri/icons/` (32, 64, 128 and 256 pixel PNGs and `icon.png` for Linux and the window, `icon.ico` for
the Windows installer, taskbar and window, `icon.icns` for macOS later); delete the generated `android/`, `ios/` and
Windows Store images, the app does not use them. Unit tests check that every icon of `tauri.conf.json` exists and that
the PNG icons fill at least 85 % of their canvas. The
logo and the icons are not covered by the Apache License ([TRADEMARK.md](../TRADEMARK.md)).

## Licence and terms in the installers

`apps/desktop/LICENSE.txt` is what the installers show: the Apache-2.0 licence of the app, its NOTICE and the terms of
use and privacy notice ([`apps/desktop/TERMS.md`](../apps/desktop/TERMS.md): no warranty, the chosen node's operator
handles accounts and content, update checks go to GitHub, no telemetry, what the app stores and how to remove it,
embedded players only after a click, contact). It is generated: edit `TERMS.md` (or the licence or NOTICE) and run
`pnpm --filter @tavrn/desktop license-txt`; a test fails while the committed file is not current, and it must stay
plain ASCII (the NSIS page shows it as is).

| Installer | Licence |
|---|---|
| Windows NSIS (`-setup.exe`) | a licence page that must be accepted before installing (`bundle.licenseFile`) |
| Windows MSI | the licence dialog of the installer |
| Linux `.deb` | no accept step (Debian packages have none); the file is installed as `/usr/share/doc/tavrn/LICENSE.txt` |
| Linux AppImage | no installer, no accept step; the terms are in the repository and on the release page |

## Signing in

Passkeys are bound to the node's domain, the captcha to its host names and single sign-on to its web client: none of
them can run on the app's own origin. On nodes that announce `connect.app` (app sessions of the connect flow,
FEDERATION.md §8 step 3) the app signs in on the **node's own page** instead:

1. The login page offers "Sign in on <node>'s page" and takes it by itself for "Sign in with a passkey", the SSO button
   and whenever the node asks for a captcha (login or registration: the registration then happens on the node's page).
2. The app creates an app session with a PKCE challenge (`POST /auth/connect/session`) and a fresh X25519 key pair,
   and the shell opens `<web>/connect?session=…[&method=passkey|sso]#k=<public key>` in the sign-in window, which has
   no native API at all. The passkey and SSO buttons add `method=`: the page starts that method at once and shows only
   "Signing in with a passkey…" with "Use another method". The key is in the URL fragment, which never reaches a
   server; the page keeps it for the window's session and removes it from the address bar.
3. The user signs in there with any method (password and second factor, passkey, SSO, registration with captcha) and
   confirms "Sign in to the Tavrn app?" with the app's device name; the page says "return to the app". The page never
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
the sign-in window with `method=passkey`. The page asks only for the passkey ("Unlock the Tavrn app?"; after a passkey
sign-in there it needs no second ceremony) and returns the sealed box without a code; the node accepts it only from
the account the app is signed in with. The app unlocks and stores the master secret in its (keychain-protected) local
key store.

The node only ever holds the sealed box, which it cannot open, hands it out once and never logs it. The trust is the
browser's: the node's web client in the window sees the PRF output, as it does in a browser tab. The box is libsodium's
sealed box (the construction of the webhook inbox keys), through the functions `@tavrn/crypto` already has
(`web/src/crypto/sealedUnlock.ts`).

While it waits the app offers "Open the page again", **"Open in the browser instead"** (the same page in the system
browser; the app keeps polling) and "Cancel" instead of its own form. On Linux the sign-in window cannot use passkeys (WebKitGTK has no
WebAuthn) and the app says so: passkeys work through the browser there (the key in the fragment goes along, so the
passkey unlocks the app from the browser too); on Windows (WebView2) they work in the window.
Nodes without `connect.app` keep password and TOTP in the app; their passkeys, SSO and captcha need a browser.

**The page's own session after the handoff.** Signing in on the node's page creates a session (a device) of the page
itself. In the sign-in window the page signs that session out once the handoff is done, so no orphan device of the page
stays in the account's device list: after an unlock at once (nothing is exchanged), after a sign-in as soon as the app
has exchanged the code (the node accepts a code only while the page's device still has a session, so the page watches
its own device list until the app's device appears or its last login moves; once the code expired after 120 seconds it
signs out anyway). The app continues at once and closes the window a few seconds later
(`APP_CLOSE_GRACE_MS` in `web/src/platform/appSession.ts`), after the page signed out. The page knows the sign-in window
by the Tauri window label `connect` (`inSignInWindow`, `web/src/platform/tauriDetect.ts`). The same page in a browser
tab (the Linux fallback, "Open in the browser instead") keeps its session, as a browser user expects. The window's
storage is persistent, not private: the node's page keeps its local settings (such as the language) between
handoffs; only the session goes, so every handoff asks for a sign-in on the page.

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
  keeps only the registry of the running app (`src-tauri/src/hotkeys.rs`); at every start the client hands it the
  stored bindings.
- **How they reach the call:** in the window the client's own key events (`web/src/voice/hotkeys.ts`, also the browser);
  in the desktop app also the shell's key listener, which reports presses and releases of the bound actions over a
  channel the client opened (`listen_hotkeys`). While the window has focus both see the same key; the client counts the
  window's events then and the shell's only while the window is in the background (`voice/hotkeyHolds.ts`), so a tap
  toggles once, and a key held while switching to the game stays held. Push-to-talk opens the gate while held (with the
  release delay of the settings) and needs the input mode "Push to talk"; the priority key also opens it there.
  Outside a call a toggle shows what the next voice channel gets.

### The key listener: observe, never grab, never log

The shell's listener (`src-tauri/src/keywatch/`) **observes** keys: it never takes a key away from the program that has
the focus, so a game still receives the push-to-talk key it also uses (a grab, as `RegisterHotKey`/`XGrabKey` do, would
take it away, and the system refuses grabs of a modifier alone).

| Platform | How | Notes |
|---|---|---|
| Windows | a low-level keyboard hook (`SetWindowsHookExW(WH_KEYBOARD_LL)`) on a thread of its own, which always passes the key on (`CallNextHookEx`); the scan code tells the physical key | Keys going to a window of a program that runs elevated (as administrator) are not seen by an app that is not elevated (UIPI): push-to-talk does not react in such a game. A release the hook misses (Ctrl+Alt+Del, an elevated window in front) is caught by a check every 500 ms (`GetAsyncKeyState`), so push-to-talk cannot stay open. |
| Linux, X11 | the X RECORD extension on two X connections of its own ([x11rb](https://crates.io/crates/x11rb), pure Rust); the keycode tells the physical key | The releases of X11's key repeat are dropped (the key is still down in the server's key map). |
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
| Browser engine (`session.ts`) | browsers; the app on Windows (WebView2) by default; macOS | livekit-client in the webview, insertable streams |
| Native engine (`nativeSession.ts` + `src-tauri/src/voice`) | the app on Linux, always; on Windows with Settings → Voice & video → **Native voice engine (experimental)** (default off, applies from the next call) | the shell joins the room with LiveKit's Rust SDK (`livekit` crate on a prebuilt libwebrtc) |

A running call keeps its engine. A build without the Cargo feature `native-voice` answers `voice.native_unavailable`
and the client keeps the browser engine.

### The native engine

The webview keeps everything but the media: it joins the MLS group, gets the LiveKit URL and token from the node
(VOICE.md §3), derives the frame key of the current epoch (ENCRYPTION.md §5a) and hands it to the shell with
`voice_join`; every newer epoch's key follows with `voice_set_key` (never an older one; the webview wipes its copy, the
shell keeps keys in memory only and never logs them). The shell (`src-tauri/src/voice`):

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

**Not in this version:** camera, screen sharing, soundboard clips and the priority speaker (the buttons are shown as
not available with the native engine, focusable and with the reason in their name), the microphone test of the
settings (it runs in the webview, `getUserMedia` exists there), macOS. **Video, the path:** native capture is the easy
part (the SDK has camera and desktop capturers and publishes video tracks with the same frame cryptor); showing remote
and own frames inside the webview is the hard part. Options: (1) decode in the shell and push frames to the webview
(I420 → RGBA over a custom protocol or shared memory into a `<canvas>`/WebGL; simple, costs a copy per frame and IPC
bandwidth, fine for 720p30 thumbnails, heavy for 1080p60 streams), (2) a native child window or surface layered over
the webview at the tile's rectangle (no copy, but window management per platform and no CSS for tiles), (3) WebCodecs in
the webview fed with encoded frames from the shell after decryption (needs WebCodecs, which WebKitGTK only partly
has). (1) is the likely first step for camera tiles.

**Linux packages:** the app links ALSA (`libasound2`; the `.deb` depends on it; building needs `libasound2-dev`).
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

### The webview's own WebRTC on Linux

WebKitGTK runs WebRTC through GStreamer and keeps it off unless the app switches it on: the shell turns on
`enable-webrtc` and `enable-media-stream` of the webview's settings (`src-tauri/src/media.rs`). At runtime these
GStreamer plugins must be installed (the `.deb` depends on them; for the AppImage install them yourself):

```sh
sudo apt install gstreamer1.0-plugins-bad gstreamer1.0-plugins-good gstreamer1.0-gl gstreamer1.0-pipewire   # or gstreamer1.0-pulseaudio
```

**The distributions' WebKitGTK is built without WebRTC.** WebKitGTK compiles WebRTC only with its experimental
features (`ENABLE_WEB_RTC` follows `ENABLE_EXPERIMENTAL_FEATURES`, off in release builds); Ubuntu 24.04 and 26.04 ship
`libwebkit2gtk-4.1` 2.52 that way (it does not link `libgstwebrtc-1.0`). There the switch has no effect:
`getUserMedia` works, `RTCPeerConnection` does not exist; that is why voice on Linux always runs in the native engine.
Check a system with `ldd /usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0 | grep gstwebrtc`.

## Limitations

What the browser gets from "the client is served by the node" and what the app does instead:

| Flow | In the app | Why |
|---|---|---|
| Password with the second factor (TOTP, recovery code) | works | ordinary API calls with bearer tokens (the node allows every origin, without cookies) |
| Registration, account settings, encryption, rooms, DMs, federation | work | same |
| Sign-in with an account of another node | the app signs in at the account's own node instead: the address (`alice@home.example`) switches the app to that node; "Sign in with an account of another node" keeps password with TOTP or a recovery code | the origin connect flow returns the code to an `https://<domain>` origin, which the app does not have; the sign-in window is bound to the app's own node. |
| Passkeys (WebAuthn) as second factor or sign-in | on the node's page in the sign-in window ("Signing in"), which also unlocks the encrypted messages (sealed unlock material); on Linux through the system browser | passkeys are bound to the node's domain; the app's origin is not the node's (and WebKitGTK has no WebAuthn). Without `connect.app` on the node: not offered, TOTP or a recovery code is required. |
| Single sign-on (OpenID Connect) | on the node's page in the sign-in window | the node sends the browser back to its own web client (`<web>/sso/callback`), which is the page in the sign-in window. Without `connect.app`: not offered, an SSO-only node shows a notice. A later step may add an app-scheme callback (RFC 8252) as an accelerator. |
| Captcha on login or registration | on the node's page in the sign-in window | the widget is a third-party script (CSP `script-src 'self'`) bound to the node's host name; the node's page loads it. Without `connect.app`: a notice, use the browser for that step. |
| Web push | not offered | there is no service worker in the app (its pages are not served by the node). The app shows native notifications instead while it runs (also from the tray); nothing reaches a device where the app is not running. |
| Desktop notifications of the browser | replaced | native notifications ("Notifications" above). |
| Voice and video | Linux: voice through the native engine, audio only; Windows (WebView2, Chromium): voice and video as in Chromium (to be confirmed by hand), or audio only with the native engine setting | the WebKitGTK of Ubuntu 24.04 and 26.04 has no WebRTC ("Voice"), so voice on Linux runs in the shell; camera and screen sharing through the native engine are a later step. |
| Popping out the whiteboard, "open original" in the media viewer | not offered | the app opens no window for content (only the sign-in window); maximize and the download icon cover it. |
| The terms and other pages that open in a new tab | open on the node's web client in the system browser | the app opens no window for content. |
| Updates while the repository is private | do not download | the updater fetches `latest.json` and the installers from the public release URLs. |

## Development

System packages on Linux (Debian/Ubuntu names): `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
librsvg2-dev patchelf xdg-utils`, for the WebDriver test also the WebKit WebDriver (`webkit2gtk-driver`, on Ubuntu
26.04 `webkitgtk-webdriver`: it provides `/usr/bin/WebKitWebDriver`), `xvfb` and `xdotool`; for the native voice
engine `libasound2-dev`, for the webview's own media the GStreamer plugins of "Voice". A Rust toolchain (stable, at least
1.90) and the requirements of the web client (README "Development"). On Windows: the Microsoft C++ build tools and
WebView2 (preinstalled on Windows 10 and 11).

```sh
pnpm install
just desktop-dev        # the app with the client from the Vite dev server (hot reload)
just build              # web/dist, which the shell embeds
just desktop-check      # cargo fmt, clippy, tests, cargo deny (licenses) of the shell
just desktop-build      # installers of this platform: Linux .deb and .AppImage, Windows .msi and NSIS
```

The installers land in `<cargo target dir>/release/bundle/` (`apps/desktop/src-tauri/target` unless
`CARGO_TARGET_DIR` is set). A node for the app: any node over https, or `tavrn-node --dev` on this computer (the
picker accepts `http://127.0.0.1:8080`).

### Tests

- Rust: `cargo test` in `apps/desktop/src-tauri` (node URL validation, settings file, navigation guards of both windows,
  the sign-in page URL, the resolver with a fake fetcher and SRV lookup for every step and error plus the real fetcher
  against a local server, updater key, the hotkeys: bindings (single keys, lone modifiers, combinations, Super/Cmd/Win,
  duplicates), the matcher (most specific binding, release by a modifier, key repeat), the key table of both platforms,
  the key filter and the listener's lifecycle (only while signed in with bindings, holds released when it stops); the
  media permissions; the security properties of `tauri.conf.json` and the capabilities, the `.deb`
  dependencies, the keychain with the in-memory mock store of keyring-core and its entry names, notification
  validation, the tray's states, icons and labels, the installer licence and the icons of the bundle; downloads: the
  chunk writer (temporary file, rename, size limit, abort and cleanup), the registry of running saves (no second begin
  with the same id, at most 8), file names from the webview that cannot leave the chosen directory).
  validation, the tray's states, icons and labels, the installer licence and the icons of the bundle).
  The native voice engine: the gate and level meter (thresholds, hysteresis, hold, ramps, push-to-talk), the
  microphone path (any device rate and channel count to 10 ms frames at 48 kHz, processing before the volume, the
  push-to-talk release delay, nothing sent while muted), the mix (gains, deafen, start buffer, bounded delay,
  speaking levels), the resampler, the key index and key ring, the validation of every command argument (keys and
  tokens never in the debug output) and the events as the client reads them.
  `just desktop-voice-test` (`cargo test --test voice_livekit -- --ignored`, needs `livekit-server`): two native
  engines with the fake audio backend join one room end-to-end encrypted with a fixed key and hear each other, a third
  engine with another key hears nothing, the voice keeps flowing after a key change, mute and deafen stop it.
  `cargo test -- --ignored os_keychain` writes, reads and deletes an entry in the real keychain of the machine;
  desktop.yml runs it with gnome-keyring in a D-Bus session. `xvfb-run -a cargo test -- --ignored x11_` drives the X11
  key listener with `xdotool` (a lone modifier, an unwatched key, key repeat).
- Vitest, with the other tests of the client (`just test`): the platform detection and both implementations (Tauri
  mocked with `@tauri-apps/api/mocks`), the node picker, Settings → App, the API base plumbing, the flows the app
  does not offer, the key store with the keychain (migration, fallback, lock on close, sign-out), the routing of
  notifications, the notification settings of the app, the tray wiring; the hotkeys (the settings and their migration,
  conflict check, recorder with lone modifiers, matching the window's keys, merging them with the shell's, the bridge to
  the shell and its listener switch, the voice session's reaction to presses and releases); downloads (`saveFile` in the
  browser and through the shell: 4 MiB chunks, cancel, abort on errors, the "saved to" toast).
- `node --test` of the update manifest script and of the installer licence (`pnpm --filter @tavrn/desktop test`).
- Playwright (`e2e/tests/desktop.spec.ts`, simulated shell): the node picker with address first and the advanced URL,
  Settings → App, the sign-in on the node's page with the page in a second browser context (as a browser tab, which
  keeps its session, and as the sign-in window, which signs itself out: no extra device), "Unlock with a passkey" and
  a passkey sign-in through the page that unlocks the app; `desktop-connect.spec.ts`: the node's `/connect` page in
  session mode with password and TOTP, registration with a passkey, a passkey-only sign-in and single sign-on,
  `method=passkey` with the sealed unlock material (opened with libsodium in the test) and an unlock session; `desktop-shell.spec.ts`: the keychain fallback and migration, native notifications and
  their click, close to tray and quit, and the tray following a real voice connection.
- WebDriver smoke test of the built Linux app (`apps/desktop/e2e/smoke.mjs`, plain WebDriver over HTTP): the app
  starts, shows the node picker, the shell's resolver reports a domain without a node, the advanced URL refuses
  `http://evil`, the address of an account (registered over the API with TOTP) on a development node finds the node
  and its login page; the account signs in on the node's page in the sign-in window (password and code there, a
  native command from that page is refused), the main window takes over the session (the page signed its own session
  out: the account has no extra device), sets up its recovery key (the
  encryption core runs in the webview) and sends a message in an end-to-end encrypted channel, which the node stores
  as ciphertext only; a file attached there is downloaded with its button, decrypted in the app and written by the
  shell (the test hook `TAVRN_DESKTOP_TEST_SAVE_DIR` instead of the dialog), byte for byte, with the "saved to" toast.
  The node needs the web client bundle (a node built with `web/dist`). That first start runs
  without a keychain (`TAVRN_DESKTOP_KEYCHAIN=unavailable`): the key stays in IndexedDB and Settings → App warns; the
  test checks the tray state the client reported (`tray_status`), gives the shell a state, and shows a notification.
  The app then starts again with the keyring crates' in-memory mock store (`TAVRN_DESKTOP_KEYCHAIN=memory`, because
  xvfb has no Secret Service): the key moves into the keychain, the IndexedDB copy is gone, and a reload unlocks from
  the keychain alone. Both values of `TAVRN_DESKTOP_KEYCHAIN` only ever store less (in memory, or nothing). Last, the
  hotkeys: Settings → Voice binds Ctrl+Alt+M to mute and the left Ctrl alone to push-to-talk, the window is minimized
  and real key presses of the X server (`xdotool`) reach the client through the shell's key listener: Ctrl+Alt+M
  toggles mute and back, holding the left Ctrl holds push-to-talk until it is released. Last, signed
  out, the passkey button opens the sign-in window with `method=passkey` and the app's key in the fragment; WebKitGTK
  has no WebAuthn, so the ceremony is simulated (a software passkey registered over the API with a PRF entry, and the
  test seals the PRF output to the key the page kept), and the built app opens the box and unlocks without the
  recovery key. A real passkey ceremony in the sign-in window is checked by hand on Windows. It needs
  `tauri-driver` (`cargo install tauri-driver --locked`) and a built app:

  ```sh
  just desktop-build
  E2E_NODE_BIN=/path/to/tavrn-node E2E_NODE_PORT=8300 just desktop-e2e    # always under xvfb-run
  ```

  The app always renders on xvfb's X display (the test forces GTK to X11 and drops `WAYLAND_DISPLAY`, which WSLg sets),
  so no window appears on the desktop. The node must serve its web client: a release build or the container image (a
  debug tavrn-node reads `web/dist` from its build tree at run time; the test refuses a node that serves the
  placeholder instead). The app is a single instance: the test waits for a quit app to exit before starting it again
  and refuses to start while the same binary runs; an installed Tavrn that is running takes over the test's start too,
  so quit it first.

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

## Builds and releases

`.github/workflows/desktop.yml` ([GITHUB.md](GITHUB.md)) builds on two routes:

| Route | Runner | When | What |
|---|---|---|---|
| Linux, natively | self-hosted `tavrn-heavy` (fallback `ubuntu-latest`) | pull requests that touch `apps/desktop`, `web`, the lockfile, the workspace or the workflow, once ready for review; pushes to `main`; by hand; release tags | the checks (fmt, clippy, tests, licenses, the real Secret Service), `.deb` and `.AppImage`, the WebDriver smoke test under xvfb against the node image's binary; artifact `desktop-linux` |
| Windows NSIS, cross-compiled | self-hosted `tavrn-heavy` | as the Linux build, except release tags | `tauri build --target x86_64-pc-windows-msvc --runner cargo-xwin --bundles nsis`; artifact `desktop-windows-nsis` (the current installer of `main` is always there) |
| Windows `.msi` and NSIS, natively | GitHub-hosted `windows-latest` | release tags; by hand with `windows: true` | the release installers with their updater signatures; artifact `desktop-windows` |

All artifacts are kept for 7 days.

- **The self-hosted route** runs on the organization's runner image (`just-tavrn/.github`, `runner/README.md` "Desktop
  builds"): WebKitGTK, `tauri-driver`, `WebKitWebDriver`, xvfb, xdotool, gnome-keyring, `cargo-xwin`, NSIS and LLVM are
  in the image, the jobs install nothing, and Cargo builds in the runner's cache slot (`CARGO_TARGET_DIR`). The
  Microsoft CRT and Windows SDK that cargo-xwin links against come from the runner's cache (`XWIN_CACHE_DIR`, prepared
  when the runner starts); the job fails with a clear message when it is missing and never downloads it itself (the
  SDK's licence forbids publishing it, so it is never part of an artifact either).
- **Trusted events only:** a self-hosted runner executes the code it checks out, so pull requests from forks and from
  Dependabot build Linux on `ubuntu-latest` and skip the cross-compiled installer. Release builds also stay on
  `ubuntu-latest` and `windows-latest`: they carry the updater key, and no long-lived secret besides the read token
  belongs on the self-hosted runners.
- **Limits of the cross-compiled installer** (experimental upstream, [Tauri: build Windows apps on
  Linux](https://v2.tauri.app/distribute/windows-installer/#build-windows-apps-on-linux-and-macos)): NSIS only (the
  `.msi` needs WiX, which runs on Windows), x86_64 only, built but not started (no Windows on the runner), no updater
  signature. It is for testing by hand; releases ship the installers of `windows-latest`.
- By hand for any branch: `gh workflow run desktop.yml --ref <branch> -f windows=true` adds the `windows-latest`
  installers.
- Release tags: `release.yml` creates the GitHub release, then calls `desktop.yml`, which builds Linux and Windows
  with the updater signatures and attaches the installers, their `.sig` files and `latest.json` to that release.

The installers are not signed by an OS code-signing certificate (Windows SmartScreen warns on the first start); the
updater signature is the only signature.

## Updates

The app checks `https://github.com/just-tavrn/tavrn-web/releases/latest/download/latest.json` at every start and
announces a newer version; Settings → App installs it (download, signature check, install, restart; on Windows the
installer runs in passive mode). The signature uses a minisign key pair of the Tauri updater:

1. The owner creates the key pair once, on a trusted machine:
   `pnpm --filter @tavrn/desktop tauri signer generate -w ~/.tauri/tavrn-updater.key` (with a password).
2. The **public** key (the content of `tavrn-updater.key.pub`) replaces the placeholder
   `REPLACE_WITH_THE_OWNERS_MINISIGN_PUBLIC_KEY` in `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`)
   and is committed. Until then the app offers no updates (Settings → App says so) and the release workflow refuses
   to build the desktop installers.
3. The **private** key (the content of `tavrn-updater.key`) and its password become the repository secrets
   `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. They are used only by tagged release builds;
   pull requests build without them. Never commit the private key; losing it means installed apps cannot update to
   releases signed with a new key (they need a manual install once).

For a local signed build use a throwaway key: `TAURI_SIGNING_PRIVATE_KEY=$(cat throwaway.key)
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=… just desktop-build --bundles appimage --config
'{"bundle":{"createUpdaterArtifacts":true},"plugins":{"updater":{"pubkey":"<throwaway public key>"}}}'`.
