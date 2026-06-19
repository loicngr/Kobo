export const OTHER_OPTION_VALUE = '__KOBO_OTHER__'

export const OTHER_INSTRUCTION =
  'Other — the user will provide a free-form clarification in their next ' +
  'message. Please wait for their input before proceeding.'

/** True when any answer (single value or any element of a multiSelect array)
 *  is the "Other" sentinel — meaning the user owes a free-form follow-up. */
export function hasOtherSelection(values: Array<string | string[]>): boolean {
  return values.some((v) => (Array.isArray(v) ? v.includes(OTHER_OPTION_VALUE) : v === OTHER_OPTION_VALUE))
}

export function expandOtherAnswer(value: string | string[], multiSelect: boolean): string {
  if (multiSelect) {
    const labels = Array.isArray(value) ? value : []
    return labels.map((l) => (l === OTHER_OPTION_VALUE ? OTHER_INSTRUCTION : l)).join(', ')
  }
  const single = Array.isArray(value) ? (value[0] ?? '') : value
  return single === OTHER_OPTION_VALUE ? OTHER_INSTRUCTION : single
}
