// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { checkNode, parseNodeUrl } from "./nodeUrl";
import { mockFetch } from "../test/render";

describe("parseNodeUrl", () => {
  it("accepts https origins and normalizes them", () => {
    expect(parseNodeUrl("https://tavrn.example")).toEqual({ ok: true, url: "https://tavrn.example" });
    expect(parseNodeUrl("  https://Tavrn.Example/  ")).toEqual({ ok: true, url: "https://tavrn.example" });
    expect(parseNodeUrl("https://chat.tavrn.example:8443")).toEqual({ ok: true, url: "https://chat.tavrn.example:8443" });
  });

  it("assumes https when the scheme is missing", () => {
    expect(parseNodeUrl("tavrn.example")).toEqual({ ok: true, url: "https://tavrn.example" });
  });

  it("allows plain http only for localhost and 127.0.0.1 (development)", () => {
    expect(parseNodeUrl("http://localhost:8080")).toEqual({ ok: true, url: "http://localhost:8080" });
    expect(parseNodeUrl("http://127.0.0.1:8300")).toEqual({ ok: true, url: "http://127.0.0.1:8300" });
    expect(parseNodeUrl("http://evil")).toEqual({ ok: false, reason: "insecure" });
    expect(parseNodeUrl("http://tavrn.example")).toEqual({ ok: false, reason: "insecure" });
    expect(parseNodeUrl("http://192.168.1.2")).toEqual({ ok: false, reason: "insecure" });
    expect(parseNodeUrl("http://localhost.evil.example")).toEqual({ ok: false, reason: "insecure" });
  });

  it("refuses credentials, paths, queries and fragments", () => {
    expect(parseNodeUrl("https://user:pw@tavrn.example")).toEqual({ ok: false, reason: "credentials" });
    expect(parseNodeUrl("https://user@tavrn.example")).toEqual({ ok: false, reason: "credentials" });
    expect(parseNodeUrl("https://tavrn.example/app")).toEqual({ ok: false, reason: "path" });
    expect(parseNodeUrl("https://tavrn.example/?x=1")).toEqual({ ok: false, reason: "path" });
    expect(parseNodeUrl("https://tavrn.example/#top")).toEqual({ ok: false, reason: "path" });
  });

  it("refuses other schemes, garbage and overlong input", () => {
    for (const bad of ["", "   ", "ftp://tavrn.example", "javascript:alert(1)", "file:///etc/passwd", "https://", "https://exa mple.org", `https://${"a".repeat(300)}.example`]) {
      expect(parseNodeUrl(bad).ok, bad).toBe(false);
    }
  });
});

describe("checkNode", () => {
  it("returns the node's identity domain from its discovery document", async () => {
    const calls = mockFetch({ "/.well-known/tavrn": { body: { domain: "tavrn.example", api: "https://tavrn.example/api/v1", ws: "wss://tavrn.example/api/v1/ws" } } });
    await expect(checkNode("https://tavrn.example")).resolves.toEqual({ ok: true, domain: "tavrn.example" });
    expect(calls[0]?.url).toBe("https://tavrn.example/.well-known/tavrn");
  });

  it("reports a server that is not a tavrn node", async () => {
    mockFetch({ "/.well-known/tavrn": { status: 404, body: {} } });
    await expect(checkNode("https://other.example")).resolves.toEqual({ ok: false, reason: "not_a_node" });
    mockFetch({ "/.well-known/tavrn": { body: { hello: "world" } } });
    await expect(checkNode("https://other.example")).resolves.toEqual({ ok: false, reason: "not_a_node" });
  });

  it("accepts a development node on this computer, named localhost", async () => {
    mockFetch({ "/.well-known/tavrn": { body: { domain: "localhost" } } });
    await expect(checkNode("http://127.0.0.1:8300")).resolves.toEqual({ ok: true, domain: "localhost" });
    await expect(checkNode("https://evil.example")).resolves.toEqual({ ok: false, reason: "not_a_node" });
  });

  it("reports an unreachable node", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(checkNode("https://down.example")).resolves.toEqual({ ok: false, reason: "unreachable" });
  });
});
