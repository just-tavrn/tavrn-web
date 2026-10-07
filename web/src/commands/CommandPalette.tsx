// SPDX-License-Identifier: Apache-2.0
import type { CommandArg, CommandDefinition } from "./types";
import { usage } from "./registry";
import { useT } from "../i18n";
import { BotBadge } from "../components/Badges";

/** Localized description of a command (built-ins: `cmd.<name>.description`, else the definition's text). */
export function commandDescription(def: CommandDefinition, t: ReturnType<typeof useT>): string {
  if (def.source !== "builtin") return def.description;
  const key = `cmd.${def.name}.description`;
  const text = t(key);
  return text === key ? def.description : text;
}

export function argLabel(name: string, t: ReturnType<typeof useT>): string {
  const key = `cmd.arg.${name}`;
  const text = t(key);
  return text === key ? name : text;
}

/** The list of matching commands while the name is typed (`role="listbox"`). */
export function CommandList({ id, items, selected, onPick, onHover }: { id: string; items: CommandDefinition[]; selected: number; onPick: (def: CommandDefinition) => void; onHover: (index: number) => void }) {
  const t = useT();
  if (items.length === 0) {
    return (
      <div className="mb-2 rounded-lg border border-line bg-bg-1 px-3 py-2 text-sm text-fg-2" data-testid="command-palette">
        {t("cmd.none")}
      </div>
    );
  }
  return (
    <ul id={id} role="listbox" aria-label={t("cmd.palette")} className="mb-2 max-h-64 overflow-y-auto rounded-lg border border-line bg-bg-1 py-1 shadow-lg" data-testid="command-palette">
      {items.map((def, i) => (
        <li
          key={`${def.source}:${def.id || def.name}`}
          id={`${id}-${i}`}
          role="option"
          aria-selected={i === selected}
          data-testid="command-option"
          data-name={def.name}
          data-source={def.source}
          data-ref={def.ref}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(def);
          }}
          onMouseEnter={() => onHover(i)}
          className={`flex min-h-10 cursor-pointer items-baseline gap-2 px-3 py-1.5 text-sm ${i === selected ? "bg-accent-soft text-fg-0" : "text-fg-1"}`}
        >
          <span className="shrink-0 font-mono font-semibold">{usage(def, (a) => argLabel(a, t))}</span>
          {def.qualifier && (
            <span className="shrink-0 text-xs text-fg-1" data-testid="command-qualifier">
              · {def.qualifier}
            </span>
          )}
          <span className="truncate text-xs text-fg-2">{commandDescription(def, t)}</span>
          {def.source === "app" && (
            <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-fg-2">
              {!def.qualifier && def.application && <span className="max-w-24 truncate">{def.application.name}</span>}
              <BotBadge />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The argument hint while arguments are typed: usage with the current argument highlighted. */
export function ArgumentHint({ def, active, suggestions, selected, onPick, error }: { def: CommandDefinition; active: number; suggestions: { value: string; label: string }[]; selected: number; onPick: (value: string) => void; error?: string }) {
  const t = useT();
  const arg: CommandArg | undefined = def.args[active];
  return (
    <div className="mb-2 rounded-lg border border-line bg-bg-1 px-3 py-2 text-sm" data-testid="command-hint">
      <div className="flex flex-wrap items-baseline gap-1 font-mono">
        <span className="font-semibold text-fg-0">/{def.name}</span>
        {def.source === "app" && def.application && (
          <span className="font-sans text-xs text-fg-2" data-testid="command-hint-app">
            · {def.application.name} <BotBadge />
          </span>
        )}
        {def.args.map((a, i) => (
          <span key={a.name} className={i === active ? "rounded bg-accent-soft px-1 text-accent" : "text-fg-2"}>
            {a.required ? `<${argLabel(a.name, t)}>` : `[${argLabel(a.name, t)}]`}
          </span>
        ))}
      </div>
      <p className="mt-1 text-xs text-fg-2">{arg ? `${argLabel(arg.name, t)}: ${t(`cmd.arg.${arg.name}.hint`) === `cmd.arg.${arg.name}.hint` ? arg.description : t(`cmd.arg.${arg.name}.hint`)}` : commandDescription(def, t)}</p>
      {error && (
        <p className="mt-1 text-xs text-danger" role="alert" data-testid="command-error">
          {error}
        </p>
      )}
      {suggestions.length > 0 && (
        <ul role="listbox" aria-label={t("cmd.suggestions")} className="mt-1 max-h-40 overflow-y-auto" data-testid="command-suggestions">
          {suggestions.map((s, i) => (
            <li
              key={s.value}
              role="option"
              aria-selected={i === selected}
              data-testid="command-suggestion"
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(s.value);
              }}
              className={`min-h-8 cursor-pointer rounded px-2 py-1 text-sm ${i === selected ? "bg-accent-soft text-fg-0" : "text-fg-1"}`}
            >
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** `/help`: the commands available here (local, nothing is sent). */
export function CommandHelp({ items, onClose }: { items: CommandDefinition[]; onClose: () => void }) {
  const t = useT();
  return (
    <div className="mb-2 rounded-lg border border-line bg-bg-1 px-3 py-2 text-sm" data-testid="command-help">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-semibold text-fg-0">{t("cmd.help.title")}</span>
        <button type="button" onClick={onClose} aria-label={t("common.close")} className="min-h-8 min-w-8 rounded text-fg-2 hover:bg-bg-3">
          ×
        </button>
      </div>
      <ul className="space-y-0.5">
        {items.map((def) => (
          <li key={`${def.source}:${def.id || def.name}`} className="flex flex-wrap gap-2">
            <span className="font-mono text-fg-0">{usage(def, (a) => argLabel(a, t))}</span>
            <span className="text-xs text-fg-2">{commandDescription(def, t)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
