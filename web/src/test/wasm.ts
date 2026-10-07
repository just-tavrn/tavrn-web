// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initSync } from "@tavrn/crypto";

/** Instantiates the WebAssembly module of the installed `@tavrn/crypto` package synchronously. */
export function initCryptoForTests() {
  initSync({ module: readFileSync(createRequire(import.meta.url).resolve("@tavrn/crypto/tavrn_crypto_bg.wasm")) });
}
