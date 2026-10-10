// SPDX-License-Identifier: Apache-2.0
import { useNavigate } from "react-router";
import { useT } from "../i18n";
import { useToasts } from "../stores/toasts";

export function Toaster() {
  const t = useT();
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  const navigate = useNavigate();
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
      {toasts.map((x) => (
        <div
          key={x.id}
          role={x.kind === "error" ? "alert" : "status"}
          data-testid={x.testId}
          className={`pointer-events-auto w-full max-w-md rounded-md border px-4 py-3 text-sm shadow-lg ${x.kind === "error" ? "border-danger/50 bg-bg-1 text-danger" : x.kind === "warning" ? "border-warn/50 bg-bg-1 text-warn" : "border-accent/40 bg-bg-1 text-fg-0"}`}
        >
          <div className="flex items-start gap-3">
            {x.path ? (
              // Notifications jump to their conversation.
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  dismiss(x.id);
                  navigate(x.path!);
                }}
                aria-label={t("notify.open", { title: x.title })}
              >
                <p className="truncate font-medium">{x.title}</p>
                {x.detail && <p className="mt-0.5 line-clamp-2 text-fg-1">{x.detail}</p>}
              </button>
            ) : (
              <div className="flex-1">
                <p className="font-medium">{x.title}</p>
                {x.detail && <p className="mt-0.5 text-fg-1">{x.detail}</p>}
              </div>
            )}
            {x.action && (
              <button
                type="button"
                onClick={() => {
                  dismiss(x.id);
                  x.action!.run();
                }}
                className="-my-1 min-h-8 shrink-0 rounded px-2 font-medium text-accent underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {x.action.label}
              </button>
            )}
            <button type="button" aria-label={t("common.close")} onClick={() => dismiss(x.id)} className="min-h-6 min-w-6 text-fg-2 hover:text-fg-0">
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
