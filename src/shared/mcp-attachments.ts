import { MAX_ATTACHMENTS, MAX_ATTACHMENTS_BYTES, validateAttachments } from './attachments.js'

/** Inline upload budget for creation and message tools, including base64 expansion. */
export const MAX_MCP_ATTACHMENT_REQUEST_BYTES = Math.ceil(MAX_ATTACHMENTS_BYTES / 3) * 4 + 1024 * 1024
export interface McpAttachment {
  name: string
  mime_type: string
  data_base64: string
}
export const MCP_ATTACHMENTS_SCHEMA = {
  type: 'array' as const,
  maxItems: MAX_ATTACHMENTS,
  description:
    'Inline files/images: up to 10 files, 50 MiB decoded total. Send canonical base64 bytes, never a server file path.',
  items: {
    type: 'object' as const,
    properties: {
      name: { type: 'string' as const, minLength: 1, maxLength: 255 },
      mime_type: { type: 'string' as const, maxLength: 200 },
      data_base64: { type: 'string' as const, minLength: 1, maxLength: Math.ceil(MAX_ATTACHMENTS_BYTES / 3) * 4 },
    },
    required: ['name', 'mime_type', 'data_base64'],
    additionalProperties: false as const,
  },
}

/** Validate types, names, canonical base64 and decoded bounds before any writes. */
export function validateMcpAttachments(value: unknown): McpAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS)
    throw new Error('attachments must contain at most 10 files')
  const files = value
  const metadata = files.map((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid attachment')
    const file = input as Record<string, unknown>
    if (Object.keys(file).some((key) => !['name', 'mime_type', 'data_base64'].includes(key)))
      throw new Error('Unknown attachment field')
    if (typeof file.name !== 'string' || !file.name.trim() || file.name.length > 255 || file.name.includes('\0'))
      throw new Error('Invalid attachment name')
    if (typeof file.mime_type !== 'string' || file.mime_type.length > 200 || file.mime_type.includes('\0'))
      throw new Error('Invalid attachment MIME type')
    if (typeof file.data_base64 !== 'string' || file.data_base64.length > Math.ceil(MAX_ATTACHMENTS_BYTES / 3) * 4)
      throw new Error('Invalid attachment data_base64')
    if (/[/\\]/.test(file.name) || file.name === '.' || file.name === '..')
      throw new Error('Attachment name must be a filename, not a path')
    const data = file.data_base64
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
      throw new Error('Attachment data_base64 must be canonical base64')
    // Reject non-zero pad bits too, before the server allocates decoded buffers.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    if (
      (data.endsWith('==') && (alphabet.indexOf(data.at(-3)!) & 15) !== 0) ||
      (!data.endsWith('==') && data.endsWith('=') && (alphabet.indexOf(data.at(-2)!) & 3) !== 0)
    )
      throw new Error('Attachment data_base64 must be canonical base64')
    return {
      name: file.name,
      type: file.mime_type,
      size: (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0),
    }
  })
  const error = validateAttachments(metadata)
  if (error) throw new Error(`Invalid attachments: ${error}`)
  return files as McpAttachment[]
}
