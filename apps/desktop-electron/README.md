# @tavrn/desktop-electron

The tavrn desktop app for Linux: an [Electron](https://www.electronjs.org) shell around the web client. Windows and
macOS keep the Tauri shell in [`../desktop`](../desktop); a Windows build of this shell is released as the fallback for
machines where WebView2 causes trouble (`tavrn-electron_<version>_x64-setup.exe`). Why Linux has a shell of its own, and everything about both shells (security,
the node picker, signing in, updates, development and tests), is in [docs/DESKTOP.md](../../docs/DESKTOP.md), section
"The Linux shell (Electron)".

| Path | What |
|---|---|
| `src/main/` | the main process, one module per concern (`index.ts` lifecycle, `context.ts` what every part gets, `windows.ts`, `protocol.ts` the `app://tavrn` scheme, `csp.ts`, `guard.ts`, `config.ts`, `node_url.ts`, `resolve.ts`, `connect.ts` the sign-in window, `capture.ts` and `picker.ts` screen sharing, `ipc.ts`, `events.ts`, `shell.ts`, `keychain.ts`, `notify.ts`, `tray.ts` with `tray_icon.ts`, `downloads.ts`, `hotkeys.ts`, `passkeys.ts` with `passkey_dialog.ts` and `passkey_window.ts`; `updater.ts` with `minisign.ts`, the signed feed), unit tests next to them (`*.test.ts`, `node --test`) |
| `src/preload/` | the preload of the main window (`window.tavrnShell`, typed by the client's `web/src/platform/electronBridge.ts`) and the picker's |
| `src/shared/bridge.ts` | the bridge's methods and IPC channels, shared by the preload and the main process |
| `e2e/` | the Playwright specs (`launch.ts` starts the app sandboxed and drives it over CDP, under `xvfb-run`) |
| `native/keywatch/` | `@tavrn/keywatch-native`: the system-wide key listener (the crate `apps/desktop/crates/keywatch`) as a Node-API module, loaded by `src/main/hotkeys.ts` |
| `native/passkeys/` | `@tavrn/passkeys-native`: passkeys with FIDO2 security keys over USB (its crate `fido/`, Linux) as a Node-API module, loaded by `src/main/passkeys.ts` |
| `scripts/` | `pnpm dev` (`dev.mjs`), `copy-native.mjs` (the native modules into `dist/native/`), `verify-feed.mjs` (the release's check of the signed feeds) |
| `electron-builder.config.mjs` | the `.AppImage` and `.deb` packages, the Windows fallback's NSIS installer (`pnpm package:win`, on Windows) |

```sh
just electron-dev       # the app on the Vite dev server (hot reload of the client)
just electron-check     # tsc, node --test, SPDX headers and licenses
just electron-package   # release/*.AppImage, release/*.deb, release/latest-linux.yml
E2E_NODE_BIN=/path/to/tavrn-node just electron-e2e
just electron-native    # the native modules: key listener, passkeys on Linux (napi build --release, needs Rust and libudev-dev)
just electron-native-check   # their cargo fmt, clippy, tests, licenses and node tests (under xvfb-run)
E2E_NODE_BIN=/path/to/tavrn-node just electron-e2e-packaged   # the full smoke test against the AppImage
```

Licensed under the Apache License 2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)); the logo and icons are not
([TRADEMARK.md](../../TRADEMARK.md)).
