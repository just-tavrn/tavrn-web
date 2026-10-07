// SPDX-License-Identifier: Apache-2.0
import { useT } from "../../i18n";

/** "Step 2 of 4" of the registration wizard. */
export function Steps({ current, total = 4 }: { current: number; total?: number }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2" data-testid="wizard-steps">
      <ol className="flex flex-1 gap-1" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          <li key={i} className={`h-1 flex-1 rounded-full ${i < current ? "bg-accent" : "bg-bg-3"}`} />
        ))}
      </ol>
      <span className="text-xs text-fg-2">{t("wizard.step", { current, total })}</span>
    </div>
  );
}
