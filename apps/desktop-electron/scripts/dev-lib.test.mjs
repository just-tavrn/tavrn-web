// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { devEnv } from "./dev-lib.mjs";

test("the app runs on the dev server and never as plain Node", () => {
  const env = devEnv({ PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" }, "http://localhost:5173");
  assert.deepEqual(env, { PATH: "/bin", TAVRN_DESKTOP_DEV_URL: "http://localhost:5173" });
});
