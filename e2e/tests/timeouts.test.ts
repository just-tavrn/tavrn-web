// SPDX-License-Identifier: Apache-2.0
// Unit test of the suites' timeout factor (node --test, no browser): `pnpm --filter @tavrn/e2e test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { scaled, timeoutFactor } from "./timeouts.ts";

test("the timeout factor defaults to 1 and takes positive numbers", () => {
  assert.equal(timeoutFactor(undefined), 1);
  assert.equal(timeoutFactor(" "), 1);
  assert.equal(timeoutFactor("3"), 3);
  assert.equal(timeoutFactor("1.5"), 1.5);
});

test("anything else stops the run instead of silently falling back", () => {
  for (const bad of ["0", "-2", "3x", "NaN", "Infinity", "1000"]) assert.throws(() => timeoutFactor(bad), /TAVRN_TEST_TIMEOUT_FACTOR/, bad);
});

test("limits scale and stay whole milliseconds", () => {
  assert.equal(scaled(10_000, 1), 10_000);
  assert.equal(scaled(10_000, 3), 30_000);
  assert.equal(scaled(333, 1.5), 500);
});
