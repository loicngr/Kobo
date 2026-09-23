import { defineStore } from 'pinia'

/**
 * UI state for the two side drawers, shared between MainLayout (which owns the
 * drawers) and WorkspacePage (which renders the toggle buttons in .wp-header).
 */
export const useLayoutStore = defineStore('layout', {
  state: () => ({
    leftDrawerOpen: true,
    rightDrawerOpen: true,
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
