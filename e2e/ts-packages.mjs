// SPDX-License-Identifier: Apache-2.0
/**
 * Lets the Playwright runner and its workers import the @tavrn packages (@tavrn/sdk, @tavrn/e2ee, @tavrn/bot), which
 * ship TypeScript sources with extensionless relative imports (written for bundlers and TypeScript-aware runners).
 * Installed from git they live below node_modules, where neither Playwright's transform nor Node's type stripping
 * touches them. These module hooks resolve their extensionless imports and turn their `.ts` files into JavaScript with
 * Node's own `stripTypeScriptTypes` (transform mode: parameter properties); nothing else is affected.
 * playwright.config.ts registers them in the runner and passes `--import` of this file to the workers.
 */
import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const PACKAGE_TS = /\/node_modules\/@tavrn\/(sdk|e2ee|bot)\/.*\.ts$/;
const inPackage = (url) => typeof url === "string" && PACKAGE_TS.test(url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (inPackage(context.parentURL) && (specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]s$|\.json$/.test(specifier)) {
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        const url = new URL(candidate, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, format: "module", shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!inPackage(url)) return nextLoad(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    return { format: "module", source: stripTypeScriptTypes(source, { mode: "transform", sourceUrl: url }), shortCircuit: true };
  },
});
