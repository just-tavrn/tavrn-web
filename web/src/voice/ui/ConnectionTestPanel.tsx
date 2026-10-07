// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useT } from "../../i18n";
import { api } from "../../lib/api";
import { Button } from "../../components/ui";
import { describeError } from "../../stores/toasts";
import type { ProbeResult, TestReport } from "../connectionTest";

/** Label of a probe row: "UDP 203.0.113.7", "TCP …", "TURN (UDP)", "Any path". */
function probeLabel(r: ProbeResult, t: ReturnType<typeof useT>): string {
  switch (r.probe.kind) {
    case "any":
      return t("voice.test.any");
    case "udp":
      return `UDP ${r.probe.address}`;
    case "tcp":
      return `TCP ${r.probe.address}`;
    case "turn_udp":
      return t("voice.test.turn_udp");
    case "turn_tls":
      return t("voice.test.turn_tls");
  }
}

/**
 * "Test connection" in the voice settings (VOICE.md §10.4): which paths to the node's media server work from
 * this device, each with the candidate type that connected and the round trip, and for failed paths what the
 * operator has to check (router forwarding, NAT loopback, IPv6 publishing, the TCP port, TURN).
 */
export function ConnectionTestPanel() {
  const t = useT();
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<TestReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const { runConnectionTest } = await import("../connectionTest");
      setReport(await runConnectionTest(api, (r) => setReport(r)));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setRunning(false);
    }
  };

  const rtc = report?.rtc;
  const anyOk = report?.results.some((r) => r.ok) ?? false;
  return (
    <div className="space-y-3" data-testid="connection-test">
      <Button onClick={() => void run()} disabled={running} data-testid="connection-test-run">
        {running ? t("voice.test.running") : t("voice.test.run")}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {rtc && (
        <p className="text-xs text-fg-2" data-testid="connection-test-config">
          {t(`voice.test.mode_${rtc.mode === "explicit" ? "explicit" : rtc.mode === "stun" ? "stun" : "local"}`, { addresses: rtc.addresses.join(", ") })}{" "}
          {t("voice.test.ports", { udp: rtc.udp_ports, tcp: rtc.tcp_port ? String(rtc.tcp_port) : t("voice.test.off") })}
          {rtc.ice_aliases.length > 0 && <> {t("voice.test.aliases", { addresses: rtc.ice_aliases.join(", ") })}</>}
        </p>
      )}
      {report && (
        <ul className="divide-y divide-line rounded-lg border border-line" data-testid="connection-test-results">
          {report.results.map((r, i) => (
            <li key={i} className="space-y-1 px-3 py-2 text-sm" data-testid="connection-test-row" data-kind={r.probe.kind} data-ok={r.ok}>
              <div className="flex items-center gap-2">
                <span className={r.ok ? "text-ok" : "text-danger"} aria-hidden="true">
                  {r.ok ? "✓" : "✗"}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{probeLabel(r, t)}</span>
                <span className="text-xs text-fg-2">
                  {r.ok ? (r.pair ? t("voice.test.via", { type: r.pair.localType === "relay" ? "TURN" : `${r.pair.protocol.toUpperCase()} ${r.pair.remoteType}`, rtt: r.pair.rttMs ?? "–" }) : t("voice.test.ok")) : t("voice.test.failed")}
                </span>
              </div>
              {r.hint && <p className="text-xs text-fg-1">{t(`voice.test.hint.${r.hint}`, { udp: rtc?.udp_ports ?? "", tcp: rtc?.tcp_port ?? "" })}</p>}
            </li>
          ))}
          {running && <li className="px-3 py-2 text-xs text-fg-2">{t("voice.test.running")}</li>}
        </ul>
      )}
      {report && !running && (
        <p className={`text-sm ${anyOk ? "text-ok" : "text-danger"}`} data-testid="connection-test-summary">
          {anyOk ? t("voice.test.summary_ok") : report.signaling ? t("voice.test.summary_no_media") : t("voice.test.summary_no_signaling")}
        </p>
      )}
    </div>
  );
}
