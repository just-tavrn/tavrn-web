// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { parseInviteInput } from "./inviteLink";

const ctx = { origin: "https://home.example", webs: { "b.test": "http://b.test:5298", "chat.example": "https://web.chat.example" } };

describe("invite links", () => {
  it("takes bare codes and links of this client", () => {
    expect(parseInviteInput("  AbC123_x ", ctx)).toEqual({ node: null, code: "AbC123_x" });
    expect(parseInviteInput("https://home.example/invite/AbC123", ctx)).toEqual({ node: null, code: "AbC123" });
  });

  it("finds the node of other links", () => {
    expect(parseInviteInput("http://b.test:5298/invite/Code42", ctx)).toEqual({ node: "b.test", code: "Code42" });
    expect(parseInviteInput("https://web.chat.example/invite/Code42", ctx)).toEqual({ node: "chat.example", code: "Code42" });
    expect(parseInviteInput("https://community.example/invite/Code42", ctx)).toEqual({ node: "community.example", code: "Code42" });
    expect(parseInviteInput("community.example/invite/Code42", ctx)).toEqual({ node: "community.example", code: "Code42" });
  });

  it("refuses everything else", () => {
    for (const bad of [
      "",
      "a b",
      "ab",
      "https://community.example/rooms/x",
      "https://community.example/invite/",
      "https://community.example/invite/Code42/extra",
      "http://community.example/invite/Code42",
      "https://127.0.0.1/invite/Code42",
      "https://localhost:8080/invite/Code42",
      "javascript:alert(1)//invite/Code42",
      "https://community.example/invite/<script>",
    ]) {
      expect(parseInviteInput(bad, ctx), bad).toBeNull();
    }
  });
});
