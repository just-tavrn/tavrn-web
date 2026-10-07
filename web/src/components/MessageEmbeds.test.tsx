// SPDX-License-Identifier: Apache-2.0
import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@tavrn/sdk";
import { LinkPreviews, embedColor, embedHost } from "./LinkPreviews";
import { MessageList } from "./MessageList";
import { DEFAULT_CONTENT_PRIVACY, useContentPrivacy } from "../stores/contentPrivacy";

const card = {
  title: "Build #128",
  description: "All **42** tests passed ![pixel](https://tracker.example/p.gif) <img src=x onerror=alert(1)>",
  url: "https://ci.example/b/128",
  color: 3066993,
  fields: [
    { name: "Branch", value: "main", inline: true },
    { name: "Commit", value: "abc123", inline: true },
    { name: "Log", value: "line 1\nline 2" },
  ],
  footer: "ci.example",
  timestamp: "2026-10-05T12:00:00Z",
};

describe("message embeds (APPLICATIONS.md §6.4)", () => {
  beforeEach(() => act(() => useContentPrivacy.setState(DEFAULT_CONTENT_PRIVACY)));

  it("renders title, host, sanitized description, colour bar, inline fields and footer, without any image", () => {
    const { container } = render(<LinkPreviews body="" content={{ type: "text", body: "", embeds: [card] }} />);
    const embed = screen.getByTestId("message-embed");
    expect(embed.dataset.color).toBe("#2ecc71");
    expect(embed.style.borderLeftColor).toBe("rgb(46, 204, 113)");
    const title = screen.getByTestId("message-embed-title");
    expect(title.textContent).toBe("Build #128");
    expect(title.getAttribute("href")).toBe("https://ci.example/b/128");
    expect(title.getAttribute("rel")).toContain("noopener");
    expect(screen.getByTestId("message-embed-host").textContent).toBe("ci.example");
    const description = screen.getByTestId("message-embed-description");
    expect(description.querySelector("strong")?.textContent).toBe("42");
    expect(container.querySelector("img")).toBeNull();
    expect(description.querySelector("[onerror]")).toBeNull();
    expect(description.textContent).toContain("<img src=x onerror=alert(1)>");
    const fields = screen.getAllByTestId("message-embed-field");
    expect(fields.map((f) => f.dataset.inline)).toEqual(["true", "true", undefined]);
    expect(within(fields[0]!).getByText("Branch")).toBeTruthy();
    expect(screen.getByTestId("message-embed-footer").textContent).toContain("ci.example");
  });

  it("drops invalid embeds and shows hosts in full", () => {
    render(<LinkPreviews body="" content={{ type: "text", body: "", embeds: [{ title: "x", url: "http://insecure.example" }] }} />);
    expect(screen.queryByTestId("message-embed")).toBeNull();
    expect(embedHost("https://login.bank.example.evil.example/path")).toBe("login.bank.example.evil.example");
    expect(embedColor(0)).toBe("#000000");
    expect(embedColor(undefined)).toBeUndefined();
  });

  it("shows webhook messages with the webhook's name and the WEBHOOK badge, never as unverified", () => {
    const m: Message = {
      id: "m1", conversation_id: "c1", author: "wh.01jabcdefghjkmnpqrstvwxyz0@t.local", author_id: "u1", author_kind: "webhook",
      device_id: null, encrypted: false, format: 1, epoch: null, content: { type: "text", body: "", embeds: [card] }, reply_to_id: null,
      thread_id: null, mentions: [], mentions_everyone: false, created_at: "2026-10-05T12:00:00.000Z", edited_at: null, attachments: [],
      reactions: [], pinned: false, signature: null, webhook: { id: "01JABCDEFGHJKMNPQRSTVWXYZ0", name: "CI" },
    };
    render(<MessageList messages={[m]} currentUserId="me" canManage={false} hasMore={false} />);
    expect(screen.getByTestId("message-author").textContent).toBe("CI");
    expect(screen.getByTestId("webhook-badge")).toBeTruthy();
    expect(screen.queryByTestId("bot-badge")).toBeNull();
    expect(screen.queryByTestId("unverified-marker")).toBeNull();
    expect(screen.getByTestId("message-embed")).toBeTruthy();
  });

  it("shows sealed webhook messages with the name from the box, the badge and a lock that says who sealed them", () => {
    const base: Message = {
      id: "m1", conversation_id: "c1", author: "wh.01jabcdefghjkmnpqrstvwxyz0@t.local", author_id: "u1", author_kind: "webhook",
      device_id: null, encrypted: true, format: 1, epoch: 3, content: { type: "webhook.sealed", epoch: 3, sealed: "AAAA", sealed_by: "node" }, reply_to_id: null,
      thread_id: null, mentions: [], mentions_everyone: false, created_at: "2026-10-05T12:00:00.000Z", edited_at: null, attachments: [],
      reactions: [], pinned: false, signature: null, webhook: { id: "01JABCDEFGHJKMNPQRSTVWXYZ0", name: "CI" },
    };
    const other: Message = { ...base, id: "m2", created_at: "2026-10-05T13:00:00.000Z" };
    render(
      <MessageList
        messages={[base, other]}
        currentUserId="me"
        canManage={false}
        hasMore={false}
        decrypted={{ m1: { ok: true, content: { type: "text", body: "Disk **full**" }, sealedBy: "node", webhookName: "Monitor" }, m2: { ok: false, reason: "missing_key" } }}
      />,
    );
    const rows = ["m1", "m2"].map((id) => screen.getAllByTestId("message").find((r) => r.querySelector(`[data-message-id="${id}"]`) || r.dataset.messageId === id)!);
    expect(within(rows[0]!).getByTestId("message-author").textContent).toBe("Monitor");
    expect(within(rows[0]!).getByTestId("webhook-badge")).toBeTruthy();
    const lock = within(rows[0]!).getByTestId("sealed-mark");
    expect(lock.dataset.sealedBy).toBe("node");
    expect(lock.getAttribute("title")).toMatch(/node saw the text|Knoten hat den Text/);
    expect(rows[0]!.querySelector("strong")?.textContent).toBe("full");
    // Without the epoch's key the message is shown as undecryptable, like any other.
    expect(within(rows[1]!).getByTestId("undecryptable").dataset.reason).toBe("missing_key");
    expect(within(rows[1]!).queryByTestId("sealed-mark")).toBeNull();
  });
});
