// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { TavrnApiError } from "@tavrn/sdk";
import { publicApi } from "../lib/api";
import { useAuth } from "../stores/auth";
import { useT } from "../i18n";
import { Button } from "../components/ui";
import { Card } from "./PasswordResetPages";

type State = "verifying" | "done" | "invalid" | "failed";

// One request per token for the lifetime of the page: the token is single-use, so a second call (StrictMode's double
// effect, a remount) would turn a confirmed address into "link invalid". A retry after a failure starts a new one.
const pending = new Map<string, Promise<void>>();
function verifyOnce(token: string): Promise<void> {
  let p = pending.get(token);
  if (!p) {
    p = publicApi.auth.verifyEmail(token);
    pending.set(token, p);
    p.catch(() => {
      if (pending.get(token) === p) pending.delete(token);
    });
  }
  return p;
}

const LINK_BUTTON = "inline-flex min-h-10 w-full items-center justify-center rounded-md bg-accent px-3 text-sm font-medium text-accent-text transition hover:bg-accent-hover";

/**
 * `/verify-email?token=…`: the link of the confirmation mail (PROTOCOL.md §5a.3, `POST /auth/verify-email`). Confirms
 * the address on the node that serves this page, then leads to the sign-in (or into the app with a session).
 */
export function VerifyEmailPage() {
  const t = useT();
  const [params] = useSearchParams();
  const token = params.get("token")?.trim() ?? "";
  const signedIn = useAuth((s) => !!s.token);
  const [state, setState] = useState<State>("verifying");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!token) return;
    let live = true;
    setState("verifying");
    verifyOnce(token).then(
      () => live && setState("done"),
      // 400 (unknown, used or expired) and other refusals of the node: the link is no good. Anything else (no
      // connection, the node or a proxy failing) may pass on a retry.
      (err: unknown) => live && setState(err instanceof TavrnApiError && err.status >= 400 && err.status < 500 && err.status !== 429 ? "invalid" : "failed"),
    );
    return () => {
      live = false;
    };
  }, [token, attempt]);

  const signIn = (
    <Link to="/login" className={`mt-4 ${LINK_BUTTON}`}>
      {t("auth.login")}
    </Link>
  );

  if (!token) {
    return (
      <Card title={t("verify_email.title")}>
        <p className="mt-2 text-sm text-fg-1">{t("verify_email.no_token")}</p>
        {signIn}
      </Card>
    );
  }
  if (state === "verifying") {
    return (
      <Card title={t("verify_email.title")}>
        <p role="status" className="mt-2 text-sm text-fg-1">
          {t("verify_email.verifying")}
        </p>
      </Card>
    );
  }
  if (state === "done") {
    return (
      <Card title={t("verify_email.done_title")}>
        <p role="status" className="mt-2 text-sm text-fg-1">
          {signedIn ? t("verify_email.done_session") : t("verify_email.done")}
        </p>
        {signedIn ? (
          <Link to="/" className={`mt-4 ${LINK_BUTTON}`}>
            {t("common.continue")}
          </Link>
        ) : (
          signIn
        )}
      </Card>
    );
  }
  if (state === "invalid") {
    return (
      <Card title={t("verify_email.invalid_title")}>
        <p role="alert" className="mt-2 text-sm text-fg-1">
          {t("verify_email.invalid")}
        </p>
        {signIn}
      </Card>
    );
  }
  return (
    <Card title={t("verify_email.failed_title")}>
      <p role="alert" className="mt-2 text-sm text-fg-1">
        {t("verify_email.failed")}
      </p>
      <Button className="mt-4 w-full" onClick={() => setAttempt((n) => n + 1)}>
        {t("verify_email.retry")}
      </Button>
    </Card>
  );
}
