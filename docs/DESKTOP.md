# The desktop app

The desktop app is a [Tauri 2](https://v2.tauri.app) shell around the web client: the same React client, bundled into
an installable app for Linux (`.deb`, `.AppImage`) and Windows (`.msi`, NSIS `.exe`), that updates itself with signed
releases. macOS follows later. It lives in [`apps/desktop`](../apps/desktop): the pnpm package `@tavrn/desktop` (the
Tauri CLI) and the Rust crate `tavrn-desktop` in `apps/desktop/src-tauri` with a Cargo workspace of its own.

## What the app is

- **It bundles the client.** The app ships `web/dist` (built by Vite, exactly what a node embeds) and never loads
  remote pages. Only the bundled client may call the shell's native commands; a node can never reach them. This
  matters for the next steps (keys in the OS keychain).
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
| One capability for the main window: the app's six commands, nothing else (no `remote` origins, no plugin permissions, no global Tauri object). | `src-tauri/capabilities/main.json`, `build.rs` |
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
| `node` | — | the chosen node, `set(url)` validates and persists it (shell command `set_node`) |
| `updater` | — | signed updates (absent while the build has no updater key) |
| `hotkeys`, `keystore`, `notifications`, `tray` | — | extension points of the next steps (global hotkeys; keychain, notifications, tray) |

The helpers `apiBase()`, `originUrl()`, `originWsUrl()`, `webOrigin()`, `originHost()` and `allowsInsecureNodes()`
of `platform/index.ts` are the single place the API client (`lib/api.ts`), the WebSocket, node discovery
(`stores/nodes.ts`) and the link builders take the node from.

## The node picker

On the first start every path shows the node picker (`/node`): the address of the home node as you open it in the
browser (`https://tavrn.example`; without a scheme https is assumed). Rules:

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

## Limitations

What the browser gets from "the client is served by the node" and what the app does instead:

| Flow | In the app | Why |
|---|---|---|
| Password with the second factor (TOTP, recovery code) | works | ordinary API calls with bearer tokens (the node allows every origin, without cookies) |
| Registration, account settings, encryption, rooms, DMs, federation | work | same |
| Sign-in with an account of another node | password with TOTP or a recovery code works; the connect flow is not offered | the connect flow returns the one-time code to the visiting web client's origin, and the node accepts only `https://<domain>` origins (FEDERATION.md §8): the app's origin is `tauri://localhost`. Choosing the home node in the node picker is the way in the app. |
| Passkeys (WebAuthn) as second factor or sign-in | not offered | passkeys are bound to the node's domain; the app's origin is not the node's (and WebKitGTK has no WebAuthn). TOTP or a recovery code is required in the app. |
| Single sign-on (OpenID Connect) | not offered; an SSO-only node shows a notice | the node sends the browser back to its own web client (`<web>/sso/callback`); the app cannot receive that callback without a node-side loopback or app-scheme redirect (RFC 8252). A later step can add it with the node. |
| Captcha on login or registration | not shown (notice instead) | the widget is a third-party script (CSP `script-src 'self'`) bound to the node's host name. Use the browser for that step, or the operator turns the captcha off for logins. |
| Web push | not offered | there is no service worker in the app (its pages are not served by the node). Native notifications come with the next step. |
| Desktop notifications of the browser | as far as the webview supports them | native notifications come with the next step. |
| Voice and video | Windows (WebView2, Chromium): expected to work as in Chromium (to be confirmed by hand); Linux: not available with the distributions' WebKitGTK | end-to-end encrypted media needs WebRTC with encoded transforms. The WebKitGTK of Ubuntu 26.04 ships without WebRTC (no `RTCPeerConnection`, checked in the built app), so the client refuses to join, as in browsers that lack it. Screen and window sharing through the platform APIs is a later step. |
| Popping out the whiteboard, "open original" in the media viewer | not offered | the app opens no second window; maximize and the download icon cover it. |
| The terms and other pages that open in a new tab | open on the node's web client in the system browser | the app opens no second window. |
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

- Rust: `cargo test` in `apps/desktop/src-tauri` (node URL validation, settings file, navigation guard, updater key,
  the security properties of `tauri.conf.json` and the capability).
- Vitest, with the other tests of the client (`just test`): the platform detection and both implementations (Tauri
  mocked with `@tauri-apps/api/mocks`), the node picker, Settings → App, the API base plumbing, the flows the app
  does not offer.
- `node --test` of the update manifest script (`pnpm --filter @tavrn/desktop test`).
- WebDriver smoke test of the built Linux app (`apps/desktop/e2e/smoke.mjs`, plain WebDriver over HTTP): the app
  starts, shows the node picker, refuses `http://evil`, accepts a development node and reaches the login page; an
  account with TOTP (registered over the API) signs in with password and code, sets up its recovery key (the
  encryption core runs in the webview) and sends a message in an end-to-end encrypted channel, which the node stores
  as ciphertext only. It needs `tauri-driver` (`cargo install tauri-driver --locked`) and a built app:

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
