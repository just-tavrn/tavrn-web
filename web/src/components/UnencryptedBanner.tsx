// SPDX-License-Identifier: Apache-2.0
import { useT } from "../i18n";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Mandatory marker per PROTOCOL.md section 8: permanently visible above the chat
 * as long as the channel is not end-to-end encrypted.
 */
export function UnencryptedBanner({ domain }: { domain: string }) {
  const t = useT();
  return (
    <div role="status" data-testid="unencrypted-banner" className="flex items-center gap-2 border-b border-warn/30 bg-warn/10 px-4 py-2 text-sm text-warn">
      <span aria-hidden="true">🔓</span>
      <span dangerouslySetInnerHTML={{ __html: t("banner.unencrypted", { domain: escapeHtml(domain) }) }} />
    </div>
  );
}
