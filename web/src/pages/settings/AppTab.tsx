// SPDX-License-Identifier: Apache-2.0
/** Settings → App, desktop app only: version, the home node (node picker) and the signed updates. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { platform, type AvailableUpdate } from "../../platform";
import { useT } from "../../i18n";
import { describeError } from "../../stores/toasts";
import { Button, ErrorText } from "../../components/ui";
import { Section } from "./common";

type UpdateState = { kind: "idle" } | { kind: "checking" } | { kind: "current" } | { kind: "available"; update: AvailableUpdate } | { kind: "installing"; update: AvailableUpdate };

export function AppTab() {
  const t = useT();
  const p = platform();
  const version = useQuery({ queryKey: ["app-version"], queryFn: () => p.appVersion(), staleTime: Infinity });
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    if (!p.updater) return;
    setError(null);
    setState({ kind: "checking" });
    try {
      const update = await p.updater.check();
      setState(update ? { kind: "available", update } : { kind: "current" });
    } catch (e) {
      setError(describeError(e));
      setState({ kind: "idle" });
    }
  };

  const install = async (update: AvailableUpdate) => {
    setError(null);
    setState({ kind: "installing", update });
    try {
      // Restarts the app on success.
      await update.install();
    } catch (e) {
      setError(describeError(e));
      setState({ kind: "available", update });
    }
  };

  return (
    <div className="space-y-4">
      <Section title={t("desktop.section_title")}>
        <p className="text-sm text-fg-1" data-testid="app-version">
          {version.data ? t("desktop.version", { version: version.data }) : "…"}
        </p>
      </Section>
      <Section title={t("desktop.node")} description={t("desktop.node_hint")}>
        <p className="break-all font-mono text-sm text-fg-0" data-testid="app-node">
          {p.node?.current() ?? "—"}
        </p>
        <Link to="/node" className="inline-flex min-h-10 items-center rounded-md border border-line px-3 text-sm text-fg-0 hover:bg-bg-3">
          {t("desktop.change_node")}
        </Link>
      </Section>
      <Section title={t("desktop.updates")} description={p.updater ? t("desktop.updates_hint") : undefined}>
        {!p.updater ? (
          <p className="text-sm text-fg-2" data-testid="app-updates-unconfigured">
            {t("desktop.updates_unconfigured")}
          </p>
        ) : (
          <>
            {state.kind === "current" && (
              <p role="status" className="text-sm text-fg-1" data-testid="app-up-to-date">
                {t("desktop.up_to_date")}
              </p>
            )}
            {(state.kind === "available" || state.kind === "installing") && (
              <div className="space-y-2" data-testid="app-update">
                <p role="status" className="text-sm font-semibold text-fg-0">
                  {t("desktop.update_available", { version: state.update.version })}
                </p>
                {state.update.notes && <p className="whitespace-pre-wrap text-xs text-fg-2">{state.update.notes}</p>}
                <Button disabled={state.kind === "installing"} onClick={() => void install(state.update)}>
                  {state.kind === "installing" ? t("desktop.installing") : t("desktop.install_update")}
                </Button>
              </div>
            )}
            {state.kind !== "available" && state.kind !== "installing" && (
              <Button variant="ghost" className="border border-line" disabled={state.kind === "checking"} onClick={() => void check()}>
                {state.kind === "checking" ? t("desktop.checking") : t("desktop.check_updates")}
              </Button>
            )}
          </>
        )}
        <ErrorText>{error}</ErrorText>
      </Section>
    </div>
  );
}
