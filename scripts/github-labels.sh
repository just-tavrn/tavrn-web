#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Creates (or updates) the issue labels of this repository. Needs the GitHub CLI, authenticated with
# write access to the repository. Usage: scripts/github-labels.sh [owner/repo]
set -euo pipefail
repo="${1:-just-tavrn/tavrn-web}"

label() {
  gh label create "$1" --repo "$repo" --color "$2" --description "$3" --force
}

label bug "d73a4a" "Something does not work as described"
label enhancement "a2eeef" "New feature or improvement"
label documentation "0075ca" "Documentation only"
label security "b60205" "Security hardening (report vulnerabilities privately, not as issues)"
label "good first issue" "7057ff" "Good for newcomers"
label "help wanted" "008672" "Extra attention is wanted"
label question "d876e3" "Further information is requested"
label duplicate "cfd3d7" "This issue or pull request already exists"
label invalid "e4e669" "This does not seem right"
label wontfix "ffffff" "This will not be worked on"
label dependencies "0366d6" "Dependency updates"
label ui "1d76db" "Screens, layout and interaction of the web client"
label accessibility "0e8a16" "Accessibility (WCAG 2.2 AA, docs/ACCESSIBILITY.md)"
label e2ee "5319e7" "End-to-end encryption in the client"
label voice "c5def5" "Voice, video, screen sharing, soundboard"
label i18n "bfd4f2" "Translations and locales (web/src/i18n)"
label e2e "f9d0c4" "Playwright end-to-end suite"
label desktop "d4c5f9" "Phase 6: the Tauri desktop and mobile shells"
label node "e99695" "Needs a change in tavrn-node"
label protocol "fbca04" "Needs a change or clarification in tavrn-protocol"
label ci "ededed" "Workflows and build tooling"
label "needs-triage" "ffffff" "Not looked at yet"
