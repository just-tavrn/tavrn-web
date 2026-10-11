// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { safeColor, safeLinkUrl, stripBidi } from "./untrusted";

describe("values from nodes are checked before use", () => {
  it("strips bidi embedding, override and isolate controls from names", () => {
    expect(stripBidi("invoice‮fdp.exe")).toBe("invoicefdp.exe");
    expect(stripBidi("⁦a⁧b⁨c⁩‪‫‬‭d")).toBe("abcd");
    expect(stripBidi("مرحبا Lena")).toBe("مرحبا Lena");
  });

  it("keeps only absolute http(s) and mailto link URLs", () => {
    expect(safeLinkUrl("https://github.com/lena")).toBe("https://github.com/lena");
    expect(safeLinkUrl("mailto:lena@example.org")).toBe("mailto:lena@example.org");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "blob:https://a/x", "/relative", "file:///etc/passwd", "", null, 42]) expect(safeLinkUrl(bad)).toBeNull();
  });

  it("accepts colours only as #rrggbb", () => {
    expect(safeColor("#33aea6")).toBe("#33aea6");
    expect(safeColor("#33AEA6")).toBe("#33AEA6");
    for (const bad of ["url(https://tracker.example/x)", "#fff", "red", "#33aea6;background:url(x)", "", null, undefined]) expect(safeColor(bad)).toBeNull();
  });
});
