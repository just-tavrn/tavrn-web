# Licensing of tavrn-web

Everything in this repository is licensed under the [Apache License 2.0](LICENSE) (with its patent grant): the web
client, the end-to-end suite, the scripts and the documentation. Each package carries the license text and a
`NOTICE` as Apache-2.0 asks, each `package.json` the `license` field, and every hand-written source file an SPDX header
(`// SPDX-License-Identifier: Apache-2.0`, checked by `scripts/check-spdx.sh`, part of `just check`).

| Directory | What it is | License files |
|---|---|---|
| `web/` | `@tavrn/web`: the React web client, its assets, translations and tests | [web/LICENSE](web/LICENSE), [web/NOTICE](web/NOTICE) |
| `e2e/` | `@tavrn/e2e`: the Playwright suite with its helpers and fixtures (fake OpenID provider, example bot) | [e2e/LICENSE](e2e/LICENSE), [e2e/NOTICE](e2e/NOTICE) |
| `apps/desktop/` | `@tavrn/desktop`: the desktop app, a Tauri shell (Rust crate `tavrn-desktop`) around the web client | [apps/desktop/LICENSE](apps/desktop/LICENSE), [apps/desktop/NOTICE](apps/desktop/NOTICE) |
| everything else | workspace and build files, `scripts/`, `.github/`, `docs/` | [LICENSE](LICENSE), [NOTICE](NOTICE) |

Why Apache-2.0: the client must be usable in app stores (GPL licenses are not) and by anyone who builds on it, while
the patent grant protects users and contributors.

**Dependencies under other licenses.** The client is built on [`@tavrn/e2ee`](https://github.com/just-tavrn/tavrn-js)
and [`@tavrn/crypto`](https://github.com/just-tavrn/tavrn-crypto), which are MPL-2.0: a file-level copyleft, so their
files stay MPL-2.0 (changes to them are shared back in their repositories), while this repository and the bundle that
contains them stay Apache-2.0. They are dependencies, not part of this repository. `@tavrn/sdk` and `@tavrn/bot` are
Apache-2.0. No dependency of the client is (A)GPL or LGPL: `scripts/check-js-licenses.mjs` refuses them and checks
every production dependency against an allow-list (MIT, BSD, ISC, Apache-2.0, MPL-2.0 and similar). The Rust crates of
the desktop shell are checked by `cargo deny check licenses` with the same allow-list (`apps/desktop/src-tauri/deny.toml`).

The name "tavrn", the logo and the icons in `web/public/` and `apps/desktop/src-tauri/icons/` are not covered by these
licenses: see [TRADEMARK.md](TRADEMARK.md). Contributions are accepted under the [contributor license agreement](CLA.md).
