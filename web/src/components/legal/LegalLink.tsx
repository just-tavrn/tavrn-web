// SPDX-License-Identifier: Apache-2.0
import { Link } from "react-router";
import { useT } from "../../i18n";

/**
 * The small "Legal" link under the sign-in, registration, invite, connect and password-reset cards (design note 4.14):
 * the overview lists imprint, privacy policy and terms, so each is two clicks away from every screen.
 */
export function LegalLink({ className = "" }: { className?: string }) {
  const t = useT();
  return (
    <p className={`text-center ${className}`}>
      <Link to="/legal" className="inline-flex min-h-6 items-center text-xs text-fg-2 underline-offset-2 hover:text-fg-0 hover:underline" data-testid="legal-footer-link">
        {t("legal.footer")}
      </Link>
    </p>
  );
}
