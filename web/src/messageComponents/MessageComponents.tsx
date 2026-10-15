// SPDX-License-Identifier: Apache-2.0
/**
 * Buttons and selects under a bot's message (tavrn-protocol/APPLICATIONS.md §5.10). The client draws everything from
 * its own controls and palette: a bot chooses words, an emoji and one of five styles, never markup, colours or
 * images. The area never leaves the message: rows wrap, labels are cut with an ellipsis (the full text in the
 * tooltip), a select takes the full width on narrow screens, and the whole area has a hard height limit.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Button as ComponentButton, ButtonStyle, Message, Row, Select as ComponentSelect } from "@tavrn/sdk";
import { useT } from "../i18n";
import { describeError } from "../stores/toasts";
import { PREVIEW_REFUSED } from "../lib/previewGuard";
import { stripBidi, urlHost } from "../lib/untrusted";
import { Button, Dialog } from "../components/ui";
import { MessageNotices } from "../components/InteractionNotices";
import { ComponentEmoji, emojiName } from "./ComponentEmoji";
import { useComponentsEnv, useUnusableComponents } from "./context";
import { defaultValues } from "./model";

const BUTTON_BASE =
  "inline-flex min-h-10 min-w-10 max-w-full items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors motion-reduce:transition-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

/** The fixed palette (design tokens): text contrast ≥ 4.5:1 on every surface, the border of secondary ≥ 3:1. */
export const BUTTON_STYLES: Record<ButtonStyle, string> = {
  primary: "bg-accent text-accent-text hover:bg-accent-hover",
  secondary: "border border-line-strong bg-bg-3 text-fg-0 hover:bg-line",
  success: "bg-ok text-accent-text hover:brightness-110",
  danger: "bg-danger-solid text-white hover:bg-danger-solid-hover",
  link: "border border-line-strong bg-bg-3 text-fg-0 hover:bg-line",
};

/** The component area of one message; `rows` passed the rules of `componentsOf`. */
export function MessageComponents({ m, rows }: { m: Message; rows: Row[] }) {
  const t = useT();
  const env = useComponentsEnv();
  // The node said the components cannot be used any more: expired (410) or gone with their application (404).
  const unusable = useUnusableComponents((s) => (env ? s.state[`${env.conversationId}:${m.id}`] : undefined));
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const usable = !!env && env.canUse && !unusable;
  const run = async (customId: string, values: string[] | null) => {
    if (!env || !usable || pending) return;
    setPending(customId);
    setError(null);
    try {
      await env.invoke(m, customId, values);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "component.expired") useUnusableComponents.getState().mark(env.conversationId, m.id, "expired");
      else if (code === "component.not_found") useUnusableComponents.getState().mark(env.conversationId, m.id, "gone");
      // The role preview refused the request before it left and said so already.
      else if (code !== PREVIEW_REFUSED) setError(describeError(e));
    } finally {
      setPending(null);
    }
  };
  const note = unusable ? t(`components.${unusable}`) : env && !env.canUse ? t("components.forbidden") : null;
  return (
    <div
      className="mt-1 max-h-[28rem] max-w-full space-y-2 overflow-y-auto overflow-x-hidden overscroll-contain py-0.5"
      data-testid="message-components"
      data-unusable={unusable}
      aria-describedby={error ? errorId : undefined}
    >
      {rows.map((row, r) => (
        <div key={r} className="flex min-w-0 max-w-full flex-wrap gap-2" data-testid="component-row">
          {row.components.map((c, i) =>
            c.type === "select" ? (
              <SelectControl key={c.custom_id} select={c} usable={usable} pending={pending === c.custom_id} blocked={!!pending} onPick={(values) => void run(c.custom_id, values)} />
            ) : (
              <ButtonControl key={c.custom_id ?? `link-${i}`} button={c} usable={usable} pending={!!c.custom_id && pending === c.custom_id} blocked={!!pending} onPress={() => c.custom_id && void run(c.custom_id, null)} />
            ),
          )}
        </div>
      ))}
      {note && (
        <p className="text-xs text-fg-2" data-testid={unusable ? `components-${unusable}` : "components-forbidden"}>
          {note}
        </p>
      )}
      {error && (
        // Announced politely next to the message (§5.10.1).
        <p id={errorId} role="status" className="text-xs text-danger" data-testid="components-error">
          {error}
        </p>
      )}
    </div>
  );
}

function ButtonControl({ button: b, usable, pending, blocked, onPress }: { button: ComponentButton; usable: boolean; pending: boolean; blocked: boolean; onPress: () => void }) {
  const t = useT();
  const [confirm, setConfirm] = useState(false);
  const label = stripBidi(b.label ?? "");
  const isLink = b.style === "link";
  // Link buttons never reach the node, so they stay usable on expired messages; disabled ones never act.
  const inactive = !!b.disabled || (!isLink && (!usable || blocked));
  const name = label || (b.emoji ? emojiName(b.emoji) : "");
  return (
    <>
      <button
        type="button"
        className={`${BUTTON_BASE} ${BUTTON_STYLES[b.style]}`}
        title={isLink && b.url ? `${label ? `${label} – ` : ""}${urlHost(b.url)}` : label || undefined}
        aria-label={label ? undefined : isLink ? t("components.link_named", { name, host: urlHost(b.url ?? "") }) : name}
        aria-disabled={inactive || undefined}
        aria-busy={pending || undefined}
        aria-haspopup={isLink ? "dialog" : undefined}
        data-testid="component-button"
        data-style={b.style}
        data-custom-id={b.custom_id}
        onClick={() => {
          if (inactive) return;
          if (isLink) setConfirm(true);
          else onPress();
        }}
      >
        {pending ? <Spinner /> : b.emoji && <ComponentEmoji value={b.emoji} />}
        {label && <span className="min-w-0 truncate">{label}</span>}
        {isLink && (
          <span aria-hidden="true" className="shrink-0 text-xs">
            ↗
          </span>
        )}
        {isLink && label && <span className="sr-only">{t("components.link_hint", { host: urlHost(b.url ?? "") })}</span>}
      </button>
      {isLink && !!b.url && <LinkConfirm url={b.url} open={confirm} onClose={() => setConfirm(false)} />}
    </>
  );
}

function Spinner() {
  return <span aria-hidden="true" className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" data-testid="component-spinner" />;
}

/** Before a link button opens its page: where it goes, in full (the label alone could say anything). */
function LinkConfirm({ url, open, onClose }: { url: string; open: boolean; onClose: () => void }) {
  const t = useT();
  return (
    <Dialog title={t("components.link_title")} open={open} onClose={onClose}>
      <p className="text-sm text-fg-1">{t("components.link_text", { host: urlHost(url) })}</p>
      <p className="mt-2 break-all rounded-md border border-line bg-bg-0 px-3 py-2 font-mono text-xs text-fg-0" data-testid="component-link-url">
        {stripBidi(url)}
      </p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer nofollow ugc"
          onClick={onClose}
          className="inline-flex min-h-10 items-center justify-center rounded-md bg-accent px-3 text-sm font-medium text-accent-text hover:bg-accent-hover"
          data-testid="component-link-open"
        >
          {t("components.link_open")}
        </a>
      </div>
    </Dialog>
  );
}

/**
 * A select as a disclosure with an inline listbox (it grows the message instead of floating over others, so it can
 * never leave the message). One choice invokes at once; several choices need the confirm button.
 */
function SelectControl({ select: s, usable, pending, blocked, onPick }: { select: ComponentSelect; usable: boolean; pending: boolean; blocked: boolean; onPick: (values: string[]) => void }) {
  const t = useT();
  const max = s.max ?? 1;
  const min = s.min ?? 1;
  const multi = max > 1;
  const initial = useMemo(() => defaultValues(s.options, max), [s.options, max]);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string[]>(initial);
  const [active, setActive] = useState(0);
  // A new version of the message (an update by the bot) starts from its defaults again.
  useEffect(() => setChosen(initial), [initial]);
  const id = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inactive = !!s.disabled || !usable || blocked;
  const placeholder = stripBidi(s.placeholder || "") || t(multi ? "components.select_many" : "components.select_one");
  const chosenLabels = s.options.filter((o) => chosen.includes(o.value)).map((o) => stripBidi(o.label));
  const summary = chosenLabels.length ? chosenLabels.join(", ") : placeholder;
  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const toggle = (value: string) => {
    if (!multi) {
      setChosen([value]);
      close();
      onPick([value]);
      return;
    }
    setChosen((cur) => (cur.includes(value) ? cur.filter((v) => v !== value) : cur.length >= max ? cur : [...cur, value]));
  };
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const last = s.options.length - 1;
    if (e.key === "ArrowDown") setActive((a) => Math.min(last, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(last);
    else if (e.key === "Enter" || e.key === " ") toggle(s.options[active]!.value);
    else if (e.key === "Escape") close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  useEffect(() => {
    if (open) document.getElementById(`${id}-opt-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, id]);
  const countOk = chosen.length >= min && chosen.length <= max;
  return (
    <div className="w-full min-w-0 max-w-md" data-testid="component-select" data-custom-id={s.custom_id}>
      <button
        ref={triggerRef}
        type="button"
        className="flex min-h-10 w-full min-w-0 items-center gap-2 rounded-md border border-line-strong bg-bg-0 px-3 text-left text-sm text-fg-0 hover:bg-bg-3 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-disabled={inactive || undefined}
        aria-busy={pending || undefined}
        title={summary}
        data-testid="component-select-trigger"
        onClick={() => {
          if (inactive) return;
          if (!open) setActive(Math.max(0, s.options.findIndex((o) => chosen.includes(o.value))));
          setOpen((v) => !v);
        }}
      >
        <span className={`min-w-0 flex-1 truncate ${chosenLabels.length ? "" : "text-fg-2"}`}>{summary}</span>
        {pending ? (
          <Spinner />
        ) : (
          <span aria-hidden="true" className="shrink-0 text-xs text-fg-2">
            {open ? "▴" : "▾"}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 rounded-md border border-line bg-bg-1 p-1">
          <ul
            ref={listRef}
            id={`${id}-list`}
            role="listbox"
            tabIndex={0}
            aria-label={placeholder}
            aria-multiselectable={multi || undefined}
            aria-activedescendant={`${id}-opt-${active}`}
            className="max-h-60 overflow-y-auto overscroll-contain outline-none focus-visible:outline-2 focus-visible:outline-accent"
            onKeyDown={onKey}
            data-testid="component-select-list"
          >
            {s.options.map((o, i) => {
              const selected = chosen.includes(o.value);
              const full = multi && !selected && chosen.length >= max;
              return (
                <li
                  key={o.value}
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={full || undefined}
                  title={stripBidi(o.description ? `${o.label} – ${o.description}` : o.label)}
                  className={`flex min-h-10 cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm ${i === active ? "bg-bg-3 ring-1 ring-accent" : ""} ${selected ? "text-fg-0" : "text-fg-1"} aria-disabled:cursor-not-allowed aria-disabled:opacity-50`}
                  // A real pointer move, not the list scrolling under a resting pointer, makes an option active.
                  onPointerMove={() => i !== active && setActive(i)}
                  onClick={() => {
                    setActive(i);
                    if (!full) toggle(o.value);
                  }}
                  data-testid="component-option"
                  data-value={o.value}
                >
                  <span aria-hidden="true" className={`w-4 shrink-0 text-accent ${selected ? "" : "invisible"}`}>
                    ✓
                  </span>
                  {o.emoji && <ComponentEmoji value={o.emoji} />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{stripBidi(o.label)}</span>
                    {o.description && <span className="block truncate text-xs text-fg-2">{stripBidi(o.description)}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
          {multi && (
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-line px-1 pt-1">
              <span className="text-xs text-fg-2" aria-live="polite" data-testid="component-select-count">
                {t("components.select_count", { count: chosen.length, min, max })}
              </span>
              <Button
                className="min-w-24"
                disabled={!countOk || inactive}
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                  onPick(chosen);
                }}
                data-testid="component-select-confirm"
              >
                {t("components.select_confirm")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Notices of the interactions started from this message (its env provides the decryption of ephemeral replies). */
export function ComponentNotices({ m }: { m: Message }) {
  const env = useComponentsEnv();
  if (!env) return null;
  return <MessageNotices conversationId={env.conversationId} messageId={m.id} qualified={env.qualified} encrypted={env.encrypted} mls={env.mls} />;
}

/**
 * "<user> used <application>" above an answer to a component or a modal (§5.10.3), with a jump to the message whose
 * component was used when the view offers it.
 */
export function ComponentInteractionLine({ interaction, app }: { interaction: { user: string; message_id?: string | null }; app: string }) {
  const t = useT();
  const env = useComponentsEnv();
  const user = interaction.user.split("@")[0] ?? interaction.user;
  const text = t("interactions.used_component", { user, app });
  const target = interaction.message_id;
  return (
    <div className="mb-0.5 ml-12 flex min-w-0 items-center gap-1 text-xs text-fg-2" data-testid="message-interaction" data-kind="component">
      <span aria-hidden="true">↱</span>
      {target && env?.jump ? (
        <button type="button" className="min-h-6 min-w-0 truncate rounded text-left hover:text-fg-0 hover:underline" onClick={() => env.jump?.(target)} data-testid="message-interaction-jump">
          {text}
        </button>
      ) : (
        <span className="min-w-0 truncate">{text}</span>
      )}
    </div>
  );
}
