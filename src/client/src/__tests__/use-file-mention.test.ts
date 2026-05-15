import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useFileMention } from '../composables/use-file-mention'

function fakeInput(selectionStart: number): HTMLTextAreaElement {
  return { selectionStart } as HTMLTextAreaElement
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ files: ['file1.txt', 'src/components/Foo.vue', 'pouet.txt'] }),
    } as Response),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useFileMention', () => {
  it('opens the popup and fuzzy-ranks files for an `@<fragment>` before the caret', async () => {
    const message = ref('look at @fi')
    const m = useFileMention(
      message,
      () => fakeInput(message.value.length),
      () => '/wt',
    )

    await m.detectMentionFragment()

    expect(m.showFiles.value).toBe(true)
    expect(m.fileMatches.value).toContain('file1.txt')
  })

  it('does not open the popup without an `@` token before the caret', async () => {
    const message = ref('just text')
    const m = useFileMention(
      message,
      () => fakeInput(message.value.length),
      () => '/wt',
    )

    await m.detectMentionFragment()

    expect(m.showFiles.value).toBe(false)
  })

  it('ignores an `@` that is not at a word boundary (e.g. an e-mail)', async () => {
    const message = ref('me@example')
    const m = useFileMention(
      message,
      () => fakeInput(message.value.length),
      () => '/wt',
    )

    await m.detectMentionFragment()

    expect(m.showFiles.value).toBe(false)
  })

  it('replaces the `@<fragment>` with the chosen file path plus a trailing space', async () => {
    const message = ref('see @fi')
    const m = useFileMention(
      message,
      () => fakeInput(message.value.length),
      () => '/wt',
    )

    await m.detectMentionFragment()
    m.replaceFragmentWith('file1.txt')

    expect(message.value).toBe('see file1.txt ')
    expect(m.showFiles.value).toBe(false)
  })
})
