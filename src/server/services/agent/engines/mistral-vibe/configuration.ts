import type { MistralSelect } from '../../../../../shared/mistral-options.js'

export const MISTRAL_MODES = { interactive: 'ask', strict: 'accept-edits', bypass: 'auto-approve' } as const

export function assertMistralSelection(value: unknown, label: string): void {
  if (value !== undefined && !text(value))
    throw new Error(`Invalid Mistral Vibe ${label}; expected a nonempty native value of at most 256 characters`)
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown, max = 256): value is string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Native identities and labels must exclude control characters.
  return typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
}
function invalid(): never {
  throw new Error('Invalid Vibe ACP configuration options')
}

/** SDK responses are unchecked. Keep only bounded, validated native display fields. */
export function readMistralSelect(response: unknown, id: string, required = true): MistralSelect | undefined {
  if (!record(response) || !Array.isArray(response.configOptions) || response.configOptions.length > 64)
    return invalid()
  const ids = new Set<string>()
  for (const item of response.configOptions) {
    if (!record(item) || !text(item.id) || ids.has(item.id)) return invalid()
    ids.add(item.id)
  }
  const selected = response.configOptions.find((item) => item.id === id)
  if (!selected && !required) return undefined
  if (
    selected?.type !== 'select' ||
    !text(selected.currentValue) ||
    !Array.isArray(selected.options) ||
    selected.options.length > 256
  )
    return invalid()
  const options: MistralSelect['options'] = []
  const values = new Set<string>()
  const groups = new Set<string>()
  const append = (item: unknown, group?: string) => {
    if (
      !record(item) ||
      !text(item.value) ||
      !text(item.name) ||
      values.has(item.value) ||
      (item.description != null && !text(item.description, 2048)) ||
      options.length >= 256
    )
      return invalid()
    values.add(item.value)
    options.push({
      value: item.value,
      name: item.name,
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      ...(group ? { group } : {}),
    })
  }
  for (const item of selected.options) {
    if (record(item) && 'options' in item) {
      if (
        !text(item.group) ||
        !text(item.name) ||
        groups.has(item.group) ||
        !Array.isArray(item.options) ||
        item.options.length > 256
      )
        return invalid()
      groups.add(item.group)
      for (const option of item.options) append(option, item.name)
    } else append(item)
  }
  if (!values.has(selected.currentValue)) return invalid()
  return { currentValue: selected.currentValue, options }
}

export function requireMistralOption(response: unknown, id: string, value: string, confirmed = false): void {
  const option = readMistralSelect(response, id)!
  if (!option.options.some((item) => item.value === value) || (confirmed && option.currentValue !== value))
    throw new Error(
      `Mistral Vibe ${id} selection is unavailable or overridden by the native profile; refresh native options`,
    )
}
