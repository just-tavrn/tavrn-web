// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../lib/api";
import { useT } from "../i18n";
import { describeError } from "../stores/toasts";
import { Button, ErrorText, Field, Input } from "../components/ui";
import { LegalLink } from "../components/legal/LegalLink";

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div role="main" className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-bg-1 p-6 shadow-xl">
        <h1 className="text-lg font-semibold">{title}</h1>
        {children}
        <LegalLink className="mt-4" />
      </div>
    </div>
  );
}

export function ForgotPasswordPage() {
  const t = useT();
  const [account, setAccount] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card title={t("auth.forgot_title")}>
      <p className="mt-1 text-sm text-fg-2">{t("auth.forgot_hint")}</p>
      {sent ? (
        <p role="status" className="mt-4 text-sm text-ok">{t("auth.forgot_sent")}</p>
      ) : (
        <form
          className="mt-4 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await api.auth.forgotPassword(account);
              setSent(true);
            } catch (err) {
              setError(describeError(err));
            }
          }}
        >
          <Field label={t("auth.account")}>
            <Input value={account} onChange={(e) => setAccount(e.target.value)} required autoFocus />
          </Field>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" className="w-full">
            {t("auth.send_link")}
          </Button>
        </form>
      )}
      <Link to="/login" className="mt-4 block text-center text-sm text-fg-2 hover:text-fg-0">
        {t("auth.back_to_login")}
      </Link>
    </Card>
  );
}

export function ResetPasswordPage() {
  const t = useT();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card title={t("auth.reset_title")}>
      {done ? (
        <p role="status" className="mt-4 text-sm text-ok">{t("auth.reset_done")}</p>
      ) : (
        <form
          className="mt-4 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            if (password !== repeat) return setError(t("auth.password_mismatch"));
            try {
              await api.auth.resetPassword(token, password);
              setDone(true);
            } catch (err) {
              setError(describeError(err));
            }
          }}
        >
          <Field label={t("user.new_password")} hint={t("auth.password_hint")}>
            <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
          </Field>
          <Field label={t("auth.password_repeat")}>
            <Input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
          </Field>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" className="w-full">
            {t("auth.reset_action")}
          </Button>
        </form>
      )}
      <Link to="/login" className="mt-4 block text-center text-sm text-fg-2 hover:text-fg-0">
        {t("auth.back_to_login")}
      </Link>
    </Card>
  );
}
