import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const backendTypes = readFileSync(resolve(here, '../server/services/agent/engines/types.ts'), 'utf-8')
const frontendTypes = readFileSync(resolve(here, '../client/src/types/agent-event.ts'), 'utf-8')

/**
 * Extract the `export type AgentEvent = ...` union body as a string so we can
 * compare the backend and frontend declarations without importing both (the
 * client has its own tsconfig + package root).
 *
 * The extraction is crude but deterministic: it captures the `export type
 * AgentEvent =` header and every following line until the first blank line
 * that is followed by a new top-level declaration. Variant lines start with
 * `  |` and continuation lines are indented further.
 */
function extractAgentEventBlock(source: string): string {
  const start = source.indexOf('export type AgentEvent =')
  if (start < 0) throw new Error('AgentEvent type not found')
  const after = source.slice(start)
  const lines = after.split('\n')
  const bodyLines: string[] = []
  for (const line of lines) {
    // Stop when we hit a blank line followed by a non-indented, non-comment,
    // non-continuation line (i.e. the next top-level declaration).
    if (bodyLines.length > 0 && line.trim() === '') {
      bodyLines.push(line)
      continue
    }
    if (
      bodyLines.length > 0 &&
      !line.startsWith(' ') &&
      !line.startsWith('\t') &&
      !line.startsWith('|') &&
      line.trim() !== ''
    ) {
      break
    }
    bodyLines.push(line)
  }
  return bodyLines.join('\n').trim()
}

describe('AgentEvent backend/frontend sync', () => {
  it('has identical AgentEvent union blocks in backend and frontend types files', () => {
    const backendBlock = extractAgentEventBlock(backendTypes)
    const frontendBlock = extractAgentEventBlock(frontendTypes)
    expect(frontendBlock).toBe(backendBlock)
  })
})
