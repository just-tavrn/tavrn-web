// SPDX-License-Identifier: Apache-2.0
/**
 * Lazy history (design note 4.4): the messages of the open conversation as TanStack infinite query pages.
 * Page 0 is the newest page (`GET …/messages?limit=50`), every further page is older (`before` = the
 * oldest id loaded so far); inside a page messages are newest first, as the node returns them.
 *
 * Memory bound: older pages are only kept while the user reads them. When the user is back at the
 * newest messages, `trimPages` drops the oldest pages beyond `MAX_CACHED` messages; closing the
 * conversation drops everything (the query has `gcTime: 0`).
 *
 * Jumps (a search result, PROTOCOL.md §7 `around`): the pages then start with the page around the target,
 * the view is *detached* from the live end; newer pages are fetched as TanStack "previous" pages
 * (`after` = the newest id loaded) until a page is not full. Live messages are not prepended while
 * detached (they arrive with the newer pages); "jump to latest" resets the query to the newest page.
 */
import type { InfiniteData } from "@tanstack/react-query";
import type { Message, TavrnApi } from "@tavrn/sdk";

export const PAGE = 50;
/** Messages kept per conversation once the user is back at the bottom. */
export const MAX_CACHED = 200;

export type MessagePages<M> = InfiniteData<M[], unknown>;

/**
 * Query options of the message pages. `structuralSharing` is off: a live message is prepended, which
 * shifts every index, and TanStack's deep merge then copies every loaded message into a new object
 * (each one compared with its former neighbour). New identities defeat the memoized message rows, so
 * every incoming message re-rendered the whole list (design note 9e). The pages only change through the
 * helpers below, which keep untouched messages as they are.
 */
export const MESSAGE_QUERY_OPTIONS = {
  // The WebSocket keeps the pages current (a resync refetches everything).
  staleTime: Infinity,
  // Dropped when the conversation closes.
  gcTime: 0,
  structuralSharing: false,
} as const;

interface WithId {
  id: string;
}

/** All loaded messages, newest first. */
export function flatten<M>(data: MessagePages<M> | undefined): M[] {
  return data ? data.pages.flat() : [];
}

/** `before` cursor for the next (older) page, or undefined when the last page was not full. */
export function nextCursor<M extends WithId>(lastPage: M[]): string | undefined {
  return lastPage.length < PAGE ? undefined : lastPage.at(-1)?.id;
}

/** The parameter of a page: older than (`before`), newer than (`after`) or around a message; none = newest page. */
export type PageParam = { before?: string; after?: string; around?: string } | undefined;

/**
 * Fetches one page of `conversationId`, newest first (the node returns `after` pages oldest first). With `thread`,
 * a page of that thread (PROTOCOL.md §7e); without, the channel's own messages.
 */
export async function fetchPage(api: Pick<TavrnApi, "conversations">, conversationId: string, param: PageParam, thread?: string): Promise<Message[]> {
  const scope = thread ? { thread } : {};
  if (param?.after) return (await api.conversations.messages(conversationId, { limit: PAGE, after: param.after, ...scope })).reverse();
  if (param?.around) return api.conversations.messages(conversationId, { limit: PAGE, around: param.around, ...scope });
  return api.conversations.messages(conversationId, { limit: PAGE, before: param?.before, ...scope });
}

/** The query key of the loaded pages of a conversation, or of one of its threads. */
export function messagesKey(conversationId: string, thread?: string | null): unknown[] {
  return thread ? ["messages", conversationId, "thread", thread] : ["messages", conversationId];
}

/** Parameter of the next older page, or undefined at the start of the history. */
export function olderParam<M extends WithId>(lastPage: M[]): PageParam {
  const before = nextCursor(lastPage);
  return before ? { before } : undefined;
}

/**
 * Parameter of the next newer page while detached: after an `around` page with a full half of newer
 * messages or after a full `after` page; undefined at the live end.
 */
export function newerParam<M extends WithId>(firstPage: M[] | undefined, firstParam: unknown): PageParam {
  if (!firstPage?.length || !firstParam || typeof firstParam !== "object") return undefined;
  const p = firstParam as NonNullable<PageParam>;
  const newest = firstPage[0]!.id;
  if (p.around) {
    const around = p.around;
    const newer = firstPage.filter((m) => m.id > around).length;
    return newer >= Math.floor(PAGE / 2) ? { after: newest } : undefined;
  }
  if (p.after) return firstPage.length >= PAGE ? { after: newest } : undefined;
  return undefined;
}

/** Are newer messages than the loaded ones missing (a jump into the history)? */
export function isDetached<M extends WithId>(data: MessagePages<M> | undefined): boolean {
  return !!data && newerParam(data.pages[0], data.pageParams[0]) !== undefined;
}

/** A live message goes to the front of the newest page (once); not while detached from the live end. */
export function prependMessage<M extends WithId>(data: MessagePages<M> | undefined, m: M): MessagePages<M> | undefined {
  if (!data || isDetached(data) || data.pages.some((p) => p.some((x) => x.id === m.id))) return data;
  const [first = [], ...rest] = data.pages;
  return { ...data, pages: [[m, ...first], ...rest] };
}

/** Applies `fn` to every page (edits, deletions, purges). */
export function mapMessages<M>(data: MessagePages<M> | undefined, fn: (page: M[]) => M[]): MessagePages<M> | undefined {
  return data ? { ...data, pages: data.pages.map(fn) } : data;
}

/** Drops the oldest pages so that at most `max` messages stay (the newest page is cut if it alone is larger). */
export function trimPages<M>(data: MessagePages<M> | undefined, max = MAX_CACHED): MessagePages<M> | undefined {
  if (!data || data.pages.flat().length <= max) return data;
  const pages: M[][] = [];
  let total = 0;
  for (const p of data.pages) {
    if (pages.length > 0 && total + p.length > max) break;
    pages.push(pages.length === 0 ? p.slice(0, max) : p);
    total += pages.at(-1)!.length;
  }
  return { pages, pageParams: data.pageParams.slice(0, pages.length) };
}
