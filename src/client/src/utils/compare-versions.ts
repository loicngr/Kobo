/**
 * Compare two dotted version strings numerically.
 * Returns a negative number if `a < b`, `0` if equal, a positive number if
 * `a > b`. Non-numeric suffixes (e.g. `1.7.14-beta`) reduce to their leading
 * integer, and missing segments are treated as `0`.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => v.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
