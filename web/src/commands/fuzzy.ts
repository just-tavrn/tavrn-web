// SPDX-License-Identifier: Apache-2.0
/**
 * Small fuzzy matcher for the command palette: exact > prefix > substring > subsequence, shorter names first.
 * Returns -1 when `query` does not match.
 */
export function fuzzyScore(query: string, name: string): number {
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  if (!q) return 1;
  if (n === q) return 1000;
  if (n.startsWith(q)) return 800 - n.length;
  const at = n.indexOf(q);
  if (at >= 0) return 600 - at * 10 - n.length;
  let i = 0;
  let gaps = 0;
  let last = -1;
  for (let j = 0; j < n.length && i < q.length; j++) {
    if (n[j] === q[i]) {
      if (last >= 0) gaps += j - last - 1;
      last = j;
      i++;
    }
  }
  return i === q.length ? 300 - gaps * 5 - n.length : -1;
}

/** Items whose `key` matches `query`, best first (stable for equal scores). */
export function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, key(item)) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.item);
}
