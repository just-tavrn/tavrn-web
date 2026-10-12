// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { updateFailure, UPDATE_ERROR_CODES } from "./updateErrors";
import { describeError } from "../stores/toasts";
import en from "../i18n/en.json";
import de from "../i18n/de.json";

const caught = (e: unknown) => {
  try {
    updateFailure(e);
  } catch (thrown) {
    return thrown;
  }
  throw new Error("updateFailure returned");
};

describe("update errors", () => {
  it("the shells' four codes become errors with their own message, never the generic one", () => {
    for (const code of ["update.unreachable", "update.no_release", "update.signature_invalid", "update.failed"]) {
      const e = caught(code);
      expect(e).toBeInstanceOf(Error);
      expect(e).toMatchObject({ problem: { code } });
      const text = describeError(e);
      expect([en[`errors.${code}` as keyof typeof en], de[`errors.${code}` as keyof typeof de]]).toContain(text);
      expect(text).not.toBe(en["common.error"]);
      expect(text).not.toBe(de["common.error"]);
    }
  });

  it("every code has a text in both languages", () => {
    for (const code of UPDATE_ERROR_CODES) {
      expect(en[`errors.${code}` as keyof typeof en], code).toBeTruthy();
      expect(de[`errors.${code}` as keyof typeof de], code).toBeTruthy();
    }
  });

  it("anything else the shell answers is the generic update failure", () => {
    for (const other of ["Could not fetch a valid release JSON from the remote", new Error("boom"), { weird: true }, undefined, "update.something_new"]) {
      expect(caught(other)).toMatchObject({ problem: { code: "update.failed" } });
    }
  });
});
