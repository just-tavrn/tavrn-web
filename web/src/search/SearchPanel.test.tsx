// SPDX-License-Identifier: Apache-2.0
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import type { RoomDetail } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { mockFetch, renderWithProviders } from "../test/render";
import { SearchButton, useSearchUi } from "./SearchPanel";

const me = { id: "u1", username: "bob", domain: "t.local", address: "bob@t.local", display_name: "Bob", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const room = { id: "R1", name: "Lobby", channels: [{ id: "C1", kind: "text", name: "allgemein", encrypted: false }, { id: "C2", kind: "text", name: "geheim", encrypted: true }, { id: "V", kind: "voice", name: "voice", encrypted: true }] } as unknown as RoomDetail;
const hit = (id: string, body: string, at: string) => ({
  message: { id, conversation_id: "C1", author: "alice@t.local", author_id: "u2", created_at: at, encrypted: false, content: { type: "text", body }, attachments: [] },
  snippet: `say \u0001${body}\u0002 <b>x</b>`,
  rank: 0,
});

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
}

function view() {
  return renderWithProviders(
    <Routes>
      <Route
        path="*"
        element={
          <>
            <SearchButton conversationId="C1" encrypted={false} roomId="R1" room={room} />
            <Where />
          </>
        }
      />
    </Routes>,
    { route: "/rooms/R1/channels/C1" },
  );
}

describe("search panel", () => {
  beforeEach(() => {
    useAuth.setState({ token: "t", user: me });
    useSearchUi.setState({ open: false, query: "", scope: "room", filters: {}, rows: null, status: null, busy: false, context: "" });
  });

  it("searches the room, highlights matches as text, navigates with the keyboard and jumps to the message", async () => {
    const calls = mockFetch({ "/rooms/R1/search": { body: { results: [hit("M2", "zwei", "2026-10-06T10:00:00Z"), hit("M1", "eins", "2026-10-05T10:00:00Z")], next_cursor: null, searched: { kind: "node", channels: 1 } } } });
    const user = userEvent.setup();
    view();
    await user.click(screen.getByTestId("search-open"));
    const panel = screen.getByTestId("search-panel");
    const input = within(panel).getByTestId("search-input");
    expect(input).toHaveFocus();
    await user.type(input, "ei{Enter}");
    const rows = await screen.findAllByTestId("search-result");
    expect(rows).toHaveLength(2);
    expect(calls.find((c) => c.url.includes("/rooms/R1/search"))?.url).toContain("q=ei");
    // The marker becomes <mark>, markup in the snippet stays text.
    const mark = rows[0]!.querySelector("mark");
    expect(mark?.textContent).toBe("zwei");
    expect(rows[0]).toHaveTextContent("<b>x</b>");
    expect(rows[0]).toHaveTextContent("#allgemein");
    // Honest status: node channels, encrypted channels not searched while locked.
    expect(screen.getByTestId("search-status")).toHaveTextContent("1 unverschlüsselte(n) Channel(s)");
    expect(screen.getByTestId("search-status")).toHaveTextContent("nicht entsperrt");
    // Arrow keys move the selection, Enter opens it.
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(rows[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/rooms/R1/channels/C1?m=M1"));
  });

  it("filters go to the node, an empty query without filters is not sent, Escape closes", async () => {
    const calls = mockFetch({ "/rooms/R1/search": { body: { results: [], next_cursor: null, searched: { kind: "node", channels: 1 } } } });
    const user = userEvent.setup();
    view();
    await user.click(screen.getByTestId("search-open"));
    await user.click(screen.getByTestId("search-submit"));
    expect(await screen.findByTestId("search-empty")).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/search"))).toBe(false);
    await user.click(screen.getByTestId("search-filters-toggle"));
    const channels = screen.getByTestId("search-filter-channel");
    expect(within(channels).getAllByRole("option").map((o) => o.textContent)).toEqual(["Alle Channels", "#allgemein", "#geheim"]);
    await user.selectOptions(channels, "C1");
    await user.type(screen.getByTestId("search-filter-author"), "alice@t.local");
    await user.click(screen.getByTestId("search-filter-file"));
    await user.click(screen.getByTestId("search-submit"));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/search"))).toBe(true));
    const url = decodeURIComponent(calls.find((c) => c.url.includes("/search"))!.url);
    expect(url).toContain("channel=C1");
    expect(url).toContain("author=alice@t.local");
    expect(url).toContain("has=file");
    await user.click(screen.getByTestId("search-input"));
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("search-panel")).toBeNull();
  });
});
