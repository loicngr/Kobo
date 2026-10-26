export type QuestionSelections = Record<string, string[]>

/** Native multi-select values travel separately from legacy human-readable answers. */
export function parseQuestionSelections(value: unknown): QuestionSelections | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('selections must be an object of string arrays')
  const entries = Object.entries(value)
  if (
    entries.length > 20 ||
    entries.some(
      ([key, values]) =>
        !key ||
        key.length > 200 ||
        !Array.isArray(values) ||
        values.length > 32 ||
        values.some((item) => typeof item !== 'string' || item.length > 2000),
    )
  )
    throw new Error('selections exceed their field, choice or string limits')
  return value as QuestionSelections
}
