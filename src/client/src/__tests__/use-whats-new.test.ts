import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWhatsNew } from '../composables/use-whats-new'

interface ChangelogPayload {
  currentVersion: string
  versions: { version: string; notes: string }[]
}

function mockChangelog(payload: ChangelogPayload, ok = true): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    json: async () => payload,
  }) as unknown as typeof fetch
}

const ALL_VERSIONS = [
  { version: '1.7.14', notes: 'Latest release' },
  { version: '1.7.13', notes: 'Previous release' },
  { version: '1.7.12', notes: 'Older release' },
]

describe('useWhatsNew', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('records the version silently on first launch', async () => {
    mockChangelog({ currentVersion: '1.7.14', versions: ALL_VERSIONS })
    const { showDialog, checkForUpdate } = useWhatsNew()

    await checkForUpdate()

    expect(showDialog.value).toBe(false)
    expect(localStorage.getItem('kobo:last-seen-version')).toBe('1.7.14')
  })

  it('does nothing when the version is unchanged', async () => {
    localStorage.setItem('kobo:last-seen-version', '1.7.14')
    mockChangelog({ currentVersion: '1.7.14', versions: ALL_VERSIONS })
    const { showDialog, checkForUpdate } = useWhatsNew()

    await checkForUpdate()

    expect(showDialog.value).toBe(false)
  })

  it('shows every version released since the last-seen one, newest first', async () => {
    localStorage.setItem('kobo:last-seen-version', '1.7.12')
    mockChangelog({ currentVersion: '1.7.14', versions: ALL_VERSIONS })
    const { showDialog, newVersions, checkForUpdate } = useWhatsNew()

    await checkForUpdate()

    expect(showDialog.value).toBe(true)
    expect(newVersions.value.map((v) => v.version)).toEqual(['1.7.14', '1.7.13'])
    expect(localStorage.getItem('kobo:last-seen-version')).toBe('1.7.14')
  })

  it('updates last-seen but skips the dialog when no entries match', async () => {
    localStorage.setItem('kobo:last-seen-version', '1.7.13')
    mockChangelog({ currentVersion: '1.7.14', versions: [{ version: '1.7.12', notes: 'old' }] })
    const { showDialog, checkForUpdate } = useWhatsNew()

    await checkForUpdate()

    expect(showDialog.value).toBe(false)
    expect(localStorage.getItem('kobo:last-seen-version')).toBe('1.7.14')
  })

  it('stays silent on a failed request', async () => {
    localStorage.setItem('kobo:last-seen-version', '1.7.12')
    mockChangelog({ currentVersion: '1.7.14', versions: ALL_VERSIONS }, false)
    const { showDialog, checkForUpdate } = useWhatsNew()

    await checkForUpdate()

    expect(showDialog.value).toBe(false)
  })
})
