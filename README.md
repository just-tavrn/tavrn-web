# tavrn-web

The web client of [tavrn](https://github.com/just-tavrn/tavrn), a federated, self-hostable community chat with
end-to-end encrypted conversations: rooms with text, voice, announcement, files and forum channels, roles and
permissions, direct messages and friends across nodes, voice, video, screen sharing and a whiteboard. It is a React
single-page app that works on phones, tablets and desktops, in English and German (more languages welcome).

> **Status: in private review.** The repositories go public after the review; until then the `@tavrn` packages are
> git dependencies by tag (see [Development](#development)).

| Related repository | What it is |
|---|---|
| [tavrn](https://github.com/just-tavrn/tavrn) | project overview, architecture, roadmap, Discussions |
| [tavrn-node](https://github.com/just-tavrn/tavrn-node) | the server; its container image embeds this client |
| [tavrn-js](https://github.com/just-tavrn/tavrn-js) | `@tavrn/sdk` (API client), `@tavrn/e2ee` (encryption client), `@tavrn/bot`: the client is built on them |
| [tavrn-crypto](https://github.com/just-tavrn/tavrn-crypto) | the encryption core (OpenMLS), compiled to WebAssembly as `@tavrn/crypto` |
| [tavrn-protocol](https://github.com/just-tavrn/tavrn-protocol) | the protocol the client speaks |

## Layout

| Directory | What it is |
|---|---|
| [`web/`](web) | `@tavrn/web`: the client (`src/`), its static assets and generated icons (`public/`), translations (`src/i18n/`), Vitest tests next to the code |
| [`e2e/`](e2e) | `@tavrn/e2e`: the Playwright suite (`tests/`), its fixtures (a fake OpenID provider, the example bot) and `playwright.config.ts` |
| [`docs/`](docs) | [CLIENT.md](docs/CLIENT.md) (what the client does), [ACCESSIBILITY.md](docs/ACCESSIBILITY.md), [GITHUB.md](docs/GITHUB.md) (repository setup) |
| `scripts/` | license and hygiene checks |

A pnpm workspace at the root ties `web` and `e2e` together. In phase 6 the Tauri shells for desktop and mobile
(`apps/desktop`) join it: the installable apps will be built from this repository around the same client.

## How the client reaches a node

**In production the node serves the client.** tavrn-node embeds the bundle from `web/dist` at compile time and
serves it on its own domain, next to the API (`/api/v1`), the WebSocket and `/.well-known/tavrn`. The client talks to
the origin it was loaded from: there is no build-time configuration and there are no `VITE_*` variables; everything a
node offers (registration mode, captcha, voice, single sign-on, limits) comes from the node at runtime.

**Other nodes** are reached from that client: rooms on other nodes open a federated session with a token of the home
node, and the login page offers "Sign in with an account of another node". When a sign-in needs the home node itself
(passkeys, captchas, single sign-on), the client uses the connect flow: the home node's web client confirms the
sign-in at `/connect`, and a one-time code bound to the visiting origin and a PKCE challenge come back to
`<origin>/connect/callback` ([FEDERATION.md](https://github.com/just-tavrn/tavrn-protocol/blob/main/FEDERATION.md)
§8, §13).

**The bundle contract.** `pnpm install --frozen-lockfile && pnpm --filter @tavrn/web build` writes the complete,
self-contained client to `web/dist/` (`index.html`, hashed assets, the MediaPipe runtime under `mediapipe/`, the
whiteboard's fonts; no CDN is ever used). tavrn-node's image build runs exactly this at a ref of this repository
(`TAVRN_WEB_REF`), or embeds a prebuilt `web/dist`. Every release also attaches the bundle as
`tavrn-web-X.Y.Z.tar.gz` (with a SHA-256 sum) to its GitHub release, so a node build can pin it without building
JavaScript; `just dist-tarball` produces the same file locally.

## Development

Requirements: Node.js 24, pnpm (the version in `package.json`, for example through `corepack enable`),
[`just`](https://github.com/casey/just), and a tavrn node to talk to (below). During the private phase git needs read
access to `just-tavrn` (your GitHub credentials, for example through `gh auth setup-git`): `@tavrn/sdk`, `@tavrn/e2ee`
and `@tavrn/crypto` (with its built WebAssembly module) come from their repositories by tag, wired up in
`pnpm-workspace.yaml` (`overrides`, `blockExoticSubdeps: false`; see the tavrn-js README). No Rust toolchain is needed.

```sh
git clone https://github.com/just-tavrn/tavrn-web
cd tavrn-web
pnpm install
just check       # everything the CI runs: licenses, typecheck, Vitest
```

**A node for development.** The dev server forwards `/api`, `/.well-known`, `/healthz` and `/readyz` to a node in
development mode on `127.0.0.1:8080` (SQLite, plain HTTP, no TLS), so the client runs "on the same node" as in
production. Run one from a [tavrn-node](https://github.com/just-tavrn/tavrn-node) checkout (`just dev-server`), from a
binary, or from the image:

```sh
TAVRN_WEBAUTHN_ORIGIN=http://localhost:5173 tavrn-node --dev                        # binary; passkeys on the Vite origin
docker run --rm --network host -e TAVRN_WEBAUTHN_ORIGIN=http://localhost:5173 \
  ghcr.io/just-tavrn/tavrn-node:edge --dev                                          # or the image (Linux host network)
just dev         # the client on http://localhost:5173
```

`E2E_NODE_PORT` and `E2E_WEB_PORT` move the node and the dev server to other ports. Voice needs `livekit-server` next
to the node (the image has it; `just livekit-install` puts the tested release into `~/.local/bin`), or start the node
with `TAVRN_VOICE_ENABLED=false`.

| Recipe | What it does |
|---|---|
| `just check` | `license-check`, `typecheck`, `test` |
| `just license-check` | SPDX headers (`scripts/check-spdx.sh`) and the licenses of all production dependencies (`scripts/check-js-licenses.mjs`; no (A)GPL/LGPL) |
| `just typecheck`, `just test` | `tsc` of the client and the e2e suite; Vitest (unit, component and static accessibility tests of the client) |
| `just dev` | the Vite dev server |
| `just build` | the production bundle `web/dist` |
| `just dist-tarball` | `release/tavrn-web-<version>.tar.gz` from `web/dist`, as the release attaches it |
| `just e2e [args]` | the Playwright suite against real nodes (below) |
| `just publish-check` | pre-publication hygiene (`scripts/publish-check.sh`: no private files, domains or secrets) |

### Translations

The client ships English (default) and German. To add a language, copy `web/src/i18n/en.json` to
`web/src/i18n/<code>.json`, translate the values and register the file in `web/src/i18n/index.ts`. A unit test checks
that every language has exactly the keys of English.

## End-to-end tests

The Playwright suite in `e2e/` clicks through every user flow in real browsers against real nodes: it starts five
nodes in development mode (the main one, two federated ones `a.test` and `b.test`, one for single sign-on with a fake
OpenID provider, one for legal pages), a Vite dev server per node, and, for the bot specs, the example bot of
`@tavrn/bot`. The suite does not build the node; give it one:

- `E2E_NODE_BIN=/path/to/tavrn-node`: a `tavrn-node` binary (`cargo build` in a tavrn-node checkout, or copied out of
  the image: `docker cp "$(docker create ghcr.io/just-tavrn/tavrn-node:edge)":/usr/local/bin/tavrn-node .`). The
  node finds `livekit-server` (voice) and `ffmpeg` (avatars and other media) on the `PATH` or through
  `TAVRN_LIVEKIT_BINARY` and `TAVRN_MEDIA_FFMPEG`, exactly as in production.
- `E2E_NODE_IMAGE=ghcr.io/just-tavrn/tavrn-node:edge`: the image instead; every node runs in its own container with
  host networking (Linux), the same environment and ports, and this repository's `data-dev/` mounted at the same
  path. The image brings LiveKit and ffmpeg. When both variables are set, the binary wins.

```sh
just e2e-install                                       # Chromium for Playwright, once
E2E_NODE_BIN=~/src/tavrn-node/target/debug/tavrn-node just e2e
E2E_NODE_BIN=… just e2e tests/chat.spec.ts --project chromium   # one spec, one project
```

`just e2e` runs the `chromium` and `mobile-android` projects with two workers; the CI adds `tablet-chromium`
([docs/GITHUB.md](docs/GITHUB.md)). The two-node and single sign-on specs need Chromium (host mapping of `a.test` and
`b.test` to 127.0.0.1). The nodes keep their SQLite databases and keys in `data-dev/` (`just e2e-clean` starts over).
Ports follow `E2E_NODE_PORT` (default 8080) and `E2E_WEB_PORT` (default 5173): the other nodes use the next ports
(+1, +2, +4 to +6) and LiveKit, ICE over TCP and TURN ports derived from them, so several checkouts can run at once
with different base ports. `E2E_VOICE=false` skips voice where no `livekit-server` is available.

## Accessibility

The client aims at WCAG 2.2 level AA. axe-core scans of every main screen on phone, tablet and desktop, keyboard
tests and static checks run with the suites; the audit, the manual screen reader walkthrough, the known gaps and a
template for the accessibility statement operators may need are in [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md).

## Licensing

[Apache-2.0](LICENSE): the client may be embedded, rebuilt and shipped in app stores. The encryption packages it builds
on, [`@tavrn/e2ee`](https://github.com/just-tavrn/tavrn-js) and [`@tavrn/crypto`](https://github.com/just-tavrn/tavrn-crypto),
are MPL-2.0 dependencies: their files keep their license, this repository stays Apache-2.0. Details in
[LICENSE.md](LICENSE.md); the name "tavrn", the logo and the icons are not covered by the licenses
([TRADEMARK.md](TRADEMARK.md)).

## Security

The encryption code has **not been audited yet**; treat it as pre-release cryptography. Please report vulnerabilities
privately through GitHub's private vulnerability reporting ("Report a vulnerability" on the Security tab), not as
public issues; see the [security policy](https://github.com/just-tavrn/.github/blob/main/SECURITY.md).

## Contributing

Contributions are welcome: see the [contributing guide](https://github.com/just-tavrn/.github/blob/main/CONTRIBUTING.md)
and the [code of conduct](https://github.com/just-tavrn/.github/blob/main/CODE_OF_CONDUCT.md). New user flows come with
Playwright specs and must work on phones, tablets and desktops. Changes to routes, events or wire formats start in
[tavrn-protocol](https://github.com/just-tavrn/tavrn-protocol). Contributions are accepted under the
[contributor license agreement](CLA.md), signed once through the CLA bot on your first pull request. Run `just check`
before opening a pull request.
