import { describe, expect, it } from 'vitest'
import { resolveExtractedName, truncateWorkspaceName } from '../server/utils/workspace-name.js'

describe('truncateWorkspaceName', () => {
  it('leaves a short name alone and caps a long one with an ellipsis', () => {
    expect(truncateWorkspaceName('short')).toBe('short')
    const long = 'x'.repeat(250)
    expect(truncateWorkspaceName(long)).toHaveLength(200)
    expect(truncateWorkspaceName(long).endsWith('…')).toBe(true)
  })
})

describe('resolveExtractedName', () => {
  it('replaces the bare placeholder with the extracted title', () => {
    expect(resolveExtractedName('workspace', 'Fix the parser')).toBe('Fix the parser')
  })

  it('never touches a name the user typed', () => {
    expect(resolveExtractedName('my own name', 'Fix the parser')).toBeNull()
    expect(resolveExtractedName('workspaces', 'Fix the parser')).toBeNull()
    expect(resolveExtractedName('workspace2 (Codex)', 'Fix the parser')).toBeNull()
  })

  it('truncates an extracted title', () => {
    const name = resolveExtractedName('workspace', 'y'.repeat(300))
    expect(name?.endsWith('…')).toBe(true)
  })
})
