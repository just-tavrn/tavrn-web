// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState } from "react";
import type { MlsManager } from "@tavrn/e2ee";
import { useT } from "../i18n";
import { renderMarkdown } from "../lib/markdown";
import { useInteractions, type InteractionNotice } from "../stores/interactions";
import { BotBadge } from "./Badges";

/**
 * The invoker's view of application commands besides messages (tavrn-protocol/APPLICATIONS.md §5.7): "… is thinking"
 * while an interaction is deferred, ephemeral replies marked "only you can see this", and error notices. In
 * encrypted conversations ephemeral replies are ciphertext of the bot's device and are decrypted here.
 */
export function InteractionNotices({ conversationId, qualified, encrypted, mls }: { conversationId: string; qualified: string; encrypted: boolean; mls: MlsManager | null }) {
  const t = useT();
  const all = useInteractions((s) => s.notices);
  const notices = useMemo(() => all.filter((n) => n.conversationId === conversationId), [all, conversationId]);
  useEffect(() => {
    const timer = window.setInterval(() => useInteractions.getState().prune(), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  if (notices.length === 0) return null;
  return (
    <ul className="mx-4 mb-1 space-y-1" data-testid="interaction-notices" aria-live="polite">
      {notices.map((n) => (
        <li key={n.key} className="rounded-md border border-line bg-bg-1 px-3 py-2 text-sm">
          {n.kind === "thinking" ? (
            <p className="flex items-center gap-2 text-fg-1" data-testid="interaction-thinking" data-interaction={n.interactionId}>
              <span className="font-medium">{n.application.name}</span>
              <BotBadge />
              <span className="animate-pulse text-fg-2">{t("interactions.thinking", { name: n.application.name })}</span>
            </p>
          ) : (
            <Notice notice={n} qualified={qualified} encrypted={encrypted} mls={mls} label={t("interactions.only_you")} close={t("common.close")} />
          )}
        </li>
      ))}
    </ul>
  );
}

function Notice({ notice: n, qualified, encrypted, mls, label, close }: { notice: InteractionNotice; qualified: string; encrypted: boolean; mls: MlsManager | null; label: string; close: string }) {
  const t = useT();
  const [body, setBody] = useState<string | null>(() => (n.kind === "error" ? (n.text ?? "") : plainBody(n.content)));
  useEffect(() => {
    if (n.kind !== "ephemeral" || !encrypted || typeof n.content !== "string") return;
    if (!mls) return;
    let alive = true;
    void mls
      // The signed context of the answer must name this interaction (APPLICATIONS.md §5.7, ENCRYPTION.md §5.2).
      .decrypt(qualified, { id: `ephemeral:${n.key}`, author: n.application.bot, device_id: n.deviceId ?? null, epoch: n.epoch ?? null, content: n.content, interaction: { id: n.interactionId } })
      .then((r) => alive && setBody(r.ok ? plainBody(r.content) : null));
    return () => {
      alive = false;
    };
  }, [n, encrypted, mls, qualified]);
  const html = useMemo(() => (n.kind === "ephemeral" && body ? renderMarkdown(body) : null), [n.kind, body]);
  return (
    <div data-testid={n.kind === "error" ? "interaction-error" : "interaction-ephemeral"} data-interaction={n.interactionId} role={n.kind === "error" ? "alert" : undefined}>
      <div className="mb-0.5 flex items-center gap-2 text-xs text-fg-2">
        <span className="font-medium text-fg-1">{n.application.name}</span>
        <BotBadge />
        <span className="flex-1">{n.kind === "error" ? t("interactions.error") : label}</span>
        <button type="button" onClick={() => useInteractions.getState().dismiss(n.key)} aria-label={close} className="min-h-6 min-w-6 rounded text-fg-2 hover:bg-bg-3 hover:text-fg-0" data-testid="interaction-dismiss">
          ×
        </button>
      </div>
      {n.kind === "error" ? (
        <p className="text-danger">{body}</p>
      ) : html ? (
        // Rendered through the message Markdown sanitizer.
        <div className="markdown break-words text-fg-0" data-testid="interaction-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <p className="italic text-fg-2">{body === null && encrypted ? t("messages.encrypted_short") : ""}</p>
      )}
    </div>
  );
}

function plainBody(content: unknown): string | null {
  if (!content || typeof content !== "object") return null;
  const c = content as { type?: unknown; body?: unknown };
  return (c.type === "text" || c.type === "action") && typeof c.body === "string" ? c.body : null;
}
