import { fuzzyMatch } from './fuzzy-match'

/** One row of the command palette. */
export interface PaletteEntry {
  id: string
  label: string
  icon: string
  /** Secondary text shown under the label, and searched too — a branch name,
   *  a project, a keyboard hint. */
  hint?: string
  run: () => void
}

/** A label hit must outrank a hint-only hit, or every workspace whose branch
 *  mentions the query would bubble above the command actually named after it. */
const LABEL_WEIGHT = 2
const HINT_WEIGHT = 1

/**
 * Filter AND rank palette entries against `query`, best match first. An empty
 * query returns the list unchanged so the curated catalogue keeps its order.
 */
export function rankCommands<T extends PaletteEntry>(query: string, entries: T[]): T[] {
  const q = query.trim()
  if (q === '') return entries

  return entries
    .map((entry) => {
      const onLabel = fuzzyMatch(q, entry.label)
      const onHint = entry.hint ? fuzzyMatch(q, entry.hint) : null
      const scores: number[] = []
      if (onLabel !== null) scores.push(onLabel * LABEL_WEIGHT)
      if (onHint !== null) scores.push(onHint * HINT_WEIGHT)
      return { entry, score: scores.length > 0 ? Math.max(...scores) : null }
    })
    .filter((row): row is { entry: T; score: number } => row.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.entry)
}

/**
 * True when the event target is a text-entry surface. Global shortcuts must
 * step aside for it: intercepting Ctrl+F while the user writes a message
 * steals the browser's own find, and does it silently.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return target.isContentEditable
}
