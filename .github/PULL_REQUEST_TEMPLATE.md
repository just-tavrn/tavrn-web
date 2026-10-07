## What and why

<!-- What does this change, and why? Link the issue (Fixes #123). Screenshots for visible changes (phone and desktop). -->

## Checklist

- [ ] `just check` passes locally (SPDX headers, dependency licenses, typecheck, Vitest)
- [ ] New or changed user flows are covered by Playwright specs, and the touched specs pass against a node (`E2E_NODE_BIN=… just e2e tests/<spec>.spec.ts`)
- [ ] The change works on phone, tablet and desktop widths, with the keyboard, and keeps the accessibility checks green (`docs/ACCESSIBILITY.md`)
- [ ] New texts are in `web/src/i18n/en.json` and every other language file (the i18n test checks the keys)
- [ ] Protocol changes (routes, events, wire formats) are specified in [tavrn-protocol](https://github.com/just-tavrn/tavrn-protocol) first
- [ ] New source files carry the SPDX header `Apache-2.0`
- [ ] No secrets, tokens, key files or private hosts in code, tests or logs
- [ ] I have signed the [CLA](https://github.com/just-tavrn/tavrn-web/blob/main/CLA.md) (the CLA bot asks on your first pull request)
