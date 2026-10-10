# @tavrn/desktop-electron

The tavrn desktop app for Linux: an [Electron](https://www.electronjs.org) shell around the web client. Windows and
macOS keep the Tauri shell in [`../desktop`](../desktop). Everything about both shells (security, the node picker,
signing in, updates, development and tests) is in [docs/DESKTOP.md](../../docs/DESKTOP.md), section "The Linux shell
(Electron)".

| Path | What |
|---|---|
| `src/main/` | the main process, one module per concern (`index.ts` lifecycle, `windows.ts`, `protocol.ts` the `app://tavrn` scheme, `csp.ts`, `guard.ts`, `config.ts`, `node_url.ts`, `ipc.ts`, `events.ts`, `shell.ts`, `keychain.ts`, `notify.ts`, `tray.ts` with `tray_icon.ts`, `downloads.ts`), unit tests next to them (`*.test.ts`, `node --test`) |
| `src/preload/` | the preload: `window.tavrnShell`, typed by the client's `web/src/platform/electronBridge.ts` |
| `src/shared/bridge.ts` | the bridge's methods and IPC channels, shared by the preload and the main process |
| `e2e/` | the Playwright smoke test (Playwright's Electron driver, under `xvfb-run`) |
| `scripts/` | `pnpm dev` |
| `electron-builder.config.mjs` | the `.AppImage` and `.deb` packages |

```sh
just electron-dev       # the app on the Vite dev server (hot reload of the client)
just electron-check     # tsc, node --test, SPDX headers and licenses
E2E_NODE_BIN=/path/to/tavrn-node just electron-e2e
just electron-package   # release/*.AppImage and release/*.deb
```

Licensed under the Apache License 2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)); the logo and icons are not
([TRADEMARK.md](../../TRADEMARK.md)).
