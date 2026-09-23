/**
 * Deep-copy plain form data, reading THROUGH Vue's reactive proxies.
 *
 * `structuredClone` is not usable here: the settings form is `reactive()` /
 * `ref()` state, so its arrays and nested objects are Proxy exotic objects, and
 * the structured-clone algorithm refuses them outright
 * (`DataCloneError: #<Object> could not be cloned`) — it takes the whole page
 * down at `setup()` time. Walking the value with `Object.entries` / `map` goes
 * through the proxy traps and yields plain, detached data.
 *
 * Only what a settings form actually holds is supported: primitives, arrays,
 * plain objects and dates. That is also exactly the shape `formFieldsEqual`
 * knows how to compare.
 */
function deepClonePlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepClonePlain)
  if (value instanceof Date) return new Date(value.getTime())
  if (value !== null && typeof value === 'object') {
    const cloned: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) cloned[key] = deepClonePlain(entry)
    return cloned
  }
  return value
}

/**
 * Take a snapshot of a form's fields that is fully DETACHED from the live
 * values it was read from.
 *
 * A shallow copy (`{ ...form }`) is not enough: the settings form holds arrays
 * (tags, branch prefixes) and nested objects (devServer, e2e, finalization)
 * that are edited **in place** — `push`, `splice`, or a `v-model` on a nested
 * field. A shallow snapshot shares those references with the live form, so the
 * snapshot changes at the same time as the value it is supposed to be compared
 * against: the dirty check compares the snapshot to itself, concludes nothing
 * changed, and the unsaved-changes bar never shows up. The edit is then lost
 * silently when the user leaves the page.
 */
export function captureFormSnapshot<T extends Record<string, unknown>>(fields: T): Record<string, unknown> {
  return deepClonePlain(fields) as Record<string, unknown>
}
