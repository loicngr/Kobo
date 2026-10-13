import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import ScriptVariablesHelp from '../components/ScriptVariablesHelp.vue'
import fr from '../i18n/fr'

function render(event?: 'pr-merged' | 'session-ended' | 'autoloop-disabled' | 'kobo-shutdown') {
  return mount(ScriptVariablesHelp, {
    props: { event },
    global: { plugins: [createI18n({ legacy: false, locale: 'fr', messages: { fr } })] },
  })
}

describe('ScriptVariablesHelp', () => {
  it('offers expandable common help and explains missing Docker identity for archive/setup/cleanup', () => {
    const wrapper = render()
    expect(wrapper.get('summary').text()).toBe('Variables disponibles')
    expect(wrapper.get('details').attributes('open')).toBeUndefined()
    expect(wrapper.text()).toContain('WORKSPACE_ID')
    expect(wrapper.text()).toContain('PROJECT_PATH')
    expect(wrapper.text()).toContain('INSTANCE')
    expect(wrapper.text()).toContain('Vide si aucune instance ne correspond')
    expect(wrapper.text()).not.toContain('KOBO_HOOK_EVENT')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell guard
    expect(wrapper.text()).toContain('"${PROJECT_NAME:?Missing Docker project}"')
  })

  it.each([
    ['pr-merged', 'KOBO_PR_NUMBER', 'KOBO_SESSION_ID'],
    ['session-ended', 'KOBO_SESSION_EXIT_CODE', 'KOBO_PR_URL'],
    ['autoloop-disabled', 'KOBO_TASKS_PENDING', 'KOBO_SHUTDOWN_SIGNAL'],
    ['kobo-shutdown', 'KOBO_SHUTDOWN_SIGNAL', 'KOBO_AUTOLOOP_REASON'],
  ] as const)('shows only the event variables for %s', (event, included, excluded) => {
    const wrapper = render(event)
    expect(wrapper.text()).toContain('KOBO_HOOK_EVENT')
    expect(wrapper.text()).toContain(event)
    expect(wrapper.text()).toContain(included)
    expect(wrapper.text()).not.toContain(excluded)
  })
})
