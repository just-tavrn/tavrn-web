// SPDX-License-Identifier: Apache-2.0
import { isTauri } from "@tauri-apps/api/core";

/** True inside the desktop app: the Tauri runtime announces itself (never decided by the user agent). */
export function detectTauri(): boolean {
  return isTauri();
}
