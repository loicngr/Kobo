export interface DiffLine {
  type: 'add' | 'del' | 'context'
  content: string
}

/**
 * Compute a line-by-line diff using the Longest Common Subsequence algorithm.
 * Shared lines become `context`, differing lines are split into `del` (from
 * `oldText`) and `add` (from `newText`).
 */
export function computeInlineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const m = a.length
  const n = b.length

  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) lcs[i][j] = lcs[i + 1][j + 1] + 1
      else lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      result.push({ type: 'context', content: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ type: 'del', content: a[i] })
      i++
    } else {
      result.push({ type: 'add', content: b[j] })
      j++
    }
  }
  while (i < m) result.push({ type: 'del', content: a[i++] })
  while (j < n) result.push({ type: 'add', content: b[j++] })
  return result
}

export interface FileChangeInfo {
  toolName: 'Edit' | 'Write' | 'Bash:rm'
  filePath: string
  oldString?: string
  newString?: string
  content?: string
  replaceAll?: boolean
  additions: number
  deletions: number
}

/**
 * Extract file-change metadata from a `tool:call` input. Returns `null` if
 * the tool is not a file-mutating one (Edit, Write, or Bash with rm).
 */
export function getFileChangeInfo(toolName: string, input: unknown): FileChangeInfo | null {
  if (!input || typeof input !== 'object') return null
  const rec = input as Record<string, unknown>

  if (toolName === 'Edit') {
    const filePath = rec.file_path as string | undefined
    if (!filePath) return null
    const oldStr = (rec.old_string as string) ?? ''
    const newStr = (rec.new_string as string) ?? ''
    return {
      toolName: 'Edit',
      filePath,
      oldString: oldStr,
      newString: newStr,
      replaceAll: (rec.replace_all as boolean) ?? false,
      additions: newStr ? newStr.split('\n').length : 0,
      deletions: oldStr ? oldStr.split('\n').length : 0,
    }
  }

  if (toolName === 'Write') {
    const filePath = rec.file_path as string | undefined
    if (!filePath) return null
    const content = (rec.content as string) ?? ''
    return {
      toolName: 'Write',
      filePath,
      content,
      additions: content ? content.split('\n').length : 0,
      deletions: 0,
    }
  }

  if (toolName === 'Bash') {
    const cmd = (rec.command as string) ?? ''
    const rmMatch = cmd.match(/^\s*rm\s+(?:-[a-zA-Z]*\s+)*(.+)/)
    if (rmMatch) {
      const filePath = rmMatch[1].trim().replace(/["']/g, '')
      return {
        toolName: 'Bash:rm',
        filePath,
        additions: 0,
        deletions: 1,
      }
    }
  }

  return null
}
