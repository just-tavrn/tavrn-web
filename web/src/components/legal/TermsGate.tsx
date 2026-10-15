// SPDX-License-Identifier: Apache-2.0
/**
 * The one-time acceptance of new terms of service after sign-in (design note 4.14 item 2). The home node says whether the
 * current version is pending (`GET /users/me/terms`). In `notice` mode "Not now" hides the dialog for this version on
 * this device; in `require` mode the node refuses everything else (`403 legal.terms_required`) until the user accepts,
 * and declining signs out. SSO accounts see it at their first sign-in like everyone else.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TavrnApiError } from "@tavrn/sdk";
import { useLocation } from "react-router";
import { api } from "../../lib/api";
import { useT } from "../../i18n";
import { useAuth, useSessionKey } from "../../stores/auth";
import { signOut } from "../../stores/e2ee";
import { toastError } from "../../stores/toasts";
import { Button, Dialog } from "../ui";
import { LegalDocumentView } from "../../pages/legal/LegalPages";
import { notifyStatement } from "../../hooks/useRealtime";

const SEEN = "tavrn.legal.seen";

/** Statements of reasons that arrived while the user was away become notification entries once (per device). */
function useMissedStatements(session: string | null, address: string) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!session || !address) return;
    let cancelled = false;
    void api.legal
      .myNotices()
      .then((list) => {
        if (cancelled) return;
        let seen: string[] = [];
        try {
          seen = JSON.parse(localStorage.getItem(`${SEEN}:${address}`) ?? "[]") as string[];
        } catch {
          seen = [];
        }
        const fresh = list.filter((n) => n.statement && !seen.includes(`${n.case_id}:${n.statement_at ?? ""}`));
        for (const n of fresh) notifyStatement(n.case_id, queryClient);
        try {
          localStorage.setItem(`${SEEN}:${address}`, JSON.stringify(list.map((n) => `${n.case_id}:${n.statement_at ?? ""}`).slice(0, 200)));
        } catch {
          /* memory only */
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session, address, queryClient]);
}

const DISMISSED = "tavrn.terms.dismissed";

/** Versions the user postponed in `notice` mode, per account. */
export function dismissedVersion(address: string): number | null {
  try {
    const v = Number(localStorage.getItem(`${DISMISSED}:${address}`));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function dismissVersion(address: string, version: number) {
  try {
    localStorage.setItem(`${DISMISSED}:${address}`, String(version));
  } catch {
    /* private mode: the dialog comes back next time */
  }
}

/** `true` when the dialog must show: pending, and in `notice` mode not postponed for this version. */
export function shouldAsk(status: { pending: boolean; mode: string; current_version?: number | null }, dismissed: number | null, inSetup = false): boolean {
  if (!status.pending || !status.current_version) return false;
  // `require` blocks everything, the sign-in setup too; a notice waits until the setup is done.
  if (status.mode === "require") return true;
  return !inSetup && dismissed !== status.current_version;
}

/** Sign-in and setup screens (password, second factor, recovery codes and key). */
const SETUP_PATHS = ["/login", "/encryption", "/sso/callback", "/connect"];

export function TermsGate() {
  const t = useT();
  const signedIn = useAuth((s) => !!s.token);
  const address = useAuth((s) => s.user?.address ?? "");
  const queryClient = useQueryClient();
  const { pathname } = useLocation();
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  // Once per session (account and device), not again with every token refresh.
  useMissedStatements(useSessionKey(), address);
  const status = useQuery({
    queryKey: ["terms-status", address],
    queryFn: () => api.legal.termsStatus(),
    enabled: signedIn && !!address,
    refetchInterval: 5 * 60_000,
    // Older nodes have no route (404): nothing to accept.
    retry: (n, e) => !(e instanceof TavrnApiError && e.status === 404) && n < 2,
  });
  const ask = !!status.data && !hidden && shouldAsk(status.data, dismissedVersion(address), SETUP_PATHS.some((p) => pathname.startsWith(p)));
  const terms = useQuery({ queryKey: ["legal", "page", "terms"], queryFn: () => api.legal.page("terms"), enabled: ask });
  useEffect(() => setHidden(false), [status.data?.current_version]);
  if (!ask || !status.data) return null;
  const required = status.data.mode === "require";
  const version = status.data.current_version ?? 0;
  const accept = async () => {
    setBusy(true);
    try {
      await api.legal.acceptTerms({ version });
      await queryClient.invalidateQueries({ queryKey: ["terms-status"] });
      // Everything refused meanwhile loads again.
      if (required) await queryClient.invalidateQueries();
    } catch (e) {
      toastError(e);
      await status.refetch();
    } finally {
      setBusy(false);
    }
  };
  const decline = () => {
    if (required) {
      void signOut().catch(() => undefined);
      return;
    }
    dismissVersion(address, version);
    setHidden(true);
  };
  return (
    <Dialog title={t(status.data.accepted_version ? "legal.terms.updated_title" : "legal.terms.title")} open onClose={required ? () => undefined : decline}>
      <div className="space-y-3 text-sm" data-testid="terms-dialog">
        <p className="text-fg-1">{t(required ? "legal.terms.required_text" : "legal.terms.notice_text")}</p>
        <div className="max-h-[45dvh] overflow-y-auto rounded-md border border-line bg-bg-0 p-3">
          {terms.data ? <LegalDocumentView markdown={terms.data.markdown} /> : <p className="text-fg-2">{t("common.loading")}</p>}
        </div>
        <p className="text-xs text-fg-2">{t("legal.version_only", { version })}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={decline} data-testid="terms-decline">
            {t(required ? "legal.terms.decline_logout" : "legal.terms.later")}
          </Button>
          <Button onClick={() => void accept()} disabled={busy} data-testid="terms-accept">
            {t("legal.terms.accept")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
