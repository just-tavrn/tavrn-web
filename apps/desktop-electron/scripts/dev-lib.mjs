// SPDX-License-Identifier: Apache-2.0
/** Helpers of scripts/dev.mjs, kept apart so `node --test` can check them. */

/**
 * The app's environment in development: the dev server's URL, and never run as plain Node (some tools export
 * ELECTRON_RUN_AS_NODE, with which the Electron binary behaves as `node` and the app cannot start).
 */
export function devEnv(base, devUrl) {
  const env = { ...base, TAVRN_DESKTOP_DEV_URL: devUrl };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
