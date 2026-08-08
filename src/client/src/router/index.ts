import { createRouter, createWebHashHistory } from 'vue-router'
import { defineRouter } from '#q-app'
import routes from './routes'

export default defineRouter(() => {
  const Router = createRouter({
    scrollBehavior: () => ({ left: 0, top: 0 }),
    routes,
    history: createWebHashHistory(),
  })

  return Router
})
