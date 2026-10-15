// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Row } from "@tavrn/sdk";
import { MessageList } from "../components/MessageList";
import { ComponentsContext, useUnusableComponents, type ComponentsEnv } from "./context";
import { BUTTON_STYLES } from "./MessageComponents";

const ROWS: Row[] = [
  {
    type: "row",
    components: [
      { type: "button", style: "primary", label: "Sign up", custom_id: "signup", emoji: "✅" },
      { type: "button", style: "secondary", label: "Maybe", custom_id: "maybe" },
      { type: "button", style: "success", label: "Tank", custom_id: "tank" },
      { type: "button", style: "danger", label: "Decline", custom_id: "decline" },
      { type: "button", style: "link", label: "Guide", url: "https://guide.example/raid" },
    ],
  },
  { type: "row", components: [{ type: "button", style: "secondary", label: "", emoji: "🎲", custom_id: "dice" }] },
  {
    type: "row",
    components: [
      {
        type: "select",
        custom_id: "class",
        placeholder: "Your class",
        options: [
          { label: "Warrior", value: "warrior", description: "Melee, plate", emoji: "⚔️" },
          { label: "Mage", value: "mage", default: true },
          { label: "Healer", value: "healer" },
        ],
      },
    ],
  },
  {
    type: "row",
    components: [
      {
        type: "select",
        custom_id: "days",
        min: 1,
        max: 2,
        options: [
          { label: "Monday", value: "mon" },
          { label: "Tuesday", value: "tue" },
          { label: "Wednesday", value: "wed" },
        ],
      },
    ],
  },
];

function msg(over: Partial<Message> = {}, components: unknown = ROWS): Message {
  return {
    id: "m1", conversation_id: "c1", author: "raid-bot@t.local", author_id: "u9", author_kind: "bot", device_id: "d9", encrypted: false, format: 1, epoch: null,
    content: { type: "text", body: "Raid on Friday", components }, reply_to_id: null, thread_id: null, mentions: [], mentions_everyone: false,
    created_at: new Date().toISOString(), edited_at: null, attachments: [], reactions: [], pinned: false, signature: null, ...over,
  };
}

function env(over: Partial<ComponentsEnv> = {}): ComponentsEnv {
  return { conversationId: "c1", canUse: true, invoke: vi.fn(async () => undefined), qualified: "t.local/c1", encrypted: false, mls: null, ...over };
}

function show(m: Message, e: ComponentsEnv | null = env()) {
  return render(
    <ComponentsContext.Provider value={e}>
      <MessageList messages={[m]} currentUserId="me" canManage={false} hasMore={false} />
    </ComponentsContext.Provider>,
  );
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });

describe("message components: rendering (APPLICATIONS.md §5.10)", () => {
  beforeEach(() => act(() => useUnusableComponents.setState({ state: {} })));

  it("renders every row below the body with the fixed palette, emoji and a link button", () => {
    show(msg());
    const area = screen.getByTestId("message-components");
    expect(screen.getByTestId("message").textContent).toContain("Raid on Friday");
    expect(screen.getAllByTestId("component-row")).toHaveLength(4);
    const styles = within(area).getAllByTestId("component-button").map((b) => b.dataset.style);
    expect(styles).toEqual(["primary", "secondary", "success", "danger", "link", "secondary"]);
    for (const [style, classes] of Object.entries(BUTTON_STYLES)) {
      const b = within(area).getAllByTestId("component-button").find((x) => x.dataset.style === style)!;
      for (const c of classes.split(" ")) expect(b.className).toContain(c);
    }
    expect(within(button("Sign up")).getByTestId("component-emoji").textContent).toBe("✅");
    // An emoji-only button is named by its emoji; a link button says where it goes.
    expect(button("🎲")).toBeTruthy();
    expect(button(/Guide/).textContent).toContain("guide.example");
    expect(button(/Guide/)).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("wraps rows, truncates long labels with the full text as tooltip and keeps the area inside the message", () => {
    const long = "A".repeat(80);
    show(msg({}, [{ type: "row", components: [{ type: "button", style: "primary", label: long, custom_id: "x" }] }]));
    const area = screen.getByTestId("message-components");
    expect(area.className).toMatch(/max-h-\[28rem\]/);
    expect(area.className).toContain("overflow-x-hidden");
    expect(area.className).toContain("overflow-y-auto");
    expect(screen.getByTestId("component-row").className).toContain("flex-wrap");
    const b = button(long);
    expect(b).toHaveAttribute("title", long);
    expect(b.className).toContain("max-w-full");
    expect(b.querySelector(".truncate")?.textContent).toBe(long);
  });

  it("a select takes the row's width up to a limit", () => {
    show(msg());
    const select = screen.getAllByTestId("component-select")[0]!;
    expect(select.className).toContain("w-full");
    expect(select.className).toContain("max-w-md");
    expect(within(select).getByTestId("component-select-trigger")).toHaveAttribute("aria-haspopup", "listbox");
    // The default option is shown as chosen.
    expect(within(select).getByTestId("component-select-trigger").textContent).toContain("Mage");
  });

  it("ignores components on messages of users and webhooks", () => {
    show(msg({ author_kind: "user", author: "mallory@t.local" }));
    expect(screen.queryByTestId("message-components")).toBeNull();
    show(msg({ id: "m2", author_kind: "webhook", author: "wh.x@t.local", webhook: { id: "w", name: "CI" } }));
    expect(screen.queryByTestId("message-components")).toBeNull();
  });

  it("renders nothing when one rule is broken (here: a sixth button in a row)", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ type: "button", style: "primary", label: `b${i}`, custom_id: `b${i}` }));
    show(msg({}, [{ type: "row", components: six }]));
    expect(screen.queryByTestId("message-components")).toBeNull();
    expect(screen.getByTestId("message").textContent).toContain("Raid on Friday");
  });

  it("shows disabled controls as aria-disabled and never invokes them", async () => {
    const e = env();
    show(msg({}, [{ type: "row", components: [{ type: "button", style: "primary", label: "Closed", custom_id: "c", disabled: true }] }]), e);
    const b = button("Closed");
    expect(b).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(b);
    expect(e.invoke).not.toHaveBeenCalled();
  });

  it("without the permission the controls are disabled with a note", () => {
    show(msg(), env({ canUse: false }));
    expect(button("Sign up")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("components-forbidden")).toBeTruthy();
  });

  it("a 410 from the node marks the message's components expired", async () => {
    const e = env({ invoke: vi.fn(async () => Promise.reject(Object.assign(new Error("gone"), { code: "component.expired", status: 410 }))) });
    show(msg(), e);
    await userEvent.click(button("Sign up"));
    await screen.findByTestId("components-expired");
    expect(button("Sign up")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("message-components").dataset.unusable).toBe("expired");
    // Link buttons never reach the node and stay usable.
    expect(button(/Guide/)).not.toHaveAttribute("aria-disabled");
  });

  it("a 404 (the application was removed) disables them with the reason", async () => {
    show(msg(), env({ invoke: vi.fn(async () => Promise.reject(Object.assign(new Error("gone"), { code: "component.not_found", status: 404 }))) }));
    await userEvent.click(button("Sign up"));
    expect((await screen.findByTestId("components-gone")).textContent).toMatch(/nicht mehr/);
    expect(button("Maybe")).toHaveAttribute("aria-disabled", "true");
  });

  it("other API errors are announced politely under the components", async () => {
    show(msg(), env({ invoke: vi.fn(async () => Promise.reject(Object.assign(new Error("x"), { code: "component.forbidden", problem: { code: "component.forbidden", status: 403, detail: "" } }))) }));
    await userEvent.click(button("Sign up"));
    const error = await screen.findByTestId("components-error");
    expect(error.getAttribute("role")).toBe("status");
    expect(error.textContent).toContain("Du darfst die Bedienelemente");
  });

  it("marks the pressed button busy until the node answered and blocks the others meanwhile", async () => {
    let finish!: () => void;
    const e = env({ invoke: vi.fn(() => new Promise<void>((r) => (finish = r))) });
    show(msg(), e);
    await userEvent.click(button("Sign up"));
    expect(e.invoke).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }), "signup", null);
    expect(button("Sign up")).toHaveAttribute("aria-busy", "true");
    expect(button("Maybe")).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(button("Maybe"));
    expect(e.invoke).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(button("Sign up")).not.toHaveAttribute("aria-busy");
  });

  it("an answer to a component says who used the application and jumps to the message", async () => {
    const jump = vi.fn();
    const answer = msg({ id: "m2", content: { type: "text", body: "Bob signed up" }, interaction: { id: "i1", kind: "component", command: null, application: "t.local/raid", user: "bob@t.local", message_id: "m1" } as unknown as Message["interaction"] });
    show(answer, env({ jump }));
    const line = screen.getByTestId("message-interaction");
    expect(line.dataset.kind).toBe("component");
    expect(line.textContent).toContain("bob hat raid-bot verwendet");
    await userEvent.click(screen.getByTestId("message-interaction-jump"));
    expect(jump).toHaveBeenCalledWith("m1");
  });

  it("a link button asks first and names the full URL", async () => {
    const e = env();
    show(msg(), e);
    await userEvent.click(button(/Guide/));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("component-link-url").textContent).toBe("https://guide.example/raid");
    const open = within(dialog).getByTestId("component-link-open");
    expect(open).toHaveAttribute("href", "https://guide.example/raid");
    expect(open.getAttribute("rel")).toContain("noopener");
    expect(e.invoke).not.toHaveBeenCalled();
  });
});

describe("message components: selects", () => {
  beforeEach(() => act(() => useUnusableComponents.setState({ state: {} })));

  it("a single select is a listbox: arrow keys move, Enter picks and invokes at once", async () => {
    const e = env();
    show(msg(), e);
    const trigger = within(screen.getAllByTestId("component-select")[0]!).getByTestId("component-select-trigger");
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("listbox", { name: "Your class" });
    expect(list).toHaveFocus();
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(options[0]!.textContent).toContain("Melee, plate");
    // The active option starts at the chosen one (Mage); ArrowDown → Healer.
    expect(list.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(list.getAttribute("aria-activedescendant")).toBe(options[2]!.id);
    fireEvent.keyDown(list, { key: "Enter" });
    expect(e.invoke).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }), "class", ["healer"]);
    expect(screen.queryByRole("listbox")).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("Escape closes the listbox and gives the focus back", async () => {
    show(msg());
    const trigger = within(screen.getAllByTestId("component-select")[0]!).getByTestId("component-select-trigger");
    await userEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("a multi select needs the confirm button within min and max", async () => {
    const e = env();
    show(msg(), e);
    const select = screen.getAllByTestId("component-select")[1]!;
    await userEvent.click(within(select).getByTestId("component-select-trigger"));
    const list = within(select).getByRole("listbox");
    expect(list).toHaveAttribute("aria-multiselectable", "true");
    const confirm = within(select).getByTestId("component-select-confirm");
    expect(confirm).toBeDisabled();
    const [mon, tue, wed] = within(list).getAllByRole("option");
    await userEvent.click(mon!);
    await userEvent.click(tue!);
    // At max: the third option cannot be added.
    expect(wed).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(wed!);
    expect(within(select).getByTestId("component-select-count").textContent).toContain("2");
    expect(e.invoke).not.toHaveBeenCalled();
    await userEvent.click(confirm);
    expect(e.invoke).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }), "days", ["mon", "tue"]);
  });
});
