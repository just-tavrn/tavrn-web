# GitHub setup of tavrn-web

The repository is prepared so that nothing runs on GitHub until the owner switches it on. This page lists what is
configured in the repository and what has to be set by hand.

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` → `JavaScript` | push to `main`, pull requests, by hand | the organization's `js-ci.yml` on the self-hosted runner `tavrn-heavy`: install from the lockfile (with the private `@tavrn` git dependencies), SPDX headers, dependency licenses, typecheck (web client and e2e suite), Vitest (including the static accessibility checks), the production bundle `web/dist` |
| `ci.yml` → `Publication hygiene` | same | `scripts/publish-check.sh`: no private files, domains or secrets |
| `e2e.yml` → `End-to-end` | every night at 03:17 UTC against the current node image; by hand (`gh workflow run e2e.yml --ref <branch>`); never on pull requests or pushes during the development phase (merges do not wait for it) | the organization's `e2e.yml` on the self-hosted runner `tavrn-e2e`: pulls the node image (`TAVRN_NODE_IMAGE`, default `ghcr.io/just-tavrn/tavrn-node:edge`), copies `tavrn-node`, `livekit-server` and `ffmpeg` out of it and runs the full Playwright suite on `chromium`, `mobile-android` and `tablet-chromium` with two workers; a manual run can pass another image or other Playwright arguments |
| `release.yml` | tag `v*.*.*` | checks that the tag equals `web/package.json`'s version, runs the checks, builds `web/dist` and attaches `tavrn-web-X.Y.Z.tar.gz` and its `.sha256` to a GitHub release; then its job `desktop` calls `desktop.yml` for the desktop installers of the same release |
| `desktop.yml` → `Desktop (Linux)` | pushes to `main` touching `apps/desktop/**`, `web/**`, the lockfile or the workspace; by hand (`gh workflow run desktop.yml --ref <branch>`); release tags; never on pull requests during the development phase | the desktop app on the self-hosted runner `tavrn-heavy` (`ubuntu-latest` for forks, Dependabot and release tags): web client build, `cargo fmt`, `clippy`, `cargo test`, `cargo deny check licenses`, the Secret Service round trip, the update manifest test, `tauri build` (`.deb`, `.AppImage`), the WebDriver smoke test under xvfb against the node image's `tavrn-node`; the installers as artifact `desktop-linux` for 7 days ([DESKTOP.md](DESKTOP.md)) |
| `desktop.yml` → `Desktop (Windows NSIS, cross-compiled)` | as `Desktop (Linux)`, except release tags; never for forks or Dependabot | the NSIS installer cross-compiled with cargo-xwin on `tavrn-heavy`, the Windows SDK from the runner's cache; artifact `desktop-windows-nsis` for 7 days |
| `desktop.yml` → `Desktop (Windows)` | by hand with `windows: true`; release tags | the `.msi` and NSIS installers on `windows-latest`, as artifact `desktop-windows` for 7 days |
| `desktop.yml` → `Release assets` | release tags | attaches the installers, a `<asset>.sha256` file per installer (`apps/desktop/scripts/checksums.mjs`, `sha256sum` format), their updater signatures (`.sig`) and `latest.json` to the release `release.yml` created |
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
| `TAVRN_READ_PAT` | secret | Private phase only: fine-grained PAT with `contents: read` on `tavrn-js` and `tavrn-crypto` (the `@tavrn` git dependencies), passed to the reusable workflows as `READ_TOKEN`. Delete it once the repositories are public. |
| `PUBLISH_CHECK_PRIVATE` | secret (repository or organization) | comma-separated private domains, hosts and addresses that must never appear in the tree (`Publication hygiene`). Without it the check fails on purpose. Locally the same list lives in an untracked `.publish-check.private` (in the repository or its parent directory). |
| Dependabot secrets | secret (Dependabot) | Dependabot pull requests run with Dependabot's own secret store: add `TAVRN_READ_PAT` and `PUBLISH_CHECK_PRIVATE` again under Settings → Secrets and variables → Dependabot (or as organization Dependabot secrets), otherwise their CI fails at the private git dependencies and at the hygiene check. |
| `TAURI_SIGNING_PRIVATE_KEY` | secret | the private minisign key of the desktop app's updater (content of the key file of `tauri signer generate`, [DESKTOP.md](DESKTOP.md) "Updates"); only tagged release builds use it. Its public key replaces the placeholder in `apps/desktop/src-tauri/tauri.conf.json`; without both, the desktop part of a release fails on purpose. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret | the password of that key |
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
2. `just check`, the end-to-end suite against the matching node, commit, tag `vX.Y.Z`, push the tag.
3. With `CI_ENABLED` the release workflow attaches the bundle tarball to a GitHub release. `v0.1.0` was tagged before
   the CI ran, without a GitHub release.
4. In tavrn-node, set `TAVRN_WEB_REF` to the tag before tagging a node release, so the image embeds this version.

## Desktop builds

The desktop builds run on the organization's self-hosted runner `tavrn-heavy` (`runs-on: [self-hosted, linux, x64,
tavrn-heavy]`; the runner stack and its image are described in `just-tavrn/.github`, `runner/README.md` "Desktop
builds"): the Linux build with its checks and smoke test, and the Windows NSIS installer cross-compiled with cargo-xwin.
Self-hosted only for trusted events, with the expression of the organization's `rust-ci.yml`: pushes and manual runs
(and pull requests from branches of this repository, should the workflow run for pull requests again); code from forks
and Dependabot builds Linux on `ubuntu-latest` and skips the cross-compiled installer. Release tags build on GitHub-hosted runners (Linux, and `windows-latest` for
the `.msi`), since they carry the updater key. Before `CI_ENABLED=true`, the runner group of `tavrn-heavy` must serve
`tavrn-web`, and the node image must grant `tavrn-web` read access (the smoke test copies `tavrn-node` out of it).

Pull requests start no desktop build (they run the quick checks of `ci.yml`); a pull request's branch is built by hand.
Every push to `main` that touches the app builds, so the artifacts `desktop-linux` and `desktop-windows-nsis` of the
latest `main` run are the current installers. The `.msi` (and a natively built NSIS installer as a cross-check) by hand
for any branch:

```sh
gh workflow run desktop.yml --ref <branch> -f windows=true
gh run list --workflow desktop.yml --limit 3      # then download desktop-linux / desktop-windows-nsis / desktop-windows
```

GitHub dispatches a workflow by hand only once the workflow file exists on the default branch; before that, a pull
request's branch gets the automatic builds only. The installers are not signed with an OS certificate (Windows
SmartScreen warns once); the updater signature is the only signature. macOS builds come later.

## Settings applied through the API

Default branch `main`, delete branches on merge, squash merges allowed, issues on, wiki off, projects off, the workflow
token read-only. Labels from `scripts/github-labels.sh` (idempotent; rerun it after editing the list).

## Settings the owner flips by hand

- [ ] `CI_ENABLED` and the secrets above when CI should run.
- [ ] The desktop updater key: `tauri signer generate`, the public key into `tauri.conf.json`, the private key and its
      password as `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` ([DESKTOP.md](DESKTOP.md) "Updates").
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
