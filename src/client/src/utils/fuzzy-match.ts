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
