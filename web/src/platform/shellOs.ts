// SPDX-License-Identifier: Apache-2.0
import type { ShellOs } from "./types";

/** The operating system a shell reports (`app_info` of the Tauri shell, `appInfo` of the Electron shell), normalized. */
export function shellOs(raw: string | undefined): ShellOs {
  switch (raw) {
    case "windows":
    case "macos":
    case "linux":
    case "android":
      return raw;
    default:
      return "other";
  }
}
