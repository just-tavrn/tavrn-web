// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { TavrnApiError } from "@tavrn/sdk";
import { MlsError } from "@tavrn/e2ee";
import { MAX_TOASTS, describeError, toastError, useToasts } from "./toasts";
import { E2eeError } from "../crypto/e2ee";

describe("describeError", () => {
  it("translates API codes, encryption errors and WebAuthn exceptions", () => {
    expect(describeError(new TavrnApiError({ type: "x", title: "x", status: 409, detail: "server text", code: "auth.last_factor" }))).toContain("letzter zweiter Faktor");
    expect(describeError(new E2eeError("recovery_key_invalid"))).toContain("kein gültiger Wiederherstellungsschlüssel");
    expect(describeError(new DOMException("timed out", "NotAllowedError"))).toContain("abgebrochen");
    expect(describeError(new DOMException("exists", "InvalidStateError"))).toContain("bereits einen Passkey");
    expect(describeError(new TavrnApiError({ type: "x", title: "x", status: 400, detail: "Server sagt nein", code: "unknown.code" }))).toBe("Server sagt nein");
  });
});

describe("toastError", () => {
  it("shows the readable text of an encryption refusal, not its code", () => {
    useToasts.setState({ toasts: [] } as never);
    toastError(new MlsError("ghost"), "Nachricht konnte nicht gesendet werden");
    const shown = useToasts.getState().toasts.at(-1)!;
    expect(shown.title).toBe("Nachricht konnte nicht gesendet werden");
    expect(shown.detail).not.toBe("ghost");
    expect(shown.detail).toBe(describeError(new MlsError("ghost")));
  });
});

describe("toast stack", () => {
  it("stays bounded: the oldest informational toast goes first, errors stay", () => {
    useToasts.setState({ toasts: [] } as never);
    toastError(new Error("kaputt"), "Fehler");
    for (let i = 0; i < 20; i++) useToasts.getState().push({ kind: "info", title: `info ${i}` });
    const shown = useToasts.getState().toasts;
    expect(shown.length).toBe(MAX_TOASTS);
    expect(shown[0]!.kind).toBe("error");
    expect(shown.at(-1)!.title).toBe("info 19");
  });

  it("a toast with the tag of a shown one replaces it", () => {
    useToasts.setState({ toasts: [] } as never);
    for (let i = 0; i < 10; i++) useToasts.getState().push({ kind: "info", title: "Bob", detail: `message ${i}`, tag: "notify:dm1" });
    useToasts.getState().push({ kind: "info", title: "Carol", tag: "notify:dm2" });
    const shown = useToasts.getState().toasts;
    expect(shown.map((x) => x.detail ?? x.title)).toEqual(["message 9", "Carol"]);
  });

  it("a replaced toast's timer does not dismiss its successor early", () => {
    vi.useFakeTimers();
    try {
      useToasts.setState({ toasts: [] } as never);
      useToasts.getState().push({ kind: "info", title: "1", tag: "t" });
      vi.advanceTimersByTime(4000);
      useToasts.getState().push({ kind: "info", title: "2", tag: "t" });
      vi.advanceTimersByTime(4000);
      expect(useToasts.getState().toasts.map((x) => x.title)).toEqual(["2"]);
      vi.advanceTimersByTime(1500);
      expect(useToasts.getState().toasts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
