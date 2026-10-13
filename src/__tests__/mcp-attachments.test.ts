import { describe, expect, it } from 'vitest'
import { validateMcpAttachments } from '../shared/mcp-attachments.js'
import { validateDialogueArguments } from '../shared/workspace-dialogue-tools.js'

const file = { name: 'note.md', mime_type: 'text/markdown', data_base64: 'YQ==' }
describe('MCP inline attachments', () => {
  it.each([
    null,
    {},
    [null],
    [{ ...file, name: '../note.md' }],
    [{ ...file, name: 'a\\b.md' }],
    [{ ...file, name: 'a\0.md' }],
    [{ ...file, path: '/etc/passwd' }],
    [{ ...file, name: 'app.exe' }],
    [{ ...file, data_base64: '' }],
    [{ ...file, data_base64: 'not base64' }],
    [{ ...file, data_base64: 'YR==' }],
    [{ ...file, data_base64: 'YWF=' }],
    [{ ...file, data_base64: 123 }],
    Array.from({ length: 11 }, () => file),
  ])('rejects invalid attachments before any decoding: case %#', (input) => {
    expect(() => validateMcpAttachments(input)).toThrow()
  })
  it('enforces the aggregate decoded byte limit', () => {
    const oversizedTotal = Array.from({ length: 2 }, () => ({
      ...file,
      data_base64: Buffer.alloc(26 * 1024 * 1024).toString('base64'),
    }))
    expect(() => validateMcpAttachments(oversizedTotal)).toThrow('total')
  })
  it('requires text or at least one attachment', () => {
    for (const input of [{}, { content: '' }, { content: '   ', attachments: [] }]) {
      expect(() => validateDialogueArguments('send_workspace_message', { workspace_id: 'ws', ...input })).toThrow()
    }
    expect(
      validateDialogueArguments('send_workspace_message', { workspace_id: 'ws', attachments: [file] }),
    ).toMatchObject({ content: '', attachments: [file] })
    expect(validateDialogueArguments('send_workspace_message', { workspace_id: 'ws', content: 'hello' })).toMatchObject(
      { content: 'hello' },
    )
  })
})
