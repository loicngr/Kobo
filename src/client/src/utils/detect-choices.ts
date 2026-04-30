/**
 * Detect a multiple-choice question in an agent message.
 *
 * The agent often asks plan-mode questions like:
 *
 *   Quel format préfères-tu ?
 *
 *   - **A.** Date + heure sur une seule ligne
 *   - **B.** Date sur une ligne, heure en dessous
 *   - **C.** Heure uniquement
 *
 * When we can confidently spot that pattern we surface clickable buttons
 * under the message so the user replies with one keystroke. False
 * positives (a regular numbered list = "voici le plan") are filtered by
 * requiring a `?` to appear before the list — questions, not plans.
 *
 * Only the FIRST group is returned. Multi-question messages keep the UI
 * predictable; subsequent groups surface in subsequent agent messages.
 *
 * Returns `null` when no choice block is found.
 */

export interface DetectedChoice {
  /** Short key the user clicks ("A", "B", "1", "2", …). */
  key: string
  /** Markdown content following the bold key, with the leading bullet stripped. */
  label: string
}

export interface DetectedChoiceBlock {
  choices: DetectedChoice[]
}

const MAX_LINES_BETWEEN_QUESTION_AND_LIST = 5

/**
 * Match a single list item. Two accepted shapes after the bullet:
 *   - **A.** label    (bold key, letter or digit)
 *   - A. label        (un-bolded key, LETTERS ONLY — un-bolded digit-keys
 *                      are dropped to avoid mis-tagging numbered plan steps
 *                      ("- 1. lire le fichier") as choices)
 *
 * Captures: 1=bold-key (when bold form), 2=plain-key (when un-bolded letter).
 * Caller picks whichever is defined.
 */
const ITEM_RE = /^\s*(?:[-*]|\d+\.)\s+(?:\*\*([A-Za-z0-9])\.?\*\*|([A-Za-z])\.)\s+(.+?)\s*$/

export function detectChoices(text: string): DetectedChoiceBlock | null {
  if (!text) return null
  const lines = text.split('\n')

  // Walk lines, building "candidate groups" of consecutive matching items
  // (ignoring blank lines between them). A group is valid only if it has
  // ≥ 2 items AND a `?` appears in one of the
  // MAX_LINES_BETWEEN_QUESTION_AND_LIST lines immediately above the first item.
  let i = 0
  while (i < lines.length) {
    const startMatch = lines[i].match(ITEM_RE)
    if (!startMatch) {
      i++
      continue
    }

    // Found a potential first item. Collect consecutive items.
    const groupStart = i
    // Either group-1 (bold key) or group-2 (plain-letter key) is captured —
    // they're mutually exclusive in the regex. Group 3 is always the label.
    const items: DetectedChoice[] = [{ key: startMatch[1] ?? startMatch[2], label: startMatch[3] }]
    let j = i + 1
    while (j < lines.length) {
      const line = lines[j]
      if (line.trim() === '') {
        // Blank lines are tolerated INSIDE a group but limited to one in a row.
        if (j + 1 < lines.length && lines[j + 1].trim() === '') break
        j++
        continue
      }
      const m = line.match(ITEM_RE)
      if (!m) break
      items.push({ key: m[1] ?? m[2], label: m[3] })
      j++
    }

    if (items.length >= 2) {
      // Validate: a `?` must appear in the lines preceding groupStart.
      const lookFrom = Math.max(0, groupStart - MAX_LINES_BETWEEN_QUESTION_AND_LIST)
      const above = lines.slice(lookFrom, groupStart).join(' ')
      if (above.includes('?')) {
        return { choices: items }
      }
    }

    // Skip past this group (valid or not) and keep scanning. We want the
    // FIRST valid group, so the next iteration picks up after `j`.
    i = j
  }

  return null
}
