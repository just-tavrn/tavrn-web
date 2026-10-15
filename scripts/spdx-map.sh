# SPDX-License-Identifier: Apache-2.0
#
# The license map of scripts/check-spdx.sh (sourced by it): the files it checks and the license of each path, first
# match wins. Keep it in sync with LICENSE.md: everything in this repository is Apache-2.0
# (Rust, TypeScript, JavaScript, Kotlin and Gradle's Kotlin scripts, shell); dependencies and build output are skipped.
# shellcheck shell=bash disable=SC2034 # spdx_files is read by check-spdx.sh

spdx_files=('*.rs' '*.ts' '*.tsx' '*.mjs' '*.js' '*.sh' '*.kt' '*.kts')

license_for() {
  case "$1" in
    */node_modules/* | node_modules/* | */dist/* | target/*) echo skip ;;
    web/* | e2e/* | scripts/* | apps/*) echo Apache-2.0 ;;
    *) echo unmapped ;;
  esac
}
