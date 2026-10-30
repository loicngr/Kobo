import { defineStore } from 'pinia'

function savedWidth(key: string, fallback: number, min: number, max: number): number {
  const value = Number(localStorage.getItem(key) ?? fallback)
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

/**
 * UI state for the two side drawers, shared between MainLayout (which owns the
 * drawers) and WorkspacePage (which renders the toggle buttons in .wp-header).
 */
export const useLayoutStore = defineStore('layout', {
  state: () => ({
    leftDrawerOpen: true,
    rightDrawerOpen: true,
    leftDrawerWidth: savedWidth('at-left-drawer-width', 260, 140, 500),
    rightDrawerWidth: savedWidth('kobo:rightDrawerWidth', 300, 240, 800),
  }),
  actions: {
    toggleLeft() {
      this.leftDrawerOpen = !this.leftDrawerOpen
    },
    toggleRight() {
      this.rightDrawerOpen = !this.rightDrawerOpen
    },
    setLeft(value: boolean) {
      this.leftDrawerOpen = value
    },
    setRight(value: boolean) {
      this.rightDrawerOpen = value
    },
    /** Closed on small screens, open on large. Called on breakpoint crossing. */
    applyScreenSize(isSmall: boolean) {
      this.leftDrawerOpen = !isSmall
      this.rightDrawerOpen = !isSmall
    },
  },
})
