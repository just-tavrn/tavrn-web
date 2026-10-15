// SPDX-License-Identifier: Apache-2.0
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n";
import { useToasts } from "../stores/toasts";
import { useAction } from "./useAction";

/** A promise the test settles by hand. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const problem = (code: string, detail = "refused") => Object.assign(new Error(detail), { problem: { code, title: "Bad", detail } });

describe("useAction", () => {
  beforeEach(() => useToasts.setState({ toasts: [] }));
  afterEach(() => vi.restoreAllMocks());

  it("sends once on a double click and is busy while the action runs", async () => {
    const { result } = renderHook(() => useAction());
    const gate = deferred();
    const fn = vi.fn(() => gate.promise);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.run(fn);
      second = result.current.run(fn);
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(true);
    await expect(second).resolves.toBe(false);
    await act(async () => {
      gate.resolve();
      await first;
    });
    await expect(first).resolves.toBe(true);
    expect(result.current.busy).toBe(false);
    // Once it is done, the next click runs again.
    await act(() => result.current.run(fn));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("reports a failed refresh after a successful action as a warning, not as a failed action", async () => {
    const { result } = renderHook(() => useAction());
    const fn = vi.fn(async () => "ok");
    const refresh = vi.fn(async () => {
      throw new Error("offline");
    });
    let ok = false;
    await act(async () => {
      ok = await result.current.run(fn, { done: "Removed", refresh });
    });
    expect(ok).toBe(true);
    expect(refresh).toHaveBeenCalledWith("ok");
    const toasts = useToasts.getState().toasts;
    expect(toasts.map((x) => x.kind)).toEqual(["info", "warning"]);
    expect(toasts[0]!.title).toBe("Removed");
    expect(toasts[1]!.title).toBe(t("common.refresh_failed"));
    expect(toasts.some((x) => x.kind === "error")).toBe(false);
  });

  it("shows a failed action through the shared error mapping and skips the refresh and the success toast", async () => {
    const { result } = renderHook(() => useAction());
    const refresh = vi.fn();
    let ok = true;
    await act(async () => {
      ok = await result.current.run(() => Promise.reject(problem("friend.not_found", "No such friend")), { done: "Removed", refresh, errorTitle: "Removing failed" });
    });
    expect(ok).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    const toasts = useToasts.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ kind: "error", title: "Removing failed", detail: "No such friend" });
  });

  it("puts the error inline when asked and clears it on the next run", async () => {
    const { result } = renderHook(() => useAction({ errors: "inline" }));
    await act(() => result.current.run(() => Promise.reject(problem("x.y", "Wrong code"))));
    expect(result.current.error).toBe("Wrong code");
    expect(useToasts.getState().toasts).toHaveLength(0);
    const gate = deferred();
    act(() => void result.current.run(() => gate.promise));
    expect(result.current.error).toBeNull();
    await act(async () => gate.resolve());
  });

  it("lets the caller handle an error itself", async () => {
    const onError = vi.fn((e: unknown) => (e as Error).message === "expired");
    const { result } = renderHook(() => useAction({ onError }));
    await act(() => result.current.run(() => Promise.reject(new Error("expired"))));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(useToasts.getState().toasts).toHaveLength(0);
    await act(() => result.current.run(() => Promise.reject(new Error("other"))));
    expect(useToasts.getState().toasts.map((x) => x.kind)).toEqual(["error"]);
  });

  it("keeps the role preview's refusal silent (it has shown its own notice)", async () => {
    const { result } = renderHook(() => useAction());
    await act(() => result.current.run(() => Promise.reject(problem("roleview.read_only"))));
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});
