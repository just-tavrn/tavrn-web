// SPDX-License-Identifier: Apache-2.0
// The interaction flow of message components in the conversation view (APPLICATIONS.md §5.10) against a mocked node.
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@tavrn/sdk";
import { ConversationView } from "../components/ConversationView";
import { useAuth } from "../stores/auth";
import { useInteractions } from "../stores/interactions";
import { mockFetch, renderWithProviders } from "../test/render";
import { useExpiredComponents } from "./context";

const encrypt = vi.fn(async (_q: string, content: Record<string, unknown>) => ({ content: `sealed:${String(content.type)}`, epoch: 7 }));
let decrypted: Record<string, unknown> = {};

vi.mock("../hooks/useE2eeConversation", () => ({
  useE2eeConversation: () => ({ phase: "ready", mls: { encrypt, decrypt: vi.fn(async () => ({ ok: false })) }, waiting: [], ghosts: [], error: null, rejoined: false, tick: 0 }),
  useDecrypted: () => decrypted,
  usePlainSignatures: () => ({}),
}));

const me = { id: "u1", username: "bob", domain: "t.local", address: "bob@t.local", display_name: "Bob", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const app = { ref: "raid", name: "Raid Bot", bot: "raid-bot@t.local" };
const ROWS = [
  { type: "row", components: [{ type: "button", style: "primary", label: "Sign up", custom_id: "signup" }] },
  { type: "row", components: [{ type: "select", custom_id: "class", options: [{ label: "Mage", value: "mage" }, { label: "Healer", value: "healer" }] }] },
];

function botMessage(over: Partial<Message> = {}, content: Record<string, unknown> = { type: "text", body: "Raid on Friday", components: ROWS }): Message {
  return {
    id: "m1", conversation_id: "c1", author: app.bot, author_id: "u9", author_kind: "bot", device_id: "d9", encrypted: false, format: 1, epoch: null, content,
    reply_to_id: null, thread_id: null, mentions: [], mentions_everyone: false, created_at: new Date().toISOString(), edited_at: null, attachments: [],
    reactions: [], pinned: false, signature: null, ...over,
  };
}

type Answer = { status?: number; body: unknown };
interface Calls {
  invoke: unknown[];
  submit: unknown[];
}

function view(answer: Answer | ((body: unknown) => Answer), opts: { encrypted?: boolean; message?: Message; submit?: Answer } = {}) {
  const calls: Calls = { invoke: [], submit: [] };
  const message = opts.message ?? botMessage();
  mockFetch({
    "/conversations/c1/messages/m1/interactions": (init) => {
      const body = JSON.parse(String(init.body));
      calls.invoke.push(body);
      return typeof answer === "function" ? answer(body) : answer;
    },
    "/interactions/i1/submit": (init) => {
      calls.submit.push(JSON.parse(String(init.body)));
      return opts.submit ?? { body: { interaction_id: "i2", outcome: "reply", ephemeral: { interaction_id: "i2", conversation_id: "c1", application: app, content: { type: "text", body: "Noted!" }, created_at: "", message_id: "m1" } } };
    },
    "/conversations/c1/messages": { body: [message] },
    "/conversations/c1/commands": { body: [] },
    "/.well-known/tavrn": { body: { policies: { upload_max_bytes: 1000, uploads_enabled: true } } },
    "/node": { body: { gif_provider: null, dm_policy: "friends", capabilities: ["components.v1"] } },
  });
  renderWithProviders(
    <ConversationView conversationId="c1" encrypted={!!opts.encrypted} header={<h1>x</h1>} placeholder="Nachricht" canSend canManage={false} canAttach canReact canPin members={["bob@t.local", app.bot]} mayManage={false} domain="t.local" />,
  );
  return calls;
}

const rowOf = async () => (await screen.findByText("Raid on Friday")).closest<HTMLElement>("[data-testid=message]")!;

describe("message components: interaction flow", () => {
  beforeEach(() => {
    useAuth.setState({ token: "t", user: me });
    act(() => {
      useInteractions.setState({ notices: [] });
      useExpiredComponents.setState({ expired: {} });
    });
    decrypted = {};
    encrypt.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("a button invokes with its custom_id; an ephemeral reply with message_id is shown under that message", async () => {
    const calls = view({ body: { interaction_id: "i1", outcome: "reply", ephemeral: { interaction_id: "i1", conversation_id: "c1", application: app, content: { type: "text", body: "You are **in**" }, created_at: "", message_id: "m1" } } });
    const row = await rowOf();
    await userEvent.click(within(row).getByRole("button", { name: "Sign up" }));
    const notices = await within(row).findByTestId("message-notices");
    expect(within(notices).getByTestId("interaction-ephemeral").textContent).toContain("Nur du siehst das");
    expect(within(notices).getByTestId("interaction-body").innerHTML).toContain("<strong>in</strong>");
    expect(calls.invoke).toEqual([{ custom_id: "signup", values: null, values_ciphertext: null, epoch: null }]);
    expect(screen.queryByTestId("interaction-notices")).toBeNull();
  });

  it("an ephemeral reply without message_id falls back to the bottom of the conversation", async () => {
    view({ body: { interaction_id: "i1", outcome: "reply", ephemeral: { interaction_id: "i1", conversation_id: "c1", application: app, content: { type: "text", body: "Bottom" }, created_at: "" } } });
    const row = await rowOf();
    await userEvent.click(within(row).getByRole("button", { name: "Sign up" }));
    expect((await screen.findByTestId("interaction-notices")).textContent).toContain("Bottom");
    expect(within(row).queryByTestId("message-notices")).toBeNull();
  });

  it("defer shows '… is thinking' under the message; error shows the bot's text there, cut to 200 characters", async () => {
    let n = 0;
    view(() => (++n === 1 ? { body: { interaction_id: "i1", outcome: "defer" } } : { body: { interaction_id: "i2", outcome: "error", error: "x".repeat(300) } }));
    const row = await rowOf();
    await userEvent.click(within(row).getByRole("button", { name: "Sign up" }));
    // Named like the message author (no room members here: the local part of the address).
    expect((await within(row).findByTestId("interaction-thinking")).textContent).toContain("raid-bot denkt nach");
    await userEvent.click(within(row).getByRole("button", { name: "Sign up" }));
    const error = await within(row).findByTestId("interaction-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toContain("Die Aktion ist fehlgeschlagen");
    expect(error.querySelector("p")!.textContent!.length).toBe(200);
  });

  it("update re-renders the message; a stored reply is added to the conversation", async () => {
    const updated = botMessage({ edited_at: new Date().toISOString() }, { type: "text", body: "Raid on Friday: 1 signed up", components: [{ type: "row", components: [{ type: "button", style: "danger", label: "Leave", custom_id: "leave" }] }] });
    let n = 0;
    view(() => (++n === 1 ? { body: { interaction_id: "i1", outcome: "update", message: updated } } : { body: { interaction_id: "i2", outcome: "reply", message: botMessage({ id: "m2" }, { type: "text", body: "Bob is in" }) } }));
    const row = await rowOf();
    await userEvent.click(within(row).getByRole("button", { name: "Sign up" }));
    expect(await screen.findByText("Raid on Friday: 1 signed up")).toBeTruthy();
    const leave = screen.getByRole("button", { name: "Leave" });
    expect(leave.dataset.style).toBe("danger");
    await userEvent.click(leave);
    expect(await screen.findByText("Bob is in")).toBeTruthy();
  });

  it("a select sends the chosen value", async () => {
    const calls = view({ body: { interaction_id: "i1", outcome: "defer" } });
    const row = await rowOf();
    await userEvent.click(within(row).getByTestId("component-select-trigger"));
    await userEvent.click(within(row).getByRole("option", { name: "Healer" }));
    await waitFor(() => expect(calls.invoke).toEqual([{ custom_id: "class", values: ["healer"], values_ciphertext: null, epoch: null }]));
  });

  it("modal: the answer opens the bot's form, submit sends the values and shows the answer under the message", async () => {
    const calls = view({ body: { interaction_id: "i1", outcome: "modal", modal: { custom_id: "note", title: "Raid note", inputs: [{ custom_id: "text", label: "Note", style: "paragraph" }] } } });
    const row = await rowOf();
    await userEvent.click(within(row).getByRole("button", { name: "Sign up" }));
    const dialog = await screen.findByRole("dialog", { name: "Raid note" });
    await userEvent.type(within(dialog).getByLabelText(/Note/), "Bringing food");
    await userEvent.click(within(dialog).getByTestId("component-modal-submit"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.submit).toEqual([{ values: { text: "Bringing food" }, values_ciphertext: null, epoch: null }]);
    expect((await within(row).findByTestId("message-notices")).textContent).toContain("Noted!");
  });

  it("an invalid modal from the bot never opens a dialog", async () => {
    view({ body: { interaction_id: "i1", outcome: "modal", modal: { custom_id: "note", title: "x".repeat(46), inputs: [] } } });
    const row = await rowOf();
    await userEvent.click(within(row).getByRole("button", { name: "Sign up" }));
    await within(row).findByTestId("interaction-error");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("encrypted conversations: the values are sealed as component.values / modal.values, the node sees only the id", async () => {
    decrypted = { m1: { ok: true, content: { type: "text", body: "Raid on Friday", components: ROWS } } };
    const message = botMessage({ encrypted: true, content: "ciphertext", epoch: 6 });
    const calls = view({ body: { interaction_id: "i1", outcome: "modal", modal: { custom_id: "note", title: "Raid note", inputs: [{ custom_id: "text", label: "Note", style: "short" }] } } }, { encrypted: true, message });
    const row = await rowOf();
    await userEvent.click(within(row).getByRole("button", { name: "Sign up" }));
    expect(calls.invoke).toEqual([{ custom_id: "signup", values: null, values_ciphertext: "sealed:component.values", epoch: 7 }]);
    const sealed = encrypt.mock.calls[0]!;
    expect(sealed[0]).toBe("t.local/c1");
    expect(sealed[1]).toMatchObject({ type: "component.values", message_id: "m1", custom_id: "signup", values: null });
    expect(String(sealed[1].nonce)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const dialog = await screen.findByRole("dialog", { name: "Raid note" });
    await userEvent.type(within(dialog).getByLabelText(/Note/), "secret");
    await userEvent.click(within(dialog).getByTestId("component-modal-submit"));
    await waitFor(() => expect(calls.submit).toEqual([{ values: null, values_ciphertext: "sealed:modal.values", epoch: 7 }]));
    expect(encrypt.mock.calls[1]![1]).toMatchObject({ type: "modal.values", interaction: "i1", custom_id: "note", values: { text: "secret" } });
  });

  it("messages of users with components in an encrypted conversation show no controls", async () => {
    decrypted = { m1: { ok: true, content: { type: "text", body: "Raid on Friday", components: ROWS } } };
    view({ body: {} }, { encrypted: true, message: botMessage({ encrypted: true, content: "ciphertext", author: "mallory@t.local", author_kind: "user" }) });
    const row = await rowOf();
    expect(within(row).queryByTestId("message-components")).toBeNull();
  });
});
