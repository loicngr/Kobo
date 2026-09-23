/** Bounds and formats shared by the create form and multipart endpoint. */
const IMAGE_EXTENSIONS: Record<string, string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
}
export const DOCUMENT_EXTENSIONS = [
  '.md',
  '.markdown',
  '.txt',
  '.text',
  '.pdf',
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.xml',
  '.log',
  '.rst',
  '.toml',
] as const
export const ATTACHMENT_ACCEPT = [
  ...Object.keys(IMAGE_EXTENSIONS),
  ...Object.values(IMAGE_EXTENSIONS).flat(),
  ...DOCUMENT_EXTENSIONS,
].join(',')
export const MAX_ATTACHMENTS = 10
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
export const MAX_ATTACHMENTS_BYTES = 50 * 1024 * 1024
export const MAX_ATTACHMENT_REQUEST_BYTES = MAX_ATTACHMENTS_BYTES + 1024 * 1024

export type AttachmentError = 'type' | 'size' | 'count' | 'total'

export function attachmentFormat(file: {
  name?: string
  type: string
}): { kind: 'image' | 'file'; extension: string } | null {
  const extension = /\.[^.\\/]+$/.exec(file.name ?? '')?.[0]?.toLowerCase() ?? ''
  const imageExtensions = IMAGE_EXTENSIONS[file.type]
  if (imageExtensions)
    return { kind: 'image', extension: imageExtensions.includes(extension) ? extension : imageExtensions[0]! }
  // Browsers vary in their MIME labels for text documents, especially Markdown.
  if ((DOCUMENT_EXTENSIONS as readonly string[]).includes(extension)) return { kind: 'file', extension }
  if (
    (!file.type || file.type === 'application/octet-stream') &&
    Object.values(IMAGE_EXTENSIONS).some((values) => values.includes(extension))
  ) {
    return { kind: 'image', extension }
  }
  return null
}

export function validateAttachments(
  files: readonly { name?: string; type: string; size: number }[],
): AttachmentError | null {
  if (files.length > MAX_ATTACHMENTS) return 'count'
  if (files.some((file) => !attachmentFormat(file))) return 'type'
  if (files.some((file) => file.size === 0 || file.size > MAX_ATTACHMENT_BYTES)) return 'size'
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENTS_BYTES) return 'total'
  return null
}
