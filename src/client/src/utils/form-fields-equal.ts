function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!valuesEqual(a[i], b[i])) return false
    }
    return true
  }
  if (isPlainObject(a) && isPlainObject(b)) return formFieldsEqual(a, b)
  return false
}

/**
 * Compare two form snapshots field by field, short-circuiting on the first
 * difference.
 *
 * The settings page used to detect changes by JSON-serialising 76 variables and
 * comparing the two strings — recomputed on every keystroke, and five of those
 * fields hold multi-kilobyte shell scripts. Typing in a large script was
 * visibly stuttering. In the common case (one field edited, 75 untouched) this
 * costs 75 reference comparisons and stops at the one that differs.
 */
export function formFieldsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.hasOwn(b, key)) return false
    if (!valuesEqual(a[key], b[key])) return false
  }
  return true
}
