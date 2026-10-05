import { isMemoryToolName } from '../../../shared/memory-tools'

/** Empty terminal denials stay empty for the model; explain them only in the UI. */
export function isUnexplainedMemoryError(name: string, result?: { isError: boolean; output: unknown }): boolean {
  const toolName = name.replace(/^(?:mcp__kobo-tasks__|kobo__)/, '')
  if (!result?.isError || !isMemoryToolName(toolName)) return false
  const empty = (value: unknown): boolean => {
    if (value == null) return true
    if (typeof value === 'string') return value.trim() === '' || value.trim() === 'Unknown error'
    return false
  }
  if (Array.isArray(result.output))
    return result.output.every((block: unknown) => {
      if (!block || typeof block !== 'object') return false
      const content = block as { type?: unknown; text?: unknown }
      return content.type === 'text' && empty(content.text)
    })
  return empty(result.output)
}
