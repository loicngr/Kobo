export const OTHER_OPTION_VALUE = '__KOBO_OTHER__'

export const OTHER_INSTRUCTION =
  'Other — the user will provide a free-form clarification in their next ' +
  'message. Please wait for their input before proceeding.'

export function expandOtherAnswer(value: string | string[], multiSelect: boolean): string {
  if (multiSelect) {
    const labels = Array.isArray(value) ? value : []
    return labels.map((l) => (l === OTHER_OPTION_VALUE ? OTHER_INSTRUCTION : l)).join(', ')
  }
  const single = Array.isArray(value) ? (value[0] ?? '') : value
  return single === OTHER_OPTION_VALUE ? OTHER_INSTRUCTION : single
}
