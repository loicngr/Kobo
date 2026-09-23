import { useTemplatesStore } from 'src/stores/templates'
import { KOBO_COMMANDS } from 'src/utils/kobo-commands'
import { computed, type Ref, ref, watch } from 'vue'

/** Item rendered in the slash-autocomplete popup. */
export interface SlashDropdownItem {
  type: 'skill' | 'kobo' | 'template'
  name: string
  description?: string
}

interface UseSlashAutocompleteOptions {
  /**
   * When true, omit the "Kōbō commands" section from the dropdown.
   * Useful in contexts where those slash-commands have no meaning yet
   * (e.g. the workspace creation form: there's no workspace to "check
   * progress" on or "prep for auto-loop" yet).
   */
  excludeKoboCommands?: boolean
}

/**
 * Stateful logic for the `/<fragment>` slash autocomplete used in chat-style
 * inputs (ChatInput, CreatePage's initial prompt, …). Encapsulates:
 *
 * - fetching `/api/skills` (cached, throttled to once every 5s)
 * - detecting the `/<fragment>` token immediately preceding the caret
 * - filtering skills / Kōbō commands / user templates by the typed fragment
 * - exposing a flat list for keyboard navigation, plus a structured grouping
 *   for the popup's section headers
 * - replacing the fragment in the input with a chosen completion
 *
 * Selection of an item (template expansion, kobo auto-send, etc.) is left to
 * the caller — that logic is too context-specific to hide in a composable.
 *
 * @param message      reactive ref bound to the input's textual value
 * @param getInputEl   accessor returning the live <textarea>/<input> element
 *                     (needed for `selectionStart` since v-model loses caret
 *                     info)
 * @param opts         optional behavioural tweaks
 */
export function useSlashAutocomplete(
  message: Ref<string>,
  getInputEl: () => HTMLTextAreaElement | HTMLInputElement | null,
  opts: UseSlashAutocompleteOptions = {},
) {
  const templatesStore = useTemplatesStore()

  const skills = ref<string[]>([])
  const showSkills = ref(false)
  const skillFilter = ref('')
  const selectedSkillIndex = ref(0)
  let lastFetch = 0

  async function fetchSkills(): Promise<void> {
    const now = Date.now()
    if (now - lastFetch < 5000 && skills.value.length > 0) return
    lastFetch = now
    try {
      const res = await fetch('/api/skills')
      if (res.ok) skills.value = await res.json()
    } catch {
      /* network errors are not fatal — popup just shows kobo + templates */
    }
  }

  /** Returns the slash-fragment preceding the current caret, or null. */
  function getSlashFragmentBeforeCaret(): string | null {
    const el = getInputEl()
    if (!el) return null
    const caret = el.selectionStart ?? message.value.length
    const before = message.value.slice(0, caret)
    const match = before.match(/\/([\w:.-]*)$/)
    return match ? match[1] : null
  }

  /**
   * Re-evaluate whether the popup should be visible based on the current
   * caret position and message text. Fetches skills lazily on first open.
   * Call this after the message changes (the watch below already does it).
   */
  async function detectSlashFragment(): Promise<void> {
    const fragment = getSlashFragmentBeforeCaret()
    if (fragment !== null) {
      await fetchSkills()
      skillFilter.value = fragment
      showSkills.value = true
      selectedSkillIndex.value = 0
    } else {
      showSkills.value = false
    }
  }

  function closeDropdown(): void {
    showSkills.value = false
  }

  /**
   * Replace the slash-fragment immediately preceding the caret with `expanded`.
   * Falls back to whole-input replacement if no fragment is found, which keeps
   * the caller's "user picked something" path observable rather than silently
   * doing nothing.
   */
  function replaceFragmentWith(expanded: string): void {
    const el = getInputEl()
    if (!el) {
      message.value = expanded
      return
    }
    const caret = el.selectionStart ?? message.value.length
    const before = message.value.slice(0, caret)
    const after = message.value.slice(caret)
    const match = before.match(/\/[\w:.-]*$/)
    if (!match) {
      message.value = expanded
      return
    }
    const fragmentStart = match.index ?? caret
    message.value = message.value.slice(0, fragmentStart) + expanded + after
  }

  const groupedDropdown = computed<{
    skills: SlashDropdownItem[]
    kobo: SlashDropdownItem[]
    templates: SlashDropdownItem[]
  }>(() => {
    const q = skillFilter.value.toLowerCase()
    const matches = (name: string) => (q === '' ? true : name.toLowerCase().includes(q))

    const claudeSkills = skills.value
      .filter((s) => matches(s))
      .map<SlashDropdownItem>((s) => ({ type: 'skill', name: s }))

    const koboCommands = opts.excludeKoboCommands
      ? []
      : Object.keys(KOBO_COMMANDS)
          .map((k) => k.replace(/^\//, ''))
          .filter((k) => matches(k))
          .map<SlashDropdownItem>((name) => ({ type: 'kobo', name }))

    const tpls = templatesStore.templates
      .filter((t) => matches(t.slug))
      .map<SlashDropdownItem>((t) => ({ type: 'template', name: t.slug, description: t.description }))

    return { skills: claudeSkills, kobo: koboCommands, templates: tpls }
  })

  /** Concatenated skills + kobo + templates — for keyboard navigation. */
  const flatDropdown = computed<SlashDropdownItem[]>(() => [
    ...groupedDropdown.value.skills,
    ...groupedDropdown.value.kobo,
    ...groupedDropdown.value.templates,
  ])

  // Keep the selection index inside bounds when filter shrinks the list.
  watch(
    () => flatDropdown.value.length,
    (len) => {
      if (len === 0) {
        selectedSkillIndex.value = 0
        return
      }
      if (selectedSkillIndex.value >= len) {
        selectedSkillIndex.value = len - 1
      }
    },
  )

  return {
    skills,
    showSkills,
    skillFilter,
    selectedSkillIndex,
    groupedDropdown,
    flatDropdown,
    fetchSkills,
    detectSlashFragment,
    replaceFragmentWith,
    closeDropdown,
  }
}
