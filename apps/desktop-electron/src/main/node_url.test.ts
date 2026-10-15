// SPDX-License-Identifier: Apache-2.0
// The cases of apps/shared-vectors/node_url.json, which apps/desktop/src-tauri/src/node_url.rs tests too: both shells
// accept the same nodes.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeUrlError, validDomain, validateNodeUrl } from "./node_url.ts";

const ok = (input: string) => validateNodeUrl(input);
const err = (input: string): string => {
  try {
    validateNodeUrl(input);
  } catch (e) {
    assert.ok(e instanceof NodeUrlError, `${input}: ${String(e)}`);
    return e.code;
  }
  assert.fail(`${input} was accepted`);
};

interface Vectors {
  accept: Array<[string, string]>;
  refuse: Array<[string, string]>;
  domains: { valid: string[]; invalid: string[] };
}
const vectors = JSON.parse(readFileSync(new URL("../../../shared-vectors/node_url.json", import.meta.url), "utf8")) as Vectors;

test("the shared vectors of both shells: https origins, plain http only on this computer, nothing else", () => {
  assert.ok(vectors.accept.length > 0 && vectors.refuse.length > 0);
  for (const [input, normalized] of vectors.accept) assert.equal(ok(input), normalized, input);
  // The length limit counts bytes, as the Rust shell does (a case of the vectors).
  for (const [input, code] of vectors.refuse) assert.equal(err(input), code, input);
  for (const d of vectors.domains.valid) assert.ok(validDomain(d), d);
  for (const d of vectors.domains.invalid) assert.ok(!validDomain(d), d);
});
