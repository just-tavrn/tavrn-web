# tavrn-web: developer tasks. `just --list` shows all of them.

set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# (`tavrn-node --dev`; another port through E2E_NODE_PORT)
# The web client's Vite dev server on http://localhost:5173, forwarding the API to a node on 127.0.0.1:8080
dev: install
    pnpm --filter @tavrn/web dev

# Every check of the JavaScript CI: licenses (SPDX headers, dependency licenses), typecheck, Vitest (the desktop shell: desktop-check)
check: license-check typecheck test

# scripts/check-spdx.sh (map in sync with LICENSE.md), scripts/check-js-licenses.mjs (no (A)GPL/LGPL)
# SPDX headers and the licenses of the production dependencies
license-check: install
    scripts/check-spdx.sh
    node scripts/check-js-licenses.mjs

# tsc: the web client and the end-to-end suite
typecheck: install
    pnpm -r --if-present typecheck

# Vitest: the web client's unit, component and static accessibility tests
test: install
    pnpm -r --if-present test

# Production bundle: web/dist (what tavrn-node embeds; README.md "The bundle")
build: install
    pnpm --filter @tavrn/web build

# The release tarball of web/dist: release/tavrn-web-<version>.tar.gz plus its SHA-256 sum
dist-tarball: build
    #!/usr/bin/env bash
    set -euo pipefail
    v="$(node -p "require('./web/package.json').version")"
    mkdir -p release
    tar -C web/dist -czf "release/tavrn-web-$v.tar.gz" .
    (cd release && sha256sum "tavrn-web-$v.tar.gz" > "tavrn-web-$v.tar.gz.sha256")
    ls -l release

# The desktop app (docs/DESKTOP.md): Tauri dev mode, the client from the Vite dev server (needs the Linux packages)
desktop-dev: install
    pnpm --filter @tavrn/desktop tauri dev

# Linux ships the Electron shell (just electron-package); there this builds the Tauri binary only (for desktop-voice-e2e)
# The Tauri app from web/dist: Windows installers (.msi and NSIS), elsewhere the binary only; extra args go to `tauri build`
desktop-build *args: install
    pnpm --filter @tavrn/desktop tauri build {{ if args == "" { if os() == "windows" { "--bundles msi,nsis" } else { "--no-bundle" } } else { args } }}

# cargo fmt, clippy, tests and dependency licenses of the desktop shell and its key listener crate (needs web/dist: `just build` first)
desktop-check: install
    @[ -f web/dist/index.html ] || { echo "web/dist is missing: run just build first (the shell embeds it)" >&2; exit 1; }
    cd apps/desktop/crates/keywatch && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
    cd apps/desktop/src-tauri && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked && cargo deny check licenses

# Two native engines, end-to-end encrypted, against a local livekit-server (needs livekit-server on the PATH)
# The native voice engine against LiveKit (docs/DESKTOP.md "Voice")
desktop-voice-test:
    cd apps/desktop/src-tauri && cargo test --locked --test voice_livekit -- --ignored

# The app from TAVRN_DESKTOP_APP or the release build; E2E_NODE_BIN like `just e2e` (a release node: the sign-in window shows its pages)
# Voice between Chromium and the built Linux app's native engine (desktop-voice.spec.ts), always under xvfb-run with X11 forced
desktop-voice-e2e: install
    #!/usr/bin/env bash
    set -euo pipefail
    [ -n "${E2E_NODE_BIN:-}" ] || { echo "set E2E_NODE_BIN to a release tavrn-node binary" >&2; exit 1; }
    app="$(realpath "${TAVRN_DESKTOP_APP:-${CARGO_TARGET_DIR:-apps/desktop/src-tauri/target}/release/tavrn}")"
    [ -x "$app" ] || { echo "no built app at $app (pnpm --filter @tavrn/desktop tauri build --no-bundle, or set TAVRN_DESKTOP_APP)" >&2; exit 1; }
    cd e2e && env -u WAYLAND_DISPLAY GDK_BACKEND=x11 E2E_DESKTOP_APP="$app" xvfb-run -a pnpm exec playwright test tests/desktop-voice.spec.ts --project chromium --workers=1

# The client from the Vite dev server (E2E_WEB_PORT, default 5173) and the app on it; opens a window on your desktop
# The Linux desktop app in development (Electron shell, docs/DESKTOP.md "The Linux shell (Electron)")
electron-dev: install
    env -u ELECTRON_RUN_AS_NODE pnpm --filter @tavrn/desktop-electron dev

# tsc of the main process, the preload and the harness, node --test of the main-process modules, SPDX headers and licenses
# Checks of the Electron shell (they are also part of `just check`: typecheck and test of every package)
electron-check: install
    pnpm --filter @tavrn/desktop-electron typecheck
    pnpm --filter @tavrn/desktop-electron test
    scripts/check-spdx.sh
    node scripts/check-js-licenses.mjs

# The Electron shell's system-wide key listener: the Node-API module around apps/desktop/crates/keywatch (needs Rust)
electron-native: install
    pnpm --filter @tavrn/keywatch-native build

# The key listener module: cargo fmt, clippy and licenses (and the crate's tests), its node test (key presses under xvfb-run)
electron-native-check: electron-native
    cd apps/desktop/crates/keywatch && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
    cd apps/desktop-electron/native/keywatch && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo deny check licenses
    cd apps/desktop-electron/native/keywatch && env -u WAYLAND_DISPLAY xvfb-run -a pnpm test

# The Linux packages of the Electron shell (.AppImage and .deb in apps/desktop-electron/release/) from web/dist
electron-package: build electron-native
    pnpm --filter @tavrn/desktop-electron package

# The node must listen on E2E_NODE_PORT (default 8300); the app always renders under xvfb-run with X11 forced
# Playwright smoke test of the Electron shell (E2E_NODE_BIN like `just e2e`, or E2E_NODE_URL), never on the desktop
electron-e2e: build electron-native
    @[ -n "${E2E_NODE_BIN:-}${E2E_NODE_URL:-}" ] || { echo "set E2E_NODE_BIN to a tavrn-node binary (or E2E_NODE_URL to a running development node)" >&2; exit 1; }
    pnpm --filter @tavrn/desktop-electron build
    cd apps/desktop-electron && env -u WAYLAND_DISPLAY -u ELECTRON_RUN_AS_NODE xvfb-run -a -s "-screen 0 1280x800x24" pnpm exec playwright test --config e2e/playwright.config.ts

# E2E_NODE_BIN like `just electron-e2e`; the specs that need the main process run on the development build (docs/DESKTOP.md)
# The Playwright specs with the full smoke test against a package, as CI runs them: E2E_ELECTRON_APP or the AppImage of `just electron-package`
electron-e2e-packaged: electron-native
    #!/usr/bin/env bash
    set -euo pipefail
    [ -n "${E2E_NODE_BIN:-}${E2E_NODE_URL:-}" ] || { echo "set E2E_NODE_BIN to a tavrn-node binary (or E2E_NODE_URL to a running development node)" >&2; exit 1; }
    app="${E2E_ELECTRON_APP:-$(ls "$PWD"/apps/desktop-electron/release/*.AppImage 2>/dev/null | head -n1)}"
    [ -n "$app" ] && [ -e "$app" ] || { echo "no package: run just electron-package (or set E2E_ELECTRON_APP)" >&2; exit 1; }
    pnpm --filter @tavrn/desktop-electron build
    cd apps/desktop-electron && E2E_ELECTRON_APP="$(realpath "$app")" env -u WAYLAND_DISPLAY -u ELECTRON_RUN_AS_NODE xvfb-run -a -s "-screen 0 1280x800x24" pnpm exec playwright test --config e2e/playwright.config.ts

# Extra arguments go to `playwright test` (default: chromium and the phone emulation, two workers).
# Playwright against real nodes: set E2E_NODE_BIN (a tavrn-node binary) or E2E_NODE_IMAGE (its container image)
# (each argument is passed on as it is, so a grep pattern like -g "a|b" stays one argument)
[positional-arguments]
e2e *args: install
    @[ -n "${E2E_NODE_BIN:-}${E2E_NODE_IMAGE:-}" ] || { echo "set E2E_NODE_BIN to a tavrn-node binary or E2E_NODE_IMAGE to its container image (README.md)" >&2; exit 1; }
    cd e2e && if [ "$#" -eq 0 ]; then set -- --project chromium --project mobile-android --workers=2; fi && pnpm exec playwright test "$@"

# Install the Playwright browser (Chromium) and its system dependencies
e2e-install: install
    cd e2e && pnpm exec playwright install --with-deps chromium

# LiveKit version the node is tested with (the node image pins the same one)
livekit_version := "1.13.7"

# Install livekit-server into ~/.local/bin for the voice tests with a node binary (an image brings its own)
livekit-install:
    #!/usr/bin/env bash
    set -euo pipefail
    case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; armv7l) arch=armv7 ;; *) echo "unsupported architecture $(uname -m)"; exit 1 ;; esac
    dir="${LIVEKIT_INSTALL_DIR:-$HOME/.local/bin}"
    mkdir -p "$dir"
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    curl -fsSL "https://github.com/livekit/livekit/releases/download/v{{livekit_version}}/livekit_{{livekit_version}}_linux_${arch}.tar.gz" | tar -xz -C "$tmp" livekit-server
    install -m 0755 "$tmp/livekit-server" "$dir/livekit-server"
    "$dir/livekit-server" --version
    case ":$PATH:" in *":$dir:"*) ;; *) echo "Add $dir to PATH (or set TAVRN_LIVEKIT_BINARY=$dir/livekit-server)" ;; esac

# Remove the end-to-end nodes' databases and data (data-dev/); the next run starts from scratch
e2e-clean:
    rm -rf data-dev

# Pre-publication hygiene: no private files, domains or secrets (needs .publish-check.private or PUBLISH_CHECK_PRIVATE)
publish-check:
    scripts/publish-check.sh

[private]
install:
    @[ -d node_modules/.pnpm ] || pnpm install --frozen-lockfile
