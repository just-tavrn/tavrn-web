# GitHub setup of tavrn-web

The repository is prepared so that nothing runs on GitHub until the owner switches it on. This page lists what is
configured in the repository and what has to be set by hand.

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` → `JavaScript` | push to `main`, pull requests, by hand | the organization's `js-ci.yml` on the self-hosted runner `tavrn-heavy`: install from the lockfile (with the private `@tavrn` git dependencies), SPDX headers, dependency licenses, typecheck (web client and e2e suite), Vitest (including the static accessibility checks), the production bundle `web/dist` |
| `ci.yml` → `Publication hygiene` | same | `scripts/publish-check.sh`: no private files, domains or secrets |
| `e2e.yml` → `End-to-end` | every night at 03:17 UTC against the current node image; by hand (`gh workflow run e2e.yml --ref <branch>`); never on pull requests or pushes during the development phase (merges do not wait for it) | the organization's `e2e.yml` on the self-hosted runner `tavrn-e2e`: pulls the node image (`TAVRN_NODE_IMAGE`, default `ghcr.io/just-tavrn/tavrn-node:edge`), copies `tavrn-node`, `livekit-server` and `ffmpeg` out of it and runs the full Playwright suite on `chromium`, `mobile-android` and `tablet-chromium` with two workers; a manual run can pass another image or other Playwright arguments |
| `release.yml` | tag `v*.*.*` (a tag with a hyphen, `vX.Y.Z-rc.N`, becomes a pre-release) | checks that the tag equals `web/package.json`'s version, runs the checks, builds `web/dist` and attaches `tavrn-web-X.Y.Z.tar.gz` and its `.sha256` to a GitHub release whose notes start with the table of downloads; then its job `desktop` calls `desktop.yml` for the desktop assets of the same release |
| `desktop.yml` → `Tauri shell (Linux checks)` | pushes to `main` touching `apps/desktop/**`, `apps/desktop-electron/**`, `web/**`, the lockfile or the workspace (`ci.yml` → `Desktop` calls `desktop.yml` after its JavaScript job, with the `web/dist` that job built); by hand (`gh workflow run desktop.yml --ref <branch>`, the jobs then build `web/dist` themselves); never on pull requests during the development phase, never for release tags | the Tauri shell's checks on the self-hosted runner `tavrn-heavy` (`ubuntu-latest` for forks, Dependabot and `dependabot/*` branches): `cargo fmt`, `clippy`, `cargo test` of `src-tauri` and the key listener crate, `cargo deny check bans licenses sources`, the Secret Service round trip; no bundles (Linux ships the Electron shell), no artifact ([DESKTOP.md](DESKTOP.md) "Builds and releases") |
| `desktop.yml` → `Desktop (Linux, Electron)` | as above; release tags | the Linux app on `tavrn-heavy` (`ubuntu-latest` for forks, Dependabot and release tags): the native modules' checks (the shell's typecheck and tests run in `ci.yml`), the key listener module, `.AppImage`, `.deb` and `latest-linux.yml` with their `.sha256`, uploaded as artifact `desktop-linux-electron` (7 days) right after packaging; then every Playwright spec against a copy, with the node image's `tavrn-node` (a release: the image pinned by digest, `TAVRN_RELEASE_NODE_IMAGE`) |
| `desktop.yml` → `Desktop (Windows NSIS, cross-compiled)` | as `Tauri shell (Linux checks)`; never for forks or Dependabot | the Tauri NSIS installer cross-compiled with cargo-xwin on `tavrn-heavy`, the Windows SDK from the runner's cache; artifact `desktop-windows-nsis` for 7 days |
| `advisories.yml` | daily, pull requests that change a `Cargo.lock` or `deny.toml` under `apps/`, by hand | the organization's `rust-advisories.yml`: `cargo deny check advisories` of the desktop crates; a scheduled failure opens the issue "RustSec advisories" |
| `desktop.yml` → `Desktop (Windows)` | by hand with `windows: true`; release tags | the Tauri `.msi` and NSIS installers on `windows-latest`, built without any secret (`Release assets` signs them), as artifact `desktop-windows` for 7 days |
| `desktop.yml` → `Desktop (Windows, Electron fallback)` | by hand with `electron-windows: true`; release tags | the Electron shell's NSIS installer `tavrn-electron_<version>_x64-setup.exe`, its block map and `latest.yml` on `windows-latest`, as artifact `desktop-windows-electron` for 7 days |
| `desktop.yml` → `Android (APK, arm64)` | by hand with `android: true`; release tags | the Android app's release APK for arm64 on `ubuntu-latest` (NDK pinned), unsigned, built without any secret, and the Kotlin unit tests; artifact `desktop-android` for 7 days ([ANDROID.md](ANDROID.md) "Releases") |
| `desktop.yml` → `Release assets` | release tags, after the owner approved the environment `release` | the only job with the updater key and the Android keystore: checks the Linux packages against their `.sha256`, signs the Tauri installers (`<installer>.sig`) and `latest-linux.yml` and `latest.yml` (`<feed>.minisig`) with the Tauri CLI alone (installed without lifecycle scripts, no cargo, no cache), signs the APK with the runner image's `apksigner` (`Tavrn_<version>_android-arm64.apk`, checked against `ANDROID_CERT_SHA256` when set), takes each build job's artifact by id and only the files that job may deliver, verifies every signature with the public key, attests the build provenance of every asset (once the repository is public: GitHub's Free plan has no artifact attestations for private repositories), writes a `<asset>.sha256` per installer and `latest.json`, checks the set against the names the website's download page expects (`apps/desktop/scripts/release-assets.mjs`) and attaches it to the release `release.yml` created ([DESKTOP.md](DESKTOP.md) "What a release carries") |
| `gitleaks.yml` | push to `main`, pull requests, by hand | the organization's `gitleaks.yml`: secret scan of the full history (`.gitleaks.toml`) |
| `dependency-review.yml` | pull requests | refuses vulnerable dependencies and licenses outside the allow-list |
| `cla.yml` | pull requests, comments | the organization's `cla.yml` (CLA bot) |

The reusable workflows live in [`just-tavrn/.github`](https://github.com/just-tavrn/.github); its `docs/GITHUB.md`
describes the organization settings, the self-hosted runner and how to create the tokens below.

Every job carries `if: ${{ vars.CI_ENABLED == 'true' }}`.

## Variables and secrets (Settings → Secrets and variables → Actions)

| Name | Kind | Purpose |
|---|---|---|
| `CI_ENABLED` | variable | `true` switches all workflows on. Unset or anything else: every job is skipped. |
| `TAVRN_NODE_IMAGE` | variable | optional: the node image the end-to-end suite runs against (default `ghcr.io/just-tavrn/tavrn-node:edge`). Pin it to a release tag (`:0.1`) to test against a released node. |
| `TAVRN_RELEASE_NODE_IMAGE` | variable | the node image of a release's Electron specs, pinned by digest (`ghcr.io/just-tavrn/tavrn-node@sha256:…`); without it, or with a tag instead of a digest, the release's specs refuse to run. Set it to the digest of the node release the client is released with (`docker buildx imagetools inspect ghcr.io/just-tavrn/tavrn-node:<version>`, or the digest in the node release's notes). |
| `TAVRN_READ_PAT` | secret | Private phase only: fine-grained PAT with `contents: read` on `tavrn-js` and `tavrn-crypto` (the `@tavrn` git dependencies), passed to the reusable workflows as `READ_TOKEN`. Delete it once the repositories are public. |
| `PUBLISH_CHECK_PRIVATE` | secret (repository or organization) | comma-separated private domains, hosts and addresses that must never appear in the tree (`Publication hygiene`). Without it the check fails on purpose, except on Dependabot's pull requests (below). Locally the same list lives in an untracked `.publish-check.private` (in the repository or its parent directory). |
| Dependabot secrets | secret (Dependabot) | Dependabot pull requests run with Dependabot's own secret store: add `TAVRN_READ_PAT` and `PUBLISH_CHECK_PRIVATE` again under Settings → Secrets and variables → Dependabot (or as organization Dependabot secrets), otherwise their CI fails at the private git dependencies, and the hygiene check skips its private-pattern step with a warning (the workflow sets `PUBLISH_CHECK_ALLOW_UNCONFIGURED=1` for Dependabot's pull requests only; the push to `main` runs the full check). |
| `TAURI_SIGNING_PRIVATE_KEY` | secret of the environment `release` (never a repository secret) | the private minisign key of the desktop apps' updates (content of the key file of `tauri signer generate`, [DESKTOP.md](DESKTOP.md) "Updates"): it signs the Tauri installers and the Electron shell's feeds; only the job `Release assets` of a tag's run sees it. `release.yml` passes it by name to `desktop.yml` (a called workflow receives an environment secret only when the caller names it); GitHub resolves the value from the environment at the job that declares it, so the build jobs never hold it. Its public key replaces the placeholder in `apps/desktop/src-tauri/tauri.conf.json`; without both, the desktop part of a release fails on purpose. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret of the environment `release` | the password of that key |
| `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | secrets of the environment `release` | the Android app's release keystore (base64 of the `.jks`), its password, the key's alias and password ([ANDROID.md](ANDROID.md) "Releases"); passed by name like the updater key, seen only by `Release assets`. Every update of the app must be signed with the same key. |
| `ANDROID_CERT_SHA256` | variable (optional, recommended) | the SHA-256 fingerprint of that key's certificate (`AA:BB:…`): `Release assets` fails when the signed APK carries another one |
| environment `release` | Settings → Environments | deployment only from tags `v*`, required reviewer: the owner; holds the secrets above. A release run waits at `Release assets` until the owner approves it. A repository secret would be readable by every workflow of every branch; an environment secret only by a job that declares the environment and passes its rules. |
| `CLA_PAT` | organization secret | the CLA bot's token (`contents: write` on `just-tavrn/cla-signatures`). Organization secrets do not reach private repositories on the free plan: until the repository is public, add it as a repository secret as well. |

## End-to-end tests on the self-hosted runner

The job runs on the test host's runner (label `tavrn-e2e`, set up as described in the organization's
`docs/GITHUB.md`). Before setting `CI_ENABLED=true`:

- the runner group `tavrn-e2e` must include `tavrn-web` (Organization settings → Actions → Runner groups),
- the image `ghcr.io/just-tavrn/tavrn-node` must exist and grant `tavrn-web` read access (package settings → "Manage
  Actions access"), since the job pulls it with the job token,
- the host has the system libraries of Playwright's Chromium installed once (`pnpm exec playwright install-deps chromium`).

The job never runs for pull requests from forks: a self-hosted runner executes the code it checks out. Once the
repository is public, also require approval for workflows from outside collaborators (Settings → Actions → General).

## Releases (private phase)

1. Bump `version` in `web/package.json` (and `e2e/package.json`) to `X.Y.Z` (the desktop app takes the same version); if the release train moved, bump the
   `@tavrn` git dependencies (`web/package.json`, `e2e/package.json` and the `overrides` in `pnpm-workspace.yaml`) to
   the new tags and run `pnpm install`.
2. `just check`, the end-to-end suite against the matching node, commit, tag `vX.Y.Z`, push the tag (only organization
   owners may create `v*` tags). Set `TAVRN_RELEASE_NODE_IMAGE` to the digest of the matching node release first.
3. With `CI_ENABLED` the release workflow attaches the bundle tarball to a GitHub release, then the desktop assets
   (installers, checksums, signed feeds; [DESKTOP.md](DESKTOP.md) "The release procedure"); the website's download
   page reads the releases through GitHub's API by itself. The run waits for the owner's approval of the environment
   `release` before `Release assets` signs anything: check that the build jobs ran for the tag you pushed. A
   failed desktop job is re-run, never re-tagged. `v0.1.0` was tagged before the CI ran, without a GitHub release.
4. In tavrn-node, set `TAVRN_WEB_REF` to the tag before tagging a node release, so the image embeds this version.

## Desktop builds

The desktop builds run on the organization's self-hosted runner `tavrn-heavy` (`runs-on: [self-hosted, linux, x64,
tavrn-heavy]`; the runner stack and its image are described in `just-tavrn/.github`, `runner/README.md` "Desktop
builds"): the Tauri shell's checks on Linux, the Linux app (Electron) with its packages and specs, and the Tauri NSIS
installer cross-compiled with cargo-xwin.
Self-hosted only for trusted events, with the rule of the organization's `route.yml` (the job `route` asks it): pushes and manual runs
(and pull requests from branches of this repository, should the workflow run for pull requests again); code from forks,
Dependabot and `dependabot/*` branches builds Linux on `ubuntu-latest` and skips the cross-compiled installer. A manual
run executes the dispatched branch's code (and its workflow files) on the runner as if a maintainer wrote it: dispatch
only branches whose diff you have read. Release tags build on GitHub-hosted runners only (`ubuntu-latest` for Linux and
the release assets, `windows-latest` for both Windows builds); the build jobs hold no secret, and only `Release
assets` (environment `release`) sees the updater key. Before `CI_ENABLED=true`, the runner group of `tavrn-heavy` must serve `tavrn-web`, and the node
image must grant `tavrn-web` read access (the Electron specs copy `tavrn-node` out of it).

Pull requests start no desktop build (they run the quick checks of `ci.yml`); a pull request's branch is built by hand.
Every push to `main` that touches the apps builds, so the artifacts `desktop-linux-electron` and `desktop-windows-nsis`
of the latest `main` run are the current Linux packages and Tauri installer. The `.msi` (and a natively built NSIS
installer as a cross-check) and the Electron fallback for Windows by hand for any branch:

```sh
gh workflow run desktop.yml --ref <branch> -f windows=true -f electron-windows=true
gh run list --workflow desktop.yml --limit 3      # then download desktop-linux-electron / desktop-windows-nsis / desktop-windows / desktop-windows-electron
```

GitHub dispatches a workflow by hand only once the workflow file exists on the default branch; before that, a pull
request's branch gets the automatic builds only. The installers are not signed with an OS certificate (Windows
SmartScreen warns once); the updater signature is the only signature. `-f macos=true` builds the unsigned universal
macOS app on `macos-latest` (continue-on-error; DESKTOP.md "macOS").

## Settings applied through the API

Default branch `main`, delete branches on merge, squash merges allowed, issues on, wiki off, projects off, the workflow
token read-only. Labels from `scripts/github-labels.sh`: the common set plus `scripts/labels.txt` (idempotent; rerun it after editing the list).

## Settings the owner flips by hand

- [ ] `CI_ENABLED` and the secrets above when CI should run.
- [ ] The desktop updater key: `tauri signer generate`, the public key into `tauri.conf.json`, the private key and its
      password as `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` of the environment `release`
      (`gh secret set <name> --env release`), never as repository secrets ([DESKTOP.md](DESKTOP.md) "Updates").
- [ ] Later, once public: a Windows code-signing certificate for both Windows installers ([DESKTOP.md](DESKTOP.md)
      "What a release carries").
- [ ] Secret scanning with push protection (Settings → Code security; free for public repositories).
- [ ] Private vulnerability reporting (Settings → Code security), so "Report a vulnerability" works.
- [ ] Dependency graph and Dependabot alerts (needed by `dependency-review.yml`; on private repositories only with
      GitHub Advanced Security). Dependabot version updates run as soon as `dependabot.yml` exists (not gated by
      `CI_ENABLED`); pause them under Insights → Dependency graph → Dependabot to keep the private phase quiet.
- [ ] Actions access: while `just-tavrn/.github` is private, its Settings → Actions → General → Access must be
      "Accessible from repositories in the just-tavrn organization", or every push shows a failed run with
      "workflow file issue".
- [ ] Discussions: questions are routed to the Discussions of the umbrella repository `just-tavrn/tavrn`
      (`ISSUE_TEMPLATE/config.yml`); nothing to switch on here.
- [ ] Team `@just-tavrn/maintainers` must exist for `CODEOWNERS`.
- [ ] Once public: branch protection or a ruleset for `main` (require pull requests with one review from
      `@just-tavrn/maintainers`, the checks `JavaScript`, `Publication hygiene`, `gitleaks`, `Dependency review`,
      `CLA` (not `End-to-end`: it never runs for pull requests, so a required check would wait forever; the
      organization's `scripts/github-rulesets.sh` sets the list); linear history, no force pushes, no deletions)
      and tag protection for `v*`. Not available for private repositories on the free plan.
