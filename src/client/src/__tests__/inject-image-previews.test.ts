import { describe, expect, it } from 'vitest'
import { injectImagePreviews } from '../utils/inject-image-previews'

describe('injectImagePreviews', () => {
  it('rewrites a single [image: .ai/images/xxx.png] to a markdown image', () => {
    const input = 'Look at this: [image: .ai/images/PSP0_RndCS.png]'
    const out = injectImagePreviews(input, 'ws-1')
    expect(out).toBe(
      'Look at this: ![.ai/images/PSP0_RndCS.png](/api/workspaces/ws-1/images/file?path=.ai%2Fimages%2FPSP0_RndCS.png)',
    )
  })

  it('rewrites multiple tokens in one message', () => {
    const input = '[image: .ai/images/a.png] and [image: .ai/images/b.jpg]'
    const out = injectImagePreviews(input, 'ws-1')
    expect(out).toContain('![.ai/images/a.png]')
    expect(out).toContain('![.ai/images/b.jpg]')
  })

  it('passes through non-upload image tokens unchanged (user-typed text)', () => {
    // If the user literally typed `[image: my idea]`, it's not an uploaded
    // image — leave it alone so we don't produce broken URLs.
    const input = "Here's [image: my idea] for the feature"
    const out = injectImagePreviews(input, 'ws-1')
    expect(out).toBe(input)
  })

  it('returns content unchanged when workspaceId is empty', () => {
    const input = '[image: .ai/images/x.png]'
    expect(injectImagePreviews(input, '')).toBe(input)
  })

  it('URL-encodes paths that contain special characters', () => {
    const input = '[image: .ai/images/my photo (1).png]'
    const out = injectImagePreviews(input, 'ws-1')
    // Spaces and parens must be percent-encoded so marked doesn't mis-parse
    // the ]() boundary of the resulting markdown image.
    expect(out).toContain('path=.ai%2Fimages%2Fmy%20photo%20(1).png')
  })

  it('rewrites paths under images/ (alternate layout) too', () => {
    const input = '[image: images/legacy.png]'
    const out = injectImagePreviews(input, 'ws-1')
    expect(out).toContain('![images/legacy.png]')
    expect(out).toContain('path=images%2Flegacy.png')
  })

  it('URL-encodes the workspace id so IDs with special chars work', () => {
    const input = '[image: .ai/images/x.png]'
    const out = injectImagePreviews(input, 'ws/with slash')
    expect(out).toContain('/api/workspaces/ws%2Fwith%20slash/')
  })
})
