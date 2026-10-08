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
  auth: {
    // Today's connect flow of FEDERATION.md §8: the home node's page sends the browser back to /connect/callback.
    signInOnNodePage: async (req) => {
      const { startConnect } = await import("../lib/remoteSignIn");
      location.assign(await startConnect(req.endpoints, req.next, req.address));
      return new Promise(() => {});
    },
  },
};
