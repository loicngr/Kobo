import { defineStore } from 'pinia'

export const useStatsStore = defineStore('stats', {
  state: () => ({
    /** Bumped each time something requests the stats tab to open. */
    requestOpen: 0,
  }),
  actions: {
    requestOpenStats() {
      this.requestOpen++
    },
  },
})
