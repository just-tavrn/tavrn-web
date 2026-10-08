// SPDX-License-Identifier: Apache-2.0
/** Schemes a link outside the client may have; everything else (javascript:, file:, data:, …) is refused. */
const EXTERNAL = new Set(["https:", "http:", "mailto:"]);

/** `url` when it is an absolute link the client may hand to a browser or the system, otherwise an error. */
export function externalUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Not an absolute URL");
  }
  if (!EXTERNAL.has(parsed.protocol)) throw new Error(`Links with ${parsed.protocol} are not opened`);
  return parsed.href;
}
