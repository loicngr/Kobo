import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { useSlashAutocomplete } from '../composables/use-slash-autocomplete'

// Mock the templates store so the composable doesn't try to load real
// templates from disk. We test against a fixed seed list.
vi.mock('../stores/templates', () => ({
  useTemplatesStore: () => ({
    templates: [
      { slug: 'commit-msg', description: 'Generate a commit message', content: 'commit body' },
      { slug: 'review', description: 'Review my changes', content: 'review body' },
    ],
  }),
}))

describe('useSlashAutocomplete', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Mock /api/skills — return a stable list each call.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/skills') {
          return new Response(JSON.stringify(['superpowers:brainstorming', 'docs:post-dev', 'pr:update-description']), {
            status: 200,
          })
        }
        return new Response('not found', { status: 404 })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function makeFakeInput(value: string, caret = value.length): HTMLTextAreaElement {
    // Minimal stand-in that supports `selectionStart` and exposes the underlying
    // string. Avoids JSDOM dependency on test file.
    const el = {
      value,
      selectionStart: caret,
      focus: () => undefined,
      setSelectionRange: () => undefined,
    }
    return el as unknown as HTMLTextAreaElement
  }

  it('opens the dropdown when the user types `/` followed by a fragment', async () => {
    const message = ref('hello /rev')
    const input = makeFakeInput('hello /rev', 10)
    const ac = useSlashAutocomplete(message, () => input)

    await ac.detectSlashFragment()

    expect(ac.showSkills.value).toBe(true)
    expect(ac.skillFilter.value).toBe('rev')
  })

  it('closes the dropdown when there is no slash before the caret', async () => {
    const message = ref('plain text')
    const input = makeFakeInput('plain text')
    const ac = useSlashAutocomplete(message, () => input)
    ac.showSkills.value = true

    await ac.detectSlashFragment()

    expect(ac.showSkills.value).toBe(false)
  })

  it('exposes a flatDropdown sorted skills → kobo → templates', async () => {
    const message = ref('/')
    const input = makeFakeInput('/')
    const ac = useSlashAutocomplete(message, () => input)

    await ac.fetchSkills()
    await ac.detectSlashFragment()
    await nextTick()

    const types = ac.flatDropdown.value.map((d) => d.type)
    // Skills must come before kobo, kobo before templates.
    const firstKobo = types.indexOf('kobo')
    const firstTemplate = types.indexOf('template')
    const lastSkill = types.lastIndexOf('skill')
    expect(lastSkill).toBeLessThan(firstKobo)
    expect(firstKobo).toBeLessThan(firstTemplate)
  })

  it('filters skills by the typed fragment (case-insensitive substring)', async () => {
    const message = ref('/REV')
    const input = makeFakeInput('/REV')
    const ac = useSlashAutocomplete(message, () => input)

    await ac.fetchSkills()
    await ac.detectSlashFragment()
    await nextTick()

    const skillNames = ac.groupedDropdown.value.skills.map((s) => s.name)
    // Should not include 'superpowers:brainstorming' or 'docs:post-dev'.
    // Should include 'pr:update-description' (no 'rev'? -> actually no, this checks filter).
    // The mocked skills list doesn't contain 'rev' anywhere — assert empty.
    expect(skillNames).toEqual([])
    // But the matching template ('review') is captured in the templates section.
    const templates = ac.groupedDropdown.value.templates.map((t) => t.name)
    expect(templates).toContain('review')
  })

  it('hides Kōbō commands when excludeKoboCommands is set', async () => {
    const message = ref('/')
    const input = makeFakeInput('/')
    const ac = useSlashAutocomplete(message, () => input, { excludeKoboCommands: true })

    await ac.fetchSkills()
    await ac.detectSlashFragment()
    await nextTick()

    expect(ac.groupedDropdown.value.kobo).toEqual([])
  })

  it('replaceFragmentWith replaces the slash-fragment in the message at caret', () => {
    const message = ref('hello /rev')
    const input = makeFakeInput('hello /rev', 10)
    const ac = useSlashAutocomplete(message, () => input)

    ac.replaceFragmentWith('/review ')

    expect(message.value).toBe('hello /review ')
  })

  it('replaceFragmentWith is a no-op replacement (full message) when no slash is found', () => {
    const message = ref('plain text')
    const input = makeFakeInput('plain text')
    const ac = useSlashAutocomplete(message, () => input)

    ac.replaceFragmentWith('/foo ')

    // Falls back to overwriting whole input rather than corrupting context.
    expect(message.value).toBe('/foo ')
  })

  it('closeDropdown hides the popup', () => {
    const message = ref('/')
    const input = makeFakeInput('/')
    const ac = useSlashAutocomplete(message, () => input)
    ac.showSkills.value = true

    ac.closeDropdown()

    expect(ac.showSkills.value).toBe(false)
  })
})
