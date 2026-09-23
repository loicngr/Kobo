/** JSON.parse with a message a user can act on: a truncated or non-JSON CLI
 *  response otherwise surfaces as a raw "Unexpected token…" 500. */
export function parseCliJson<T>(raw: string, context: string): T {
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    // Keep the diagnostic trail: the user-facing message stays terse, but the
    // original parse error and a sample of the offending output land in the
    // server log so "unparsable output" reports can actually be investigated.
    console.error(`[forge] ${context} returned unparsable output:`, err, raw.slice(0, 200))
    throw new Error(`${context} returned unparsable output`)
  }
}
