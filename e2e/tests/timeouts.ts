// SPDX-License-Identifier: Apache-2.0
/**
 * One environment-scaled timeout for the end-to-end suites (this suite and the Electron shell's specs in
 * apps/desktop-electron/e2e): `TAVRN_TEST_TIMEOUT_FACTOR` says how much slower than a developer machine this one may be
 * (default 1; the organization's self-hosted runners set 3, a busy laptop can set 2). Every limit a test WAITS for
 * something to happen goes through {@link scaled}: the test timeouts, `expect` timeouts, the crypto-heavy steps. Fixed
 * pauses and "nothing happens within" windows stay as they are (scaling those only makes the suite slower). The
 * node's integration tests read the same variable (tavrn-node tests/common).
 */

/** The factor of `value` (`TAVRN_TEST_TIMEOUT_FACTOR`): 1 when unset or empty; anything but a number in (0, 100] throws. */
export function timeoutFactor(value: string | undefined = process.env.TAVRN_TEST_TIMEOUT_FACTOR): number {
  const v = value?.trim();
  if (!v) return 1;
  const factor = Number(v);
  if (!Number.isFinite(factor) || factor <= 0 || factor > 100) {
    throw new Error(`TAVRN_TEST_TIMEOUT_FACTOR=${JSON.stringify(value)} is not a number between 0 and 100`);
  }
  return factor;
}

export const TIMEOUT_FACTOR = timeoutFactor();

/** `ms` (the limit on a developer machine) scaled by `TAVRN_TEST_TIMEOUT_FACTOR`. */
export function scaled(ms: number, factor: number = TIMEOUT_FACTOR): number {
  return Math.round(ms * factor);
}
