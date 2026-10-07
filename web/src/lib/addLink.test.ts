// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { addPath, parseAddInput, parseRoomParam } from "./addLink";

const ID = "01J9ZZZZZZZZZZZZZZZZZZZZZZ";
const ctx = { origin: "https://home.example", webs: { "other.example": "https://web.other.example" } };

describe("add links", () => {
  it("accepts the link forms of APPLICATIONS.md §4.1", () => {
    expect(parseAddInput(`https://home.example/add/${ID}`, ctx)).toEqual({ domain: null, id: ID });
    expect(parseAddInput(`https://node.example/add/${ID}`, ctx)).toEqual({ domain: "node.example", id: ID });
    expect(parseAddInput(`https://home.example/add/Node.Example/${ID}`, ctx)).toEqual({ domain: "node.example", id: ID });
    expect(parseAddInput(`https://web.other.example/add/${ID}`, ctx)).toEqual({ domain: "other.example", id: ID });
    expect(parseAddInput(`node.example/add/${ID}`, ctx)).toEqual({ domain: "node.example", id: ID });
    expect(parseAddInput(`node.example/${ID.toLowerCase()}`, ctx)).toEqual({ domain: "node.example", id: ID });
    expect(parseAddInput(`  ${ID}  `, ctx)).toEqual({ domain: null, id: ID });
    // References of this client's own node, also a development domain without a dot.
    expect(parseAddInput(`localhost/${ID}`, { ...ctx, ownDomain: "localhost" })).toEqual({ domain: null, id: ID });
    expect(parseAddInput(`localhost/${ID}`, ctx)).toBeNull();
  });

  it("refuses everything else", () => {
    for (const bad of [
      "",
      "hello",
      `https://node.example/invite/${ID}`,
      `https://node.example/add/`,
      `https://node.example/add/x`,
      `https://node.example/add/a/b/${ID}`,
      `javascript:alert(1)//add/${ID}`,
      `http://node.example/add/${ID}`,
      `https://127.0.0.1/add/${ID}`,
      `https://node.example:8443/add/${ID}`,
      `https://home.example/add/not_a_domain!/${ID}`,
    ]) {
      expect(parseAddInput(bad, ctx), bad).toBeNull();
    }
  });

  it("builds the consent path and reads the preselected room", () => {
    expect(addPath({ domain: null, id: ID })).toBe(`/add/${ID}`);
    expect(addPath({ domain: "node.example", id: ID }, { node: "b.test", id: ID })).toBe(`/add/node.example/${ID}?room=b.test%2F${ID}`);
    expect(parseRoomParam(`b.test/${ID}`)).toEqual({ node: "b.test", id: ID });
    expect(parseRoomParam(ID)).toEqual({ node: null, id: ID });
    expect(parseRoomParam("x/y")).toBeNull();
    expect(parseRoomParam(null)).toBeNull();
  });
});
