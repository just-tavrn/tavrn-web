# tavrn-web: developer tasks. `just --list` shows all of them.

set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# (`tavrn-node --dev`; another port through E2E_NODE_PORT)
# The web client's Vite dev server on http://localhost:5173, forwarding the API to a node on 127.0.0.1:8080
dev: install
    pnpm --filter @tavrn/web dev

# Every check of the CI: licenses (SPDX headers, dependency licenses), typecheck, Vitest
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

# Extra arguments go to `playwright test` (default: chromium and the phone emulation, two workers).
# Playwright against real nodes: set E2E_NODE_BIN (a tavrn-node binary) or E2E_NODE_IMAGE (its container image)
e2e *args: install
    @[ -n "${E2E_NODE_BIN:-}${E2E_NODE_IMAGE:-}" ] || { echo "set E2E_NODE_BIN to a tavrn-node binary or E2E_NODE_IMAGE to its container image (README.md)" >&2; exit 1; }
    cd e2e && pnpm exec playwright test {{ if args == "" { "--project chromium --project mobile-android --workers=2" } else { args } }}

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
