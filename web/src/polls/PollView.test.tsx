// SPDX-License-Identifier: Apache-2.0
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, TavrnApi } from "@tavrn/sdk";
import { pollHash, pollVoteContent, type Decrypted, type Poll } from "@tavrn/e2ee";
import { MessageList } from "../components/MessageList";
import { PollContext, pollVotesKey, type PollVoteRecord } from "./context";
import { useConversationPolls } from "./env";
import { pollHandlers } from "./votes";

const ME = "me@t.local";
const choicePoll = { type: "poll", kind: "choice", question: "Wohin gehen wir?", options: [{ id: "a", label: "Küche" }, { id: "b", label: "Garten" }], max_choices: 1, results_visible: "always", votes_visible: "public" } as const;
const datePoll = {
  type: "poll",
  kind: "date",
  question: "Teamessen?",
  slots: [
    { id: "s1", start: "2026-11-06T19:00:00+01:00", end: "2026-11-06T22:00:00+01:00" },
    { id: "s2", start: "2026-11-07T00:00:00+01:00", all_day: true },
  ],
  results_visible: "always",
  votes_visible: "public",
} as const;

function message(content: Record<string, unknown>, extra: Partial<Message> = {}): Message {
  return { id: "01POLL", conversation_id: "c1", author: "alice@t.local", author_id: "u2", device_id: null, encrypted: false, format: 1, epoch: null, content, reply_to_id: null, thread_id: null, mentions: [], mentions_everyone: false, created_at: new Date().toISOString(), edited_at: null, attachments: [], reactions: [], pinned: false, poll_closes_at: null, ...extra } as Message;
}

async function record(user: string, content: Record<string, unknown>, sel: Parameters<typeof pollVoteContent>[3], updated = "2026-10-14T10:00:00Z", hashOf: Record<string, unknown> = content): Promise<PollVoteRecord> {
  const { type: _t, ...poll } = content;
  const vote = pollVoteContent(poll as unknown as Poll, "01POLL", await pollHash(hashOf), sel);
  return { user, device_id: "d9", epoch: null, content: vote, created_at: updated, updated_at: updated, conversation_id: "c1", message_id: "01POLL", signature: null };
}

function fakeApi(records: PollVoteRecord[]) {
  const polls = {
    votes: vi.fn(async () => ({ items: records })),
    vote: vi.fn(async (_c: string, m: string, req: { content: unknown }) => ({ user: ME, user_id: "u1", device_id: "d1", epoch: null, content: req.content, signature: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), conversation_id: "c1", message_id: m })),
    retract: vi.fn(async () => undefined),
    close: vi.fn(async (_c: string, m: string) => message(choicePoll, { id: m, poll_closes_at: new Date().toISOString() })),
  };
  return { polls } as unknown as TavrnApi & { polls: typeof polls };
}

function Env({ api, children, canManage = false, canVote = true, onClosed = () => {} }: { api: TavrnApi; children: React.ReactNode; canManage?: boolean; canVote?: boolean; onClosed?: (m: Message) => void }) {
  const env = useConversationPolls({ api, conversationId: "c1", q: "t.local/c1", encrypted: false, mls: null, me: ME, canVote, canManage, name: (a) => a.split("@")[0]!.toUpperCase(), encryptVote: () => Promise.reject(new Error("plaintext")), onClosed });
  return <PollContext.Provider value={env}>{children}</PollContext.Provider>;
}

function show(messages: Message[], api: TavrnApi, opts: { canManage?: boolean; canVote?: boolean; decrypted?: Record<string, Decrypted>; onClosed?: (m: Message) => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Env api={api} canManage={opts.canManage} canVote={opts.canVote} onClosed={opts.onClosed}>
        <MessageList messages={messages} currentUserId="u1" canManage={false} hasMore={false} decrypted={opts.decrypted} encrypted={!!opts.decrypted} />
      </Env>
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => vi.restoreAllMocks());

describe("PollView", () => {
  it("a choice poll: vote → results → change → form prefilled → keep or save → results; retract from the form", async () => {
    const user = userEvent.setup();
    const api = fakeApi([await record("bob@t.local", choicePoll, { choices: ["b"] })]);
    show([message(choicePoll)], api);
    const poll = await screen.findByTestId("poll");
    expect(within(poll).getByRole("heading", { name: "Wohin gehen wir?" })).toBeInTheDocument();
    expect(within(poll).getByTestId("poll-kind")).toHaveTextContent("Umfrage");
    await waitFor(() => expect(within(poll).getByTestId("poll-voters")).toHaveTextContent("1 Stimme"));
    // Plaintext without a session manager: the vote counts, marked unverified.
    expect(within(poll).getByTestId("poll-unverified")).toHaveTextContent("1 nicht bestätigt");
    // Not voted yet: the form, with the bars (results always visible) but without the voters' names.
    expect(poll).toHaveAttribute("data-view", "form");
    expect(within(poll).getAllByTestId("poll-option")[1]).toHaveTextContent("1 · 100 %");
    expect(within(poll).queryByText("BOB")).toBeNull();
    expect(within(poll).getByRole("button", { name: "Abstimmen" })).toBeDisabled();
    // A look at the results before voting, and back.
    await user.click(within(poll).getByRole("button", { name: "Ergebnisse zeigen" }));
    expect(poll).toHaveAttribute("data-view", "results");
    expect(within(poll).getAllByTestId("poll-option")[1]).toHaveTextContent("BOB");
    expect(within(poll).queryByRole("radio")).toBeNull();
    await user.click(within(poll).getByRole("button", { name: "Abstimmen" }));
    expect(poll).toHaveAttribute("data-view", "form");

    await user.click(within(poll).getByRole("radio", { name: /Küche/ }));
    await user.click(within(poll).getByRole("button", { name: "Abstimmen" }));
    expect(api.polls.vote).toHaveBeenCalledTimes(1);
    const [, messageId, req] = api.polls.vote.mock.calls[0]!;
    expect(messageId).toBe("01POLL");
    expect(req.content).toMatchObject({ type: "poll.vote", choices: ["a"], ctx: { poll: "01POLL", poll_hash: await pollHash(choicePoll) } });
    // Voted: the results, the own vote marked.
    await waitFor(() => expect(poll).toHaveAttribute("data-view", "results"));
    const kitchen = within(poll).getAllByTestId("poll-option")[0]!;
    expect(kitchen).toHaveAttribute("data-mine", "true");
    expect(kitchen).toHaveTextContent("Deine Stimme");
    expect(kitchen).toHaveTextContent("1 · 50 %");
    expect(within(poll).getByTestId("poll-voters")).toHaveTextContent("2 Stimmen");
    expect(within(poll).queryByRole("radio")).toBeNull();
    expect(within(poll).queryByRole("button", { name: "Stimme zurückziehen" })).toBeNull();

    // "Change vote": the form prefilled with the own vote; "Keep" returns without a request.
    await user.click(within(poll).getByRole("button", { name: "Stimme ändern" }));
    expect(poll).toHaveAttribute("data-view", "form");
    expect(within(poll).getByRole("radio", { name: /Küche/ })).toBeChecked();
    expect(within(poll).getAllByTestId("poll-option")[0]).toHaveTextContent("Deine Stimme");
    await user.click(within(poll).getByRole("radio", { name: /Garten/ }));
    await user.click(within(poll).getByRole("button", { name: "Behalten" }));
    expect(poll).toHaveAttribute("data-view", "results");
    expect(api.polls.vote).toHaveBeenCalledTimes(1);
    // Change and save: back to the results with the new vote.
    await user.click(within(poll).getByRole("button", { name: "Stimme ändern" }));
    expect(within(poll).getByRole("radio", { name: /Küche/ })).toBeChecked();
    await user.click(within(poll).getByRole("radio", { name: /Garten/ }));
    await user.click(within(poll).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(within(poll).getAllByTestId("poll-option")[1]).toHaveTextContent("2 · 100 %"));
    expect(poll).toHaveAttribute("data-view", "results");
    expect(within(poll).getAllByTestId("poll-option")[1]).toHaveAttribute("data-mine", "true");
    // Saving an unchanged vote just returns.
    await user.click(within(poll).getByRole("button", { name: "Stimme ändern" }));
    await user.click(within(poll).getByRole("button", { name: "Speichern" }));
    expect(poll).toHaveAttribute("data-view", "results");
    expect(api.polls.vote).toHaveBeenCalledTimes(2);
    // Retract from the form: the empty form again.
    await user.click(within(poll).getByRole("button", { name: "Stimme ändern" }));
    await user.click(within(poll).getByRole("button", { name: "Stimme zurückziehen" }));
    expect(api.polls.retract).toHaveBeenCalledWith("c1", "01POLL");
    await waitFor(() => expect(within(poll).getByTestId("poll-voters")).toHaveTextContent("1 Stimme"));
    expect(poll).toHaveAttribute("data-view", "form");
    expect(within(poll).queryByTestId("poll-mine")).toBeNull();
    expect(within(poll).getByRole("radio", { name: /Garten/ })).not.toBeChecked();
  });

  it("rolls the own vote back when the node refuses it and keeps the form with the choice", async () => {
    const user = userEvent.setup();
    const api = fakeApi([]);
    api.polls.vote.mockRejectedValueOnce(new Error("Diese Umfrage ist beendet."));
    show([message(choicePoll)], api);
    const poll = await screen.findByTestId("poll");
    await waitFor(() => expect(within(poll).getByTestId("poll-voters")).toHaveTextContent("0 Stimmen"));
    await user.click(within(poll).getByRole("radio", { name: /Küche/ }));
    await user.click(within(poll).getByRole("button", { name: "Abstimmen" }));
    await waitFor(() => expect(within(poll).getByTestId("poll-voters")).toHaveTextContent("0 Stimmen"));
    expect(within(poll).queryByTestId("poll-mine")).toBeNull();
    expect(poll).toHaveAttribute("data-view", "form");
    expect(within(poll).getByRole("radio", { name: /Küche/ })).toBeChecked();
  });

  it("a multiple-choice vote is changed in the form prefilled with every own option", async () => {
    const user = userEvent.setup();
    const multi = { ...choicePoll, options: [...choicePoll.options, { id: "c", label: "Keller" }], max_choices: 2 };
    const api = fakeApi([await record(ME, multi, { choices: ["a", "c"] })]);
    show([message(multi)], api);
    const poll = await screen.findByTestId("poll");
    await waitFor(() => expect(poll).toHaveAttribute("data-view", "results"));
    expect(within(poll).getAllByTestId("poll-mine")).toHaveLength(2);
    await user.click(within(poll).getByRole("button", { name: "Stimme ändern" }));
    expect(within(poll).getByRole("checkbox", { name: /Küche/ })).toBeChecked();
    expect(within(poll).getByRole("checkbox", { name: /Keller/ })).toBeChecked();
    expect(within(poll).getByRole("checkbox", { name: /Garten/ })).toBeDisabled();
    await user.click(within(poll).getByRole("checkbox", { name: /Keller/ }));
    await user.click(within(poll).getByRole("checkbox", { name: /Garten/ }));
    await user.click(within(poll).getByRole("button", { name: "Speichern" }));
    expect(api.polls.vote.mock.calls[0]![2].content).toMatchObject({ choices: ["a", "b"] });
    await waitFor(() => expect(poll).toHaveAttribute("data-view", "results"));
  });

  it("honours results after voting and votes hidden until the close", async () => {
    const user = userEvent.setup();
    const hidden = { ...choicePoll, results_visible: "after_vote", votes_visible: "hidden_until_close" };
    const api = fakeApi([await record("bob@t.local", hidden, { choices: ["b"] })]);
    show([message(hidden)], api);
    const poll = await screen.findByTestId("poll");
    await waitFor(() => expect(within(poll).getByTestId("poll-results-hidden")).toHaveTextContent("Die Ergebnisse siehst du nach deiner Abstimmung."));
    expect(within(poll).queryByTestId("poll-count")).toBeNull();
    await user.click(within(poll).getByRole("radio", { name: /Küche/ }));
    await user.click(within(poll).getByRole("button", { name: "Abstimmen" }));
    await waitFor(() => expect(within(poll).getAllByTestId("poll-count")).toHaveLength(2));
    expect(poll).toHaveAttribute("data-view", "results");
    expect(within(poll).getByTestId("poll-votes-hidden")).toBeInTheDocument();
    expect(within(poll).queryByText("BOB")).toBeNull();
  });

  it("a closed poll takes no votes and shows every voter", async () => {
    const hidden = { ...choicePoll, votes_visible: "hidden_until_close" };
    const api = fakeApi([await record("bob@t.local", hidden, { choices: ["b"] }, "2026-01-01T00:00:00Z"), await record(ME, hidden, { choices: ["a"] }, "2026-01-01T00:00:00Z")]);
    show([message(hidden, { poll_closes_at: "2026-01-02T00:00:00Z" })], api);
    const poll = await screen.findByTestId("poll");
    expect(within(poll).getByTestId("poll-closed")).toHaveTextContent("Beendet");
    await waitFor(() => expect(within(poll).getByText("BOB")).toBeInTheDocument());
    // The results only: no form, no "Change vote", nothing to close.
    expect(poll).toHaveAttribute("data-view", "results");
    expect(within(poll).queryByRole("button", { name: "Abstimmen" })).toBeNull();
    expect(within(poll).queryByTestId("poll-change")).toBeNull();
    expect(within(poll).queryByRole("radio")).toBeNull();
    expect(within(poll).getAllByTestId("poll-option")[0]).toHaveAttribute("data-mine", "true");
    expect(within(poll).queryByTestId("poll-close-now")).toBeNull();
  });

  it("never counts votes on an earlier version or after the close and says so", async () => {
    const earlier = { ...choicePoll, question: "Früher" };
    const api = fakeApi([
      await record(ME, choicePoll, { choices: ["a"] }, "2026-10-14T10:00:00Z", earlier),
      await record("bob@t.local", choicePoll, { choices: ["b"] }, "2026-10-14T10:00:00Z", earlier),
      await record("carol@t.local", choicePoll, { choices: ["b"] }, "2099-01-01T00:00:00Z"),
    ]);
    show([message(choicePoll, { poll_closes_at: "2098-01-01T00:00:00Z" })], api);
    const poll = await screen.findByTestId("poll");
    await waitFor(() => expect(within(poll).getByTestId("poll-stale")).toHaveTextContent("2 zu einer früheren Fassung (nicht gezählt)"));
    expect(within(poll).getByTestId("poll-voters")).toHaveTextContent("0 Stimmen");
    expect(within(poll).getByTestId("poll-mine-stale")).toHaveTextContent("Du hast zu einer früheren Fassung");
  });

  it("the author closes the poll early after confirming", async () => {
    const user = userEvent.setup();
    const api = fakeApi([]);
    const onClosed = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    show([message(choicePoll, { author_id: "u1", author: ME, poll_closes_at: "2099-01-01T00:00:00Z" })], api, { onClosed });
    const poll = await screen.findByTestId("poll");
    expect(within(poll).getByTestId("poll-closes")).toHaveTextContent(/^Endet in [\d.,]+ Tagen$/);
    await user.click(within(poll).getByRole("button", { name: "Umfrage jetzt beenden" }));
    expect(api.polls.close).toHaveBeenCalledWith("c1", "01POLL");
    await waitFor(() => expect(onClosed).toHaveBeenCalled());
  });

  it("shows a poll closed early at once (its close time just passed)", async () => {
    const api = fakeApi([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (m: Message) => (
      <QueryClientProvider client={client}>
        <Env api={api}>
          <MessageList messages={[m]} currentUserId="u1" canManage={false} hasMore={false} />
        </Env>
      </QueryClientProvider>
    );
    const { rerender } = render(view(message(choicePoll, { poll_closes_at: "2099-01-01T00:00:00Z" })));
    expect(await screen.findByTestId("poll-closes")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    rerender(view(message(choicePoll, { poll_closes_at: new Date().toISOString() })));
    expect(await screen.findByTestId("poll-closed")).toHaveTextContent("Beendet");
  });

  it("only the author or a moderator may close", async () => {
    const api = fakeApi([]);
    show([message(choicePoll, { poll_closes_at: "2099-01-01T00:00:00Z" })], api);
    await waitFor(() => expect(screen.getByTestId("poll")).toBeInTheDocument());
    expect(screen.queryByTestId("poll-close-now")).toBeNull();
  });

  it("a moderator closes someone else's poll without a close time", async () => {
    const user = userEvent.setup();
    const api = fakeApi([]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    show([message(choicePoll)], api, { canManage: true });
    const poll = await screen.findByTestId("poll");
    expect(within(poll).queryByTestId("poll-closes")).toBeNull();
    await user.click(within(poll).getByRole("button", { name: "Umfrage jetzt beenden" }));
    expect(api.polls.close).toHaveBeenCalledWith("c1", "01POLL");
  });

  it("the author of a poll without a close time can close it; a declined confirmation changes nothing", async () => {
    const user = userEvent.setup();
    const api = fakeApi([]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    show([message(choicePoll, { author_id: "u1", author: ME })], api);
    const poll = await screen.findByTestId("poll");
    await user.click(within(poll).getByRole("button", { name: "Umfrage jetzt beenden" }));
    expect(api.polls.close).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await user.click(within(poll).getByRole("button", { name: "Umfrage jetzt beenden" }));
    expect(api.polls.close).toHaveBeenCalledWith("c1", "01POLL");
  });

  it("the author sees the results of their own poll before voting; other members only after voting", async () => {
    const hidden = { ...choicePoll, results_visible: "after_vote" };
    const api = fakeApi([await record("bob@t.local", hidden, { choices: ["b"] })]);
    show([message(hidden, { author_id: "u1", author: ME }), message(hidden, { id: "01OTHER" })], api);
    await waitFor(() => expect(screen.getAllByTestId("poll")).toHaveLength(2));
    const [mine, other] = screen.getAllByTestId("poll").sort((a, b) => (a.closest("[data-message-id]")!.getAttribute("data-message-id")! === "01POLL" ? -1 : 1) - (b.closest("[data-message-id]")!.getAttribute("data-message-id")! === "01POLL" ? -1 : 1));
    await waitFor(() => expect(within(mine!).getAllByTestId("poll-count")).toHaveLength(2));
    expect(within(mine!).queryByTestId("poll-results-hidden")).toBeNull();
    // The second poll loads its votes independently: wait for its notice before asserting the absence of counts.
    await waitFor(() => expect(within(other!).getByTestId("poll-results-hidden")).toBeInTheDocument());
    expect(within(other!).queryByTestId("poll-count")).toBeNull();
  });

  it("date polls: the form per day, then the results grid with the best slot, the answers of a slot and the members' table", async () => {
    const user = userEvent.setup();
    const api = fakeApi([await record("bob@t.local", datePoll, { answers: { s1: "yes", s2: "maybe" } }), await record("carol@t.local", datePoll, { answers: { s1: "maybe", s2: "no" } })]);
    show([message(datePoll)], api);
    const poll = await screen.findByTestId("poll");
    expect(within(poll).getByTestId("poll-kind")).toHaveTextContent("Terminumfrage");
    await waitFor(() => expect(within(poll).getByTestId("poll-voters")).toHaveTextContent("2 Stimmen"));
    expect(poll).toHaveAttribute("data-view", "form");
    // The form: one group per day, per slot yes / maybe / no with text and icon.
    expect(within(poll).getByRole("group", { name: "Fr., 6. Nov." })).toBeInTheDocument();
    const [s1, s2] = within(poll).getAllByTestId("poll-slot");
    expect(s2).toHaveTextContent("ganztägig");
    expect(within(s1!).getByRole("radio", { name: /Ja/ })).not.toBeChecked();
    await user.click(within(s2!).getByRole("radio", { name: /Ja/ }));
    await user.click(within(s1!).getByRole("radio", { name: /Nein/ }));
    await user.click(within(poll).getByRole("button", { name: "Abstimmen" }));
    expect(api.polls.vote.mock.calls[0]![2].content).toMatchObject({ answers: { s1: "no", s2: "yes" } });

    // The results: the best slot on top, a cell per slot with counts, ★ and the own answer.
    await waitFor(() => expect(poll).toHaveAttribute("data-view", "results"));
    expect(within(poll).getByTestId("poll-best")).toHaveTextContent(/Beste Termine.*6\. Nov\., 19:00 – 22:00.*1 ja, 1 vielleicht, 1 nein/);
    const grid = within(poll).getByRole("grid", { name: "Ergebnisse von Teamessen?" });
    expect(within(grid).getAllByRole("columnheader")).toHaveLength(3);
    expect(within(grid).getAllByRole("rowheader").map((h) => h.textContent)).toEqual(["ganztägig", "19:00 – 22:00"]);
    const cell = (slot: string) => grid.querySelector<HTMLButtonElement>(`[data-testid="poll-cell"][data-slot="${slot}"]`)!;
    expect(cell("s1")).toHaveAttribute("data-best", "true");
    expect(cell("s1")).toHaveAttribute("data-mine", "no");
    expect(cell("s1")).toHaveAccessibleName(/19:00 – 22:00\. 1 ja, 1 vielleicht, 1 nein\. bester Termin\. deine Antwort: Nein/);
    expect(cell("s2")).toHaveAccessibleName(/ganztägig\. 1 ja, 1 vielleicht, 1 nein\. bester Termin\. deine Antwort: Ja/);
    // Hover: the names in the title; click: the answers of the slot.
    expect(cell("s1")).toHaveAttribute("title", "✓ BOB · ? CAROL · ✗ ME");
    await user.click(cell("s1"));
    expect(cell("s1")).toHaveAttribute("aria-expanded", "true");
    const detail = within(poll).getByTestId("poll-slot-detail");
    expect(within(detail).getByTestId("poll-detail-yes")).toHaveTextContent("Ja (1): BOB");
    expect(within(detail).getByTestId("poll-detail-maybe")).toHaveTextContent("Vielleicht (1): CAROL");
    expect(detail).toHaveTextContent("Deine Antwort: Nein");

    // "Change vote": the form prefilled with the own answers; saved: the results again.
    await user.click(within(poll).getByRole("button", { name: "Stimme ändern" }));
    expect(poll).toHaveAttribute("data-view", "form");
    const [f1, f2] = within(poll).getAllByTestId("poll-slot");
    expect(within(f1!).getByRole("radio", { name: /Nein/ })).toBeChecked();
    expect(within(f2!).getByRole("radio", { name: /Ja/ })).toBeChecked();
    await user.click(within(f1!).getByRole("radio", { name: /Ja/ }));
    await user.click(within(poll).getByRole("button", { name: "Speichern" }));
    expect(api.polls.vote.mock.calls[1]![2].content).toMatchObject({ answers: { s1: "yes", s2: "yes" } });
    await waitFor(() => expect(within(poll).getByTestId("poll-best")).toHaveTextContent(/Bester Termin/));
    expect(poll).toHaveAttribute("data-view", "results");

    // Every member's answers on demand.
    await user.click(within(poll).getByRole("button", { name: "Alle Antworten zeigen" }));
    const table = within(poll).getByRole("table", { name: "Antworten auf Teamessen?" });
    const bob = within(table).getByRole("rowheader", { name: "BOB" }).closest("tr")!;
    expect(bob).toHaveTextContent(/Ja.*Vielleicht/);
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
  });

  it("the date results grid: days in columns, times in rows, one tab stop with arrow keys", async () => {
    const user = userEvent.setup();
    const many = {
      ...datePoll,
      slots: [
        { id: "s1", start: "2026-11-06T18:00:00+01:00" },
        { id: "s2", start: "2026-11-06T20:00:00+01:00" },
        { id: "s3", start: "2026-11-07T18:00:00+01:00" },
        { id: "s4", start: "2026-11-08T20:00:00+01:00" },
      ],
    };
    const api = fakeApi([await record(ME, many, { answers: { s1: "yes", s3: "maybe" } }), await record("bob@t.local", many, { answers: { s3: "yes", s4: "yes" } })]);
    show([message(many)], api);
    const poll = await screen.findByTestId("poll");
    await waitFor(() => expect(poll).toHaveAttribute("data-view", "results"));
    const grid = within(poll).getByRole("grid");
    expect(within(grid).getAllByRole("rowheader").map((h) => h.textContent)).toEqual(["18:00", "20:00"]);
    expect(within(grid).getAllByTestId("poll-cell").map((c) => c.getAttribute("data-slot"))).toEqual(["s1", "s3", "s2", "s4"]);
    // The best slot (bob yes + my maybe) is the tab stop.
    const cells = within(grid).getAllByTestId("poll-cell");
    expect(cells.filter((c) => c.tabIndex === 0).map((c) => c.getAttribute("data-slot"))).toEqual(["s3"]);
    expect(within(poll).getByTestId("poll-best")).toHaveTextContent("7. Nov.");
    cells[1]!.focus();
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toHaveAttribute("data-slot", "s1");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toHaveAttribute("data-slot", "s2");
    await user.keyboard("{End}");
    expect(document.activeElement).toHaveAttribute("data-slot", "s4");
    await user.keyboard("{Enter}");
    expect(within(poll).getByTestId("poll-slot-detail")).toHaveTextContent("Ja (1): BOB");
  });

  it("date results hidden until the close: the own answers only", async () => {
    const hidden = { ...datePoll, results_visible: "after_close" };
    const api = fakeApi([await record(ME, hidden, { answers: { s1: "maybe" } }), await record("bob@t.local", hidden, { answers: { s1: "yes" } })]);
    show([message(hidden)], api);
    const poll = await screen.findByTestId("poll");
    await waitFor(() => expect(poll).toHaveAttribute("data-view", "results"));
    expect(within(poll).getByTestId("poll-results-hidden")).toBeInTheDocument();
    expect(within(poll).queryByTestId("poll-best")).toBeNull();
    expect(within(poll).queryByTestId("poll-cell-bar")).toBeNull();
    const cell = within(poll).getAllByTestId("poll-cell")[1]!;
    expect(cell).toHaveAttribute("data-mine", "maybe");
    expect(cell).toHaveAccessibleName(/19:00 – 22:00\. deine Antwort: Vielleicht$/);
    expect(within(poll).getByRole("button", { name: "Stimme ändern" })).toBeEnabled();
  });

  it("an encrypted poll from before the member joined shows the voter count only", async () => {
    const api = fakeApi([await record("bob@t.local", choicePoll, { choices: ["a"] }), await record("carol@t.local", choicePoll, { choices: ["b"] })]);
    show([message({}, { encrypted: true, content: "Y2lwaGVy", device_id: "d2", epoch: 3, poll_closes_at: "2099-01-01T00:00:00Z" })], api, { decrypted: { "01POLL": { ok: false, reason: "missing_key" } } });
    expect(await screen.findByTestId("poll-before-join")).toHaveTextContent("Umfrage von vor deinem Beitritt");
    await waitFor(() => expect(screen.getByTestId("poll-before-join")).toHaveTextContent("2 Stimmen"));
  });

  it("a malformed poll is shown like an unknown type", () => {
    show([message({ ...choicePoll, options: [{ id: "a", label: "Nur eine" }] })], fakeApi([]));
    expect(screen.queryByTestId("poll")).toBeNull();
    expect(screen.getByTestId("message")).toHaveTextContent("(poll) kann dein Client nicht anzeigen");
  });
});

describe("poll realtime", () => {
  it("poll.vote replaces the voter's record (last device wins), poll.vote.delete removes it, unknown polls are ignored", () => {
    const handlers = new Map<string, (d: unknown) => void>();
    const socket = { on: (type: string, fn: (d: unknown) => void) => (handlers.set(type, fn), () => handlers.delete(type)) };
    const client = new QueryClient();
    const key = pollVotesKey("c1", "01POLL");
    client.setQueryData<PollVoteRecord[]>(key, [{ user: "bob@t.local", device_id: "d1", content: { a: 1 }, created_at: "1", updated_at: "1" }]);
    const offs = pollHandlers(socket as never, client);
    act(() => handlers.get("poll.vote")!({ conversation_id: "c1", message_id: "01POLL", user: "bob@t.local", device_id: "d2", content: { a: 2 }, created_at: "1", updated_at: "2" }));
    expect(client.getQueryData<PollVoteRecord[]>(key)).toEqual([expect.objectContaining({ device_id: "d2", content: { a: 2 } })]);
    act(() => handlers.get("poll.vote")!({ conversation_id: "c1", message_id: "OTHER", user: "x", content: {}, created_at: "1", updated_at: "1" }));
    expect(client.getQueryData(pollVotesKey("c1", "OTHER"))).toBeUndefined();
    act(() => handlers.get("poll.vote.delete")!({ conversation_id: "c1", message_id: "01POLL", user: "bob@t.local" }));
    expect(client.getQueryData<PollVoteRecord[]>(key)).toEqual([]);
    offs.forEach((off) => off());
    expect(handlers.size).toBe(0);
  });
});
