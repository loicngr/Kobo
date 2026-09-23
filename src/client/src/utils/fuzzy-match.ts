/**
 * fzf-style fuzzy match: every character of `query` must appear in `text`, in
 * order, but not necessarily contiguously. Returns a score (higher is better)
 * or `null` when there is no match. An empty query matches everything (score 0).
 *
 * Scoring favours contiguous runs and matches at segment boundaries (start of
 * the string, or right after `/ - _ .`), and slightly penalises long strings
 * so shorter, tighter paths bubble up.
 */
export function fuzzyMatch(query: string, text: string): number | null {
  if (query === '') return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()

  let score = 0
  let cursor = 0
  let prevMatch = -2

  for (const ch of q) {
    let found = -1
    for (let i = cursor; i < t.length; i++) {
      if (t[i] === ch) {
        found = i
        break
      }
    }
    if (found === -1) return null

    score += found === prevMatch + 1 ? 5 : 1
    const prevChar = found > 0 ? t[found - 1] : ''
    if (found === 0 || prevChar === '/' || prevChar === '-' || prevChar === '_' || prevChar === '.') {
      score += 2
    }

    prevMatch = found
    cursor = found + 1
  }

  return score - text.length * 0.01
}

/** Filter + rank `items` against `query`, best match first. */
export function fuzzyRank(query: string, items: string[]): string[] {
  return items
    .map((item) => ({ item, score: fuzzyMatch(query, item) }))
    .filter((r): r is { item: string; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.item)
}

/**
 * Rank `items` and keep only the best `limit`, in one pass.
 *
 * `fuzzyRank` scored every entry, allocated one wrapper object per entry, then
 * sorted the whole list before the caller sliced fifty results off it. On a
 * forty-thousand-file monorepo that ran on every keystroke, inside a
 * synchronous watcher. This keeps a bounded, sorted array of at most `limit`
 * entries: same results, same order, no full sort and no forty-thousand-entry
 * intermediate.
 *
 * `score` is injectable so tests can count how many times each item is scored.
 */
export function fuzzyRankTop(
  query: string,
  items: readonly string[],
  limit: number,
  score: (query: string, text: string) => number | null = fuzzyMatch,
): string[] {
  if (limit <= 0) return []
  const best: Array<{ item: string; score: number }> = []
  for (const item of items) {
    const value = score(query, item)
    if (value === null) continue
    // At capacity, anything not strictly better than the current worst is
    // dropped — `<=` keeps the earlier item on a tie, matching the stable sort.
    if (best.length === limit && value <= best[limit - 1].score) continue
    let i = best.length
    while (i > 0 && best[i - 1].score < value) i--
    best.splice(i, 0, { item, score: value })
    if (best.length > limit) best.pop()
  }
  return best.map((entry) => entry.item)
}
