// SPDX-License-Identifier: Apache-2.0
import { cloneElement, useEffect, useId, useRef, type ReactElement, type ReactNode } from "react";
import { avatarBackground, initials } from "../lib/format";
import { useFocusTrap } from "../lib/focusTrap";

export function Button({
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const base = "inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
  const styles = {
    primary: "bg-accent text-accent-text hover:bg-accent-hover",
    ghost: "text-fg-1 hover:bg-bg-3 hover:text-fg-0",
    danger: "bg-danger-solid text-white hover:bg-danger-solid-hover",
  }[variant];
  return <button type="button" {...props} className={`${base} ${styles} ${className}`} />;
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`min-h-10 w-full rounded-md border border-line-strong bg-bg-0 px-3 text-sm text-fg-0 outline-none placeholder:text-fg-2 focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 read-only:cursor-not-allowed read-only:bg-bg-3 read-only:text-fg-2 ${props.className ?? ""}`}
    />
  );
}

/**
 * A labelled form control. The hint and, while shown, the form's error message (`errorId`, the id of an
 * {@link ErrorText}) describe the control; `errorId` also marks it invalid (WCAG 1.3.1, 3.3.1).
 */
export function Field({ label, children, hint, errorId }: { label: string; children: ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>; hint?: string; errorId?: string }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const describedBy = [hint ? hintId : null, errorId ?? null, children.props["aria-describedby"] ?? null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1 text-sm">
      <label htmlFor={id} className="block text-fg-1">
        {label}
      </label>
      {cloneElement(children, { id, "aria-describedby": describedBy, ...(errorId ? { "aria-invalid": true } : {}) })}
      {hint && (
        <span id={hintId} className="block text-xs text-fg-2">
          {hint}
        </span>
      )}
    </div>
  );
}

/** Initials as generated content, as in MediaAvatar: part of the picture, not text of a control's name (WCAG 2.5.3). */
export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white before:content-[attr(data-initials)]"
      style={{ width: size, height: size, background: avatarBackground(name), fontSize: size * 0.38 }}
      data-initials={initials(name)}
      data-testid="avatar-initials"
    />
  );
}

export function Dialog({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Modal (WCAG 2.1.2, 2.4.3): Tab stays inside, the first field takes the focus, the opener gets it back.
  useFocusTrap(ref, open, { initial: () => ref.current?.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select, button") });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // An Escape handled inside (a popover or menu of the dialog, lib/dismiss.ts) closes only that.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Only the topmost modal closes (the last one in the document): a confirmation over a form closes alone.
      const modals = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (modals.length > 0 && modals[modals.length - 1] !== ref.current) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="max-h-[90dvh] w-full max-w-md select-text overflow-y-auto rounded-t-xl border border-line bg-bg-1 p-5 shadow-xl sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="mb-4 select-none text-base font-semibold">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

/** A form's error message, announced when it appears; `id` lets {@link Field} controls reference it. */
export function ErrorText({ children, id }: { children: ReactNode; id?: string }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}
