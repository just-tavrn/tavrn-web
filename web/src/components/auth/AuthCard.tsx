// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { publicApi } from "../../lib/api";
import { useT } from "../../i18n";
import { LocaleSwitch } from "../LocaleSwitch";
import { Toaster } from "../Toaster";
import { BrandLogo } from "./Brand";
import { LegalLink } from "../legal/LegalLink";

/**
 * Centered card with logo, language switch and the node name: sign-in, registration, unlock. `nodeInfo={false}`:
 * no node yet (the desktop app's node picker), so neither the node name nor its legal pages.
 */
export function AuthCard({ children, wide = false, nodeInfo = true }: { children: ReactNode; wide?: boolean; nodeInfo?: boolean }) {
  const t = useT();
  const node = useQuery({ queryKey: ["node", "origin"], queryFn: () => publicApi.node.info(), enabled: nodeInfo });
  return (
    <div role="main" className="flex min-h-full items-start justify-center p-4 sm:items-center">
      <div className={`w-full ${wide ? "max-w-lg" : "max-w-md"} overflow-hidden rounded-xl border border-line bg-bg-1 shadow-xl`}>
        <div className="brand-line" aria-hidden="true" />
        <div className="p-4 sm:p-6">
          <div className="relative">
            <div className="absolute right-0 top-0">
              <LocaleSwitch />
            </div>
            <BrandLogo />
          </div>
          {nodeInfo && (
            <p className="mt-2 text-center text-sm text-fg-2" data-testid="node-name">
              {node.data ? `${node.data.name} (${node.data.domain})` : t("node.connecting")}
            </p>
          )}
          <div className="mt-5">{children}</div>
          {nodeInfo && <LegalLink className="mt-4" />}
        </div>
      </div>
      <Toaster />
    </div>
  );
}
