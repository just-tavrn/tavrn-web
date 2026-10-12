// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { TavrnApiError } from "@tavrn/sdk";
import { MlsError } from "@tavrn/e2ee";
import { describeError, toastError, useToasts } from "./toasts";
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
