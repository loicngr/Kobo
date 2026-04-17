import type { RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('../layouts/MainLayout.vue'),
    children: [
      {
        path: '',
        redirect: { name: 'workspace' },
      },
      {
        path: 'workspace/:id?',
        name: 'workspace',
        component: () => import('../pages/WorkspacePage.vue'),
      },
      {
        path: 'create',
        name: 'create',
        component: () => import('../pages/CreatePage.vue'),
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('../pages/SettingsPage.vue'),
      },
      {
        path: 'search',
        name: 'search',
        component: () => import('../pages/SearchPage.vue'),
      },
    ],
  },
  // Always leave this as last
  {
    path: '/:catchAll(.*)*',
    redirect: '/',
  },
]

export default routes
