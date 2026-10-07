# GitHub setup of tavrn-web

The repository is prepared so that nothing runs on GitHub until the owner switches it on. This page lists what is
configured in the repository and what has to be set by hand.

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` → `JavaScript` | push to `main`, pull requests, by hand | the organization's `js-ci.yml`: install from the lockfile (with the private `@tavrn` git dependencies), SPDX headers, dependency licenses, typecheck (web client and e2e suite), Vitest (including the static accessibility checks), the production bundle `web/dist` |
| `ci.yml` → `Publication hygiene` | same | `scripts/publish-check.sh`: no private files, domains or secrets |
| `e2e.yml` → `End-to-end` | push to `main`, pull requests from branches of this repository (never from forks), by hand | the organization's `e2e.yml` on the self-hosted runner `tavrn-e2e`: pulls the node image (`TAVRN_NODE_IMAGE`, default `ghcr.io/just-tavrn/tavrn-node:edge`), copies `tavrn-node`, `livekit-server` and `ffmpeg` out of it and runs the full Playwright suite on `chromium`, `mobile-android` and `tablet-chromium` with two workers; a manual run can pass another image or other Playwright arguments |
| `release.yml` | tag `v*.*.*` | checks that the tag equals `web/package.json`'s version, runs the checks, builds `web/dist` and attaches `tavrn-web-X.Y.Z.tar.gz` and its `.sha256` to a GitHub release |
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

1. Bump `version` in `web/package.json` (and `e2e/package.json`) to `X.Y.Z`; if the release train moved, bump the
   `@tavrn` git dependencies (`web/package.json`, `e2e/package.json` and the `overrides` in `pnpm-workspace.yaml`) to
   the new tags and run `pnpm install`.
2. `just check`, the end-to-end suite against the matching node, commit, tag `vX.Y.Z`, push the tag.
3. With `CI_ENABLED` the release workflow attaches the bundle tarball to a GitHub release. `v0.1.0` was tagged before
   the CI ran, without a GitHub release.
4. In tavrn-node, set `TAVRN_WEB_REF` to the tag before tagging a node release, so the image embeds this version.

## Settings applied through the API

Default branch `main`, delete branches on merge, squash merges allowed, issues on, wiki off, projects off, the workflow
token read-only. Labels from `scripts/github-labels.sh` (idempotent; rerun it after editing the list).

## Settings the owner flips by hand

- [ ] `CI_ENABLED` and the secrets above when CI should run.
- [ ] Secret scanning with push protection (Settings → Code security; free for public repositories).
- [ ] Private vulnerability reporting (Settings → Code security), so "Report a vulnerability" works.
- [ ] Dependency graph and Dependabot alerts (needed by `dependency-review.yml`; on private repositories only with
      GitHub Advanced Security). Dependabot version updates run as soon as `dependabot.yml` exists (not gated by
      `CI_ENABLED`); pause them under Insights → Dependency graph → Dependabot to keep the private phase quiet.
- [ ] Actions access: while `just-tavrn/.github` is private, its Settings → Actions → General → Access must be
      "Accessible from repositories in the just-tavrn organization", or every push shows a failed run with
      "workflow file issue".
- [ ] Discussions: questions are routed to the organization's Discussions (`ISSUE_TEMPLATE/config.yml`).
- [ ] Team `@just-tavrn/maintainers` must exist for `CODEOWNERS`.
- [ ] Once public: branch protection or a ruleset for `main` (require pull requests with one review from
      `@just-tavrn/maintainers`, the checks `JavaScript`, `Publication hygiene`, `gitleaks`, `Dependency review`,
      `CLA`, and `End-to-end` once the runner serves this repository; linear history, no force pushes, no deletions)
      and tag protection for `v*`. Not available for private repositories on the free plan.
