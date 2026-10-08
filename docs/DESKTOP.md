# The desktop app

The desktop app is a [Tauri 2](https://v2.tauri.app) shell around the web client: the same React client, bundled into
an installable app for Linux (`.deb`, `.AppImage`) and Windows (`.msi`, NSIS `.exe`), that updates itself with signed
releases. macOS follows later. It lives in [`apps/desktop`](../apps/desktop): the pnpm package `@tavrn/desktop` (the
Tauri CLI) and the Rust crate `tavrn-desktop` in `apps/desktop/src-tauri` with a Cargo workspace of its own.

## What the app is

- **It bundles the client.** The app ships `web/dist` (built by Vite, exactly what a node embeds) and its main window
  never loads remote pages. Only the bundled client may call the shell's native commands; a node can never reach them.
  This matters for the next steps (keys in the OS keychain). The one remote page the app shows is the node's own
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
| One capability for the main window: the app's commands, nothing else (no `remote` origins, no plugin permissions, no global Tauri object). The global-shortcut plugin is used from Rust only; its JavaScript commands are not granted. No capability names the sign-in window (a test checks every capability file). | `src-tauri/capabilities/main.json`, `build.rs`, `src-tauri/src/conf_tests.rs` |
| The sign-in window (`connect`) shows only the chosen node's `/connect?session=…` page (`open_connect` checks origin, path and parameters) and follows https pages from there (identity providers redirect), plain http only on this computer; it never loads the bundled client or `tauri:`, `file:`, `data:`, `javascript:` or `blob:` URLs, and new windows go to the system browser. The node's web client there runs as a plain web client: only the main window counts as the app (`platform/tauriDetect.ts`). | `src-tauri/src/guard.rs`, `src/lib.rs` |
| The microphone and the camera are granted to the main window without a prompt of the webview (it shows only the bundled client); screen capture and every other permission keep the webview's default. | `src-tauri/src/media.rs` |
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
| `hotkeys` | — | global hotkeys: `register(action, combo)`, `unregister(action)`, `subscribe(handler)` (shell commands `register_hotkey`, `unregister_hotkey`, `listen_hotkeys`) |
| `keystore`, `notifications`, `tray` | — | extension points of the next steps (keychain, notifications, tray) |

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
node signs out of the old one first) and the updates.

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

## Global hotkeys

Push-to-talk and the priority speaker (while held), mute and deafen (toggles) work while the app is in the background
or minimized, for example during a game. **Settings → Voice & video → Global hotkeys** has a recorder per action:
"Change", then press the combination; Escape cancels, Backspace removes the binding. The browser shows a hint instead.

- **Combinations** are modifiers and one key, written as the client captures them: `Ctrl+Alt+Shift+Super+<KeyboardEvent.code>`
  in this order, e.g. `Ctrl+Shift+KeyM`, `F13`, `Alt+Numpad1`. `Super` is the Windows key on Windows, Cmd on macOS and
  Super/Meta on Linux; the recorder shows these names. A modifier alone (only Ctrl, for example) cannot be bound.
- **A global grab takes the key from every other program.** So a key that types text (letters, digits, punctuation,
  Space, Enter, Tab, arrows, Delete) needs Ctrl, Alt or Super as well; function keys F1–F24, the numpad and Insert, Home,
  End, Page Up/Down, Pause, Scroll Lock and Print Screen may stand alone. Escape and Backspace are the recorder's keys.
- **Conflicts** are refused with a message: the same combination for two actions (the shell refuses it as well), and a
  global combination equal to the push-to-talk or priority key of the window (Settings → Voice & video, the keys that
  work while the window has focus) — in both directions, since both would fire. A combination the system refuses
  (another program holds it) is reported and the old binding stays.
- **Where they live:** with the voice settings of the client (`desktopHotkeys` in `tavrn.voice.settings`); the shell
  keeps only the registry of the running app (`src-tauri/src/hotkeys.rs`). At every start the client hands the stored
  bindings to the shell; a combination that cannot be registered then stays stored and is reported once.
- **How they reach the call:** the shell grabs the combination through
  [tauri-plugin-global-shortcut](https://v2.tauri.app/plugin/global-shortcut/) and reports presses and releases over a
  channel the client opened (`listen_hotkeys`); `web/src/voice/hotkeys.ts` drives push-to-talk (the gate opens while
  held, with the release delay of the settings), the priority speaker, mute and deafen. Push-to-talk needs the input
  mode "Push to talk". Focus changes of the window do not release a global hold. Outside a call a toggle shows what
  the next voice channel gets.
- **Platforms:** Windows (`RegisterHotKey`) and Linux on X11 (`XGrabKey`). In a Wayland session the grab works only
  through XWayland, i.e. while an X11 window (many games, Wine and Proton included) has the focus; native Wayland has no
  global shortcuts for applications yet.

## Voice on Linux

WebKitGTK runs WebRTC through GStreamer and keeps it off unless the app switches it on: the shell turns on
`enable-webrtc` and `enable-media-stream` of the webview's settings (`src-tauri/src/media.rs`). At runtime these
GStreamer plugins must be installed (the `.deb` depends on them; for the AppImage install them yourself):

```sh
sudo apt install gstreamer1.0-plugins-bad gstreamer1.0-plugins-good gstreamer1.0-gl gstreamer1.0-pipewire   # or gstreamer1.0-pulseaudio
```

**The distributions' WebKitGTK is built without WebRTC.** WebKitGTK compiles WebRTC only with its experimental
features (`ENABLE_WEB_RTC` follows `ENABLE_EXPERIMENTAL_FEATURES`, off in release builds); Ubuntu 24.04 and 26.04 ship
`libwebkit2gtk-4.1` 2.52 that way (it does not link `libgstwebrtc-1.0`). There the switch has no effect:
`getUserMedia` works, `RTCPeerConnection` does not exist, and the client refuses to join voice as in browsers without
WebRTC. Check a system with `ldd /usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0 | grep gstwebrtc`; on a system whose
WebKitGTK is built with WebRTC the switch makes it available (the smoke test asserts that there; not yet verified on
such a build). End-to-end encrypted voice also needs encoded
transforms (`RTCRtpScriptTransform`) in that build.

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
| Web push | not offered | there is no service worker in the app (its pages are not served by the node). Native notifications come with the next step. |
| Desktop notifications of the browser | as far as the webview supports them | native notifications come with the next step. |
| Voice and video | Windows (WebView2, Chromium): expected to work as in Chromium (to be confirmed by hand); Linux: not available with the distributions' WebKitGTK | end-to-end encrypted media needs WebRTC with encoded transforms. The app switches WebRTC on, but the WebKitGTK of Ubuntu 24.04 and 26.04 is built without it (no `RTCPeerConnection`, checked in the built app; "Voice on Linux"), so the client refuses to join, as in browsers that lack it. Global hotkeys work regardless. Screen and window sharing through the platform APIs is a later step. |
| Popping out the whiteboard, "open original" in the media viewer | not offered | the app opens no window for content (only the sign-in window); maximize and the download icon cover it. |
| The terms and other pages that open in a new tab | open on the node's web client in the system browser | the app opens no window for content. |
| Updates while the repository is private | do not download | the updater fetches `latest.json` and the installers from the public release URLs. |

## Development

System packages on Linux (Debian/Ubuntu names): `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
librsvg2-dev patchelf xdg-utils`, for the WebDriver test also the WebKit WebDriver (`webkit2gtk-driver`, on Ubuntu
26.04 `webkitgtk-webdriver`: it provides `/usr/bin/WebKitWebDriver`), `xvfb` and `xdotool`; for voice the GStreamer
plugins of "Voice on Linux". A Rust toolchain (stable, at least
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
  against a local server, updater key, the hotkey registry: combinations, Super/Cmd/Win, typing keys, duplicates,
  refused grabs; the media permissions; the security properties of `tauri.conf.json` and the capabilities, the `.deb`
  dependencies).
- Vitest, with the other tests of the client (`just test`): the platform detection and both implementations (Tauri
  mocked with `@tauri-apps/api/mocks`), the node picker, Settings → App, the API base plumbing, the flows the app
  does not offer; the global hotkeys (settings, conflict check, recorder, the bridge to the shell, the voice session's
  reaction to presses and releases).
- `node --test` of the update manifest script (`pnpm --filter @tavrn/desktop test`).
- Playwright (`e2e/tests/desktop.spec.ts`, simulated shell): the node picker with address first and the advanced URL,
  Settings → App, the sign-in on the node's page with the page in a second browser context; `desktop-connect.spec.ts`:
  the node's `/connect` page in session mode with password and TOTP, registration with a passkey, a passkey-only
  sign-in and single sign-on.
- WebDriver smoke test of the built Linux app (`apps/desktop/e2e/smoke.mjs`, plain WebDriver over HTTP): the app
  starts, shows the node picker, the shell's resolver reports a domain without a node, the advanced URL refuses
  `http://evil`, the address of an account (registered over the API with TOTP) on a development node finds the node
  and its login page; the account signs in on the node's page in the sign-in window (password and code there, a
  native command from that page is refused), the main window takes over the session, sets up its recovery key (the
  encryption core runs in the webview) and sends a message in an end-to-end encrypted channel, which the node stores
  as ciphertext only; `getUserMedia` is present (and `RTCPeerConnection` whenever the system's WebKitGTK has WebRTC);
  the recorder binds Ctrl+Alt+M to mute, the window is minimized and `xdotool` presses the combination through the X
  server: the shell's global grab reports it and mute toggles. The node needs the web client bundle (a node built with
  `web/dist`). It needs `tauri-driver` (`cargo install tauri-driver --locked`) and a built app:

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
