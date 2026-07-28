import { useQuasar } from 'quasar'
import { computed } from 'vue'

/**
 * Responsive breakpoints for the client.
 * - isMobile: phone portrait (< 600px, Quasar `lt.sm`) — layout compactness.
 * - isDrawerCollapsed: the global left drawer is an overlay (< 1024px, `lt.md`),
 *   matching MainLayout's DRAWER_BREAKPOINT. Use for "re-open the drawer" affordances.
 */
export function useIsMobile() {
  const $q = useQuasar()
  const isMobile = computed(() => $q.screen.lt.sm)
  const isDrawerCollapsed = computed(() => $q.screen.lt.md)
  return { isMobile, isDrawerCollapsed }
}
