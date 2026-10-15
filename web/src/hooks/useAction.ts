// SPDX-License-Identifier: Apache-2.0
/**
 * One way to run a user action against the node (a button, a toggle, a form): a busy flag and an in-flight guard (a
 * double click sends one request), the success toast, errors through the shared mapping (`toastError`, or inline
 * through `describeError`), and the follow-up refresh kept apart from the action. A refresh that fails after a
 * successful action is a warning ("done, the view may be stale"), never a failed action: retrying a create or a
 * remove that went through would only meet a conflict or do it twice.
 */
import { useCallback, useRef, useState } from "react";
import { t } from "../i18n";
import { describeError, toastError, useToasts } from "../stores/toasts";

export interface ActionOptions<T = unknown> {
  /** Info toast after the action succeeded. */
  done?: string;
  /** Follows a successful action (cache invalidation, a refetch, the parent's `onChanged`); it gets the result. */
  refresh?: (result: T) => unknown;
  /** Where errors go: a toast (default) or the hook's `error` (a form's inline message). */
  errors?: "toast" | "inline";
  /** Title of the error toast (default: the problem's title). */
  errorTitle?: string;
  /** Errors the caller handles itself: return `true` to skip the default report. */
  onError?: (e: unknown) => boolean | void;
}

export interface Action {
  /** Runs `fn` unless an action of this hook is still running; resolves `true` when `fn` succeeded. */
  run: <T>(fn: () => Promise<T>, opts?: ActionOptions<T>) => Promise<boolean>;
  busy: boolean;
  /** The inline error of the last run (`errors: "inline"`). */
  error: string | null;
  setError: (error: string | null) => void;
}

/** `defaults` apply to every run; a run's own options override them. */
export function useAction(defaults: ActionOptions = {}): Action {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;

  const run = useCallback(async <T>(fn: () => Promise<T>, own: ActionOptions<T> = {}): Promise<boolean> => {
    // Synchronous guard: the busy state reaches the button only with the next render.
    if (running.current) return false;
    running.current = true;
    const opts = { ...(defaultsRef.current as ActionOptions<T>), ...own };
    setBusy(true);
    setError(null);
    let result: T;
    try {
      result = await fn();
    } catch (e) {
      running.current = false;
      setBusy(false);
      if (opts.onError?.(e) === true) return false;
      if (opts.errors === "inline") setError(describeError(e));
      else toastError(e, opts.errorTitle);
      return false;
    }
    if (opts.done) useToasts.getState().push({ kind: "info", title: opts.done });
    try {
      await opts.refresh?.(result);
    } catch (e) {
      console.warn("refresh after an action failed", e);
      useToasts.getState().push({ kind: "warning", title: t("common.refresh_failed") });
    } finally {
      running.current = false;
      setBusy(false);
    }
    return true;
  }, []);

  return { run, busy, error, setError };
}
