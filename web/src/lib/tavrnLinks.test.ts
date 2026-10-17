// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { parseTavrnLink, tavrnLinkPath, tavrnUrl, type KnownNode, type TavrnLink } from "./tavrnLinks";

const R = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const C = "01JCCCCCCCCCCCCCCCCCCCCCCC";
const M = "01JMMMMMMMMMMMMMMMMMMMMMMM";
const F = "01JFFFFFFFFFFFFFFFFFFFFFFF";

const known: KnownNode[] = [
  { domain: "home.example", web: "https://home.example" },
  // Delegation: identity tavrn.test, web client on app.tavrn.test.
  { domain: "tavrn.test", web: "https://app.tavrn.test" },
  // A development node on a port (exact origin only).
  { domain: "dev.local", web: "http://127.0.0.1:5173" },
];
const home = (d: string) => d === "home.example";

describe("tavrnLinks: build and parse", () => {
  const every: TavrnLink[] = [
    { kind: "room", node: "home.example", room: R },
    { kind: "channel", node: "home.example", room: R, channel: C },
    { kind: "message", node: "home.example", room: R, channel: C, message: M },
    { kind: "file", node: "home.example", room: R, channel: C, file: F },
    { kind: "invite", node: "home.example", code: "AbC_12-x" },
    { kind: "user", node: "home.example", address: "alice@home.example" },
  ];

  it("round-trips every kind on the hosting node's web origin", () => {
    for (const link of every) {
      const url = tavrnUrl("https://home.example", link);
      expect(url.startsWith("https://home.example/")).toBe(true);
      expect(parseTavrnLink(url, known)).toEqual(link);
    }
    expect(tavrnUrl("https://home.example/", every[1]!)).toBe(`https://home.example/rooms/${R}/channels/${C}`);
    expect(tavrnUrl("https://home.example", every[2]!)).toBe(`https://home.example/rooms/${R}/channels/${C}?message=${M}`);
    expect(tavrnUrl("https://home.example", every[3]!)).toBe(`https://home.example/rooms/${R}/channels/${C}/files/${F}`);
  });

  it("recognises a delegated node by its web origin and by its identity domain", () => {
    expect(parseTavrnLink(`https://app.tavrn.test/rooms/${R}`, known)).toEqual({ kind: "room", node: "tavrn.test", room: R });
    expect(parseTavrnLink(`https://tavrn.test/rooms/${R}`, known)).toEqual({ kind: "room", node: "tavrn.test", room: R });
    expect(parseTavrnLink(`http://127.0.0.1:5173/invite/abcd`, known)).toEqual({ kind: "invite", node: "dev.local", code: "abcd" });
  });

  it("accepts the client's own route of another node's room only for a known node", () => {
    expect(parseTavrnLink(`https://home.example/n/tavrn.test/rooms/${R}/channels/${C}`, known)).toEqual({ kind: "channel", node: "tavrn.test", room: R, channel: C });
    expect(parseTavrnLink(`https://home.example/n/unknown.example/rooms/${R}`, known)).toBeNull();
    expect(parseTavrnLink(`https://home.example/n/tavrn.test/invite/abcd`, known)).toBeNull();
  });

  it("accepts an encoded address and a trailing slash", () => {
    expect(parseTavrnLink("https://home.example/u/bob%40other.example", known)).toEqual({ kind: "user", node: "home.example", address: "bob@other.example" });
    expect(parseTavrnLink(`https://home.example/rooms/${R}/`, known)).toEqual({ kind: "room", node: "home.example", room: R });
  });

  it("refuses unknown hosts, look-alikes, credentials, punycode and other schemes", () => {
    const path = `/rooms/${R}/channels/${C}`;
    for (const bad of [
      `https://unknown.example${path}`,
      `https://home.example.evil.test${path}`,
      `https://evilhome.example${path}`,
      `https://home.example.${path}`,
      `https://evil@home.example${path}`,
      `https://home.example:pw@evil.test${path}`,
      `https://user:pw@home.example${path}`,
      `https://hοme.example${path}`, // Greek omicron: punycode host
      `https://xn--hme-sxa.example${path}`,
      `http://home.example${path}`,
      `https://home.example:8443${path}`,
      `https://tavrn.test:443x${path}`,
      `javascript:alert(1)//home.example${path}`,
      `data:text/html,https://home.example${path}`,
      `//home.example${path}`,
      `https://127.0.0.1${path}`,
      `https://evil.test/?u=https://home.example${path}`,
    ]) {
      expect(parseTavrnLink(bad, known), bad).toBeNull();
    }
  });

  it("refuses malformed paths, ids, queries and fragments", () => {
    for (const bad of [
      "https://home.example/",
      "https://home.example/rooms",
      `https://home.example/rooms/${R.toLowerCase()}`,
      `https://home.example/rooms/${R}x`,
      `https://home.example/rooms/${R}//channels/${C}`,
      `https://home.example/rooms/${R}/channels/${C}/threads/${M}`,
      `https://home.example/rooms/${R}/channels/${C}?message=nope`,
      `https://home.example/rooms/${R}/channels/${C}?message=${M}&x=1`,
      `https://home.example/rooms/${R}/channels/${C}?m=${M}`,
      `https://home.example/rooms/${R}?x=1`,
      `https://home.example/rooms/${R}#top`,
      `https://home.example/rooms/${R}/channels/${C}/files/${F}?download=1`,
      "https://home.example/invite/ab",
      "https://home.example/invite/<script>",
      "https://home.example/invite/abcd/extra",
      "https://home.example/u/alice",
      "https://home.example/u/Alice@home.example",
      "https://home.example/u/alice@home.example%20",
      "https://home.example/u/%E0%A4%A",
      `https://home.example/rooms/${R}\\channels`,
      `https://home.example/rooms/${R} x`,
      `https://home.example/${"a".repeat(600)}`,
    ]) {
      expect(parseTavrnLink(bad, known), bad).toBeNull();
    }
  });

  it("maps targets to the client's routes (home node classic, others under /n/<domain>)", () => {
    const at = (url: string) => tavrnLinkPath(parseTavrnLink(url, known)!, home);
    expect(at(`https://home.example/rooms/${R}/channels/${C}`)).toBe(`/rooms/${R}/channels/${C}`);
    expect(at(`https://app.tavrn.test/rooms/${R}/channels/${C}`)).toBe(`/n/tavrn.test/rooms/${R}/channels/${C}`);
    expect(at(`https://home.example/rooms/${R}/channels/${C}?message=${M}`)).toBe(`/rooms/${R}/channels/${C}?m=${M}`);
    expect(at(`https://tavrn.test/rooms/${R}/channels/${C}/files/${F}`)).toBe(`/n/tavrn.test/rooms/${R}/channels/${C}/files/${F}`);
    expect(at("https://home.example/invite/abcd")).toBe("/invite/abcd");
    expect(at("https://tavrn.test/invite/abcd")).toBe("/invite/abcd?node=tavrn.test");
    expect(at("https://home.example/u/bob@other.example")).toBe("/u/bob@other.example");
    expect(at("https://tavrn.test/u/eve@tavrn.test")).toBe("/u/eve@tavrn.test?via=tavrn.test");
    expect(at(`https://home.example/rooms/${R}`)).toBe(`/rooms/${R}`);
  });
});
