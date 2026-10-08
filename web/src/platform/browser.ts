// SPDX-License-Identifier: Apache-2.0
import { version } from "../../package.json";
import { externalUrl } from "./links";
import type { Platform } from "./types";

/** The client in a browser tab: the node is the origin it was loaded from (README "How the client reaches a node"). */
export const browserPlatform: Platform = {
  kind: "browser",
  isDesktop: false,
  nodeBase: () => "",
  webOrigin: () => location.origin,
  openExternal: async (url) => {
    window.open(externalUrl(url), "_blank", "noopener,noreferrer");
  },
  appVersion: async () => version,
};
