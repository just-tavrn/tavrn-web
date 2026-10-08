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
| The node URL is validated twice: in the client and again in the shell before it is stored. | `web/src/platform/nodeUrl.ts`, `src-tauri/src/node_url.rs` |

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
| `hotkeys` | — | extension point of the next step (global hotkeys) |
| `keystore` | — | the OS keychain for the key of the local key store (commands `keychain_get`, `keychain_set`, `keychain_delete`, `keychain_status`) |
| `notifications` | — | native notifications and their clicks (`notify`, `shell_events`) |
| `tray` | — | the tray icon with the voice state, close to tray, quit (`tray_set`, `tray_status`, `set_close_to_tray`, `quit_app`) |

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

## Tray and close to tray

The tray icon is the logo with a badge for the voice state; the badges are drawn at start from the bundled logo
(`icons/32x32.png`), each with a dark outline, so they stand out on light and dark panels and against the teal logo:

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

The app icons are generated from the project logo: `pnpm --filter @tavrn/desktop tauri icon ../../web/public/icon-512.png`
writes `src-tauri/icons/` (32, 64, 128 and 256 pixel PNGs and `icon.png` for Linux and the window, `icon.ico` for the
Windows installer, taskbar and window, `icon.icns` for macOS later); delete the generated `android/`, `ios/` and
Windows Store images, the app does not use them. A unit test checks that every icon of `tauri.conf.json` exists. The
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
2. The app creates an app session with a PKCE challenge (`POST /auth/connect/session`) and the shell opens
   `<web>/connect?session=…` in the sign-in window, which has no native API at all.
3. The user signs in there with any method (password and second factor, passkey, SSO, registration with captcha) and
   confirms "Sign in to the Tavrn app?" with the app's device name; the page says "return to the app". The page never
   creates device keys and skips the encryption step.
4. The app polls the session every 2 seconds, gets the one-time code once, exchanges it with its verifier
   (`POST /auth/connect/token`) for a session of its own device, closes the window and continues like after any
   sign-in: device keys are created in the app, the recovery key unlocks the encrypted messages (or sets them up for
   a new account).

While it waits the app offers "Open the page again", **"Open in the browser instead"** (the same page in the system
browser; the app keeps polling) and "Cancel". On Linux the sign-in window cannot use passkeys (WebKitGTK has no
WebAuthn) and the app says so: passkeys work through the browser there; on Windows (WebView2) they work in the window.
Nodes without `connect.app` keep password and TOTP in the app; their passkeys, SSO and captcha need a browser. The page
in the sign-in window keeps its own sign-in on the node's origin (like a browser tab), so the next handoff only asks for
the confirmation.

## Limitations

What the browser gets from "the client is served by the node" and what the app does instead:

| Flow | In the app | Why |
|---|---|---|
| Password with the second factor (TOTP, recovery code) | works | ordinary API calls with bearer tokens (the node allows every origin, without cookies) |
| Registration, account settings, encryption, rooms, DMs, federation | work | same |
| Sign-in with an account of another node | the app signs in at the account's own node instead: the address (`alice@home.example`) switches the app to that node; "Sign in with an account of another node" keeps password with TOTP or a recovery code | the origin connect flow returns the code to an `https://<domain>` origin, which the app does not have; the sign-in window is bound to the app's own node. |
| Passkeys (WebAuthn) as second factor or sign-in | on the node's page in the sign-in window ("Signing in"); on Linux through the system browser | passkeys are bound to the node's domain; the app's origin is not the node's (and WebKitGTK has no WebAuthn). Without `connect.app` on the node: not offered, TOTP or a recovery code is required. |
| Single sign-on (OpenID Connect) | on the node's page in the sign-in window | the node sends the browser back to its own web client (`<web>/sso/callback`), which is the page in the sign-in window. Without `connect.app`: not offered, an SSO-only node shows a notice. A later step may add an app-scheme callback (RFC 8252) as an accelerator. |
| Captcha on login or registration | on the node's page in the sign-in window | the widget is a third-party script (CSP `script-src 'self'`) bound to the node's host name; the node's page loads it. Without `connect.app`: a notice, use the browser for that step. |
| Web push | not offered | there is no service worker in the app (its pages are not served by the node). The app shows native notifications instead while it runs (also from the tray); nothing reaches a device where the app is not running. |
| Desktop notifications of the browser | replaced | native notifications ("Notifications" above). |
| Voice and video | Windows (WebView2, Chromium): expected to work as in Chromium (to be confirmed by hand); Linux: not available with the distributions' WebKitGTK | end-to-end encrypted media needs WebRTC with encoded transforms. The WebKitGTK of Ubuntu 26.04 ships without WebRTC (no `RTCPeerConnection`, checked in the built app), so the client refuses to join, as in browsers that lack it. Screen and window sharing through the platform APIs is a later step. |
| Popping out the whiteboard, "open original" in the media viewer | not offered | the app opens no window for content (only the sign-in window); maximize and the download icon cover it. |
| The terms and other pages that open in a new tab | open on the node's web client in the system browser | the app opens no window for content. |
| Updates while the repository is private | do not download | the updater fetches `latest.json` and the installers from the public release URLs. |

## Development

System packages on Linux (Debian/Ubuntu names): `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
librsvg2-dev patchelf xdg-utils`, for the WebDriver test also the WebKit WebDriver (`webkit2gtk-driver`, on Ubuntu
26.04 `webkitgtk-webdriver`: it provides `/usr/bin/WebKitWebDriver`) and `xvfb`. A Rust toolchain (stable, at least
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
  against a local server, updater key, the security properties of `tauri.conf.json` and the capabilities, the keychain
  with the in-memory mock store of keyring-core and its entry names, notification validation, the tray's states, icons
  and labels, the installer licence and the icons of the bundle). `cargo test -- --ignored os_keychain` writes, reads
  and deletes an entry in the real keychain of the machine; desktop.yml runs it with gnome-keyring in a D-Bus session.
- Vitest, with the other tests of the client (`just test`): the platform detection and both implementations (Tauri
  mocked with `@tauri-apps/api/mocks`), the node picker, Settings → App, the API base plumbing, the flows the app
  does not offer, the key store with the keychain (migration, fallback, lock on close, sign-out), the routing of
  notifications, the notification settings of the app, the tray wiring.
- `node --test` of the update manifest script and of the installer licence (`pnpm --filter @tavrn/desktop test`).
- Playwright (`e2e/tests/desktop.spec.ts`, simulated shell): the node picker with address first and the advanced URL,
  Settings → App, the sign-in on the node's page with the page in a second browser context; `desktop-connect.spec.ts`:
  the node's `/connect` page in session mode with password and TOTP, registration with a passkey, a passkey-only
  sign-in and single sign-on; `desktop-shell.spec.ts`: the keychain fallback and migration, native notifications and
  their click, close to tray and quit, and the tray following a real voice connection.
- WebDriver smoke test of the built Linux app (`apps/desktop/e2e/smoke.mjs`, plain WebDriver over HTTP): the app
  starts, shows the node picker, the shell's resolver reports a domain without a node, the advanced URL refuses
  `http://evil`, the address of an account (registered over the API with TOTP) on a development node finds the node
  and its login page; the account signs in on the node's page in the sign-in window (password and code there, a
  native command from that page is refused), the main window takes over the session, sets up its recovery key (the
  encryption core runs in the webview) and sends a message in an end-to-end encrypted channel, which the node stores
  as ciphertext only. The node needs the web client bundle (a node built with `web/dist`). That first start runs
  without a keychain (`TAVRN_DESKTOP_KEYCHAIN=unavailable`): the key stays in IndexedDB and Settings → App warns; the
  test checks the tray state the client reported (`tray_status`), gives the shell a state, and shows a notification.
  The app then starts again with the keyring crates' in-memory mock store (`TAVRN_DESKTOP_KEYCHAIN=memory`, because
  xvfb has no Secret Service): the key moves into the keychain, the IndexedDB copy is gone, and a reload unlocks from
  the keychain alone. Both values of `TAVRN_DESKTOP_KEYCHAIN` only ever store less (in memory, or nothing). It needs
  `tauri-driver` (`cargo install tauri-driver --locked`) and a built app:

  ```sh
  just desktop-build
  E2E_NODE_BIN=/path/to/tavrn-node E2E_NODE_PORT=8300 just desktop-e2e    # xvfb-run without a display
  ```

## Builds and releases

`.github/workflows/desktop.yml` ([GITHUB.md](GITHUB.md)):

- pull requests that touch `apps/desktop`, `web`, the lockfile or the workspace: the Linux build on `ubuntu-latest`
  with the checks, the WebDriver smoke test under xvfb (against the node image) and the `.deb` and `.AppImage` as
  artifacts for 7 days;
- by hand for any branch: `gh workflow run desktop.yml --ref <branch> -f windows=true` adds the Windows installers;
- release tags: `release.yml` creates the GitHub release, then calls `desktop.yml`, which builds Linux and Windows
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
