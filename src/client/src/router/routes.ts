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
        path: 'dashboard',
        name: 'dashboard',
        component: () => import('../pages/DashboardPage.vue'),
      },
      {
        path: 'workspace/:id?',
        name: 'workspace',
        component: () => import('../pages/WorkspacePage.vue'),
      },
      {
        path: 'split',
        name: 'split',
        component: () => import('../pages/SplitWorkspacePage.vue'),
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
      {
        path: 'health',
        name: 'health',
        component: () => import('../pages/HealthPage.vue'),
      },
      {
        path: 'changelog',
        name: 'changelog',
        component: () => import('../pages/ChangelogPage.vue'),
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
