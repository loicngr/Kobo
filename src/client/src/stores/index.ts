import { createPinia } from 'pinia'
import { defineStore } from '#q-app'

export default defineStore(() => {
  const pinia = createPinia()
  return pinia
})
