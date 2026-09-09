export interface ChangelogEntry {
  version: string
  notes: string
}

/**
 * Parse a Keep-a-Changelog markdown file into ordered version sections. Each
 * `## <version>` heading starts a new entry; everything until the next heading
 * is its notes. A leading `v` on the version is stripped.
 */
export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let current: { version: string; lines: string[] } | null = null

  for (const line of markdown.split('\n')) {
    const heading = line.match(/^##\s+v?(\d+\.\d+\.\d+[\w./-]*)\s*$/)
    if (heading) {
      if (current) entries.push({ version: current.version, notes: current.lines.join('\n').trim() })
      current = { version: heading[1], lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) entries.push({ version: current.version, notes: current.lines.join('\n').trim() })
  return entries
}
