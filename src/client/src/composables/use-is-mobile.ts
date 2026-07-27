import { useQuasar } from 'quasar'
import { computed } from 'vue'

/**
 * Single source of truth for "phone portrait" (< 600px, Quasar `lt.sm`).
 * Reused by SettingsPage, WorkspacePage and ChatInput to branch layout.
 */
export function useIsMobile() {
  const $q = useQuasar()
  const isMobile = computed(() => $q.screen.lt.sm)
  return { isMobile }
}
