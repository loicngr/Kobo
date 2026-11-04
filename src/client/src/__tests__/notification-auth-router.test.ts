import { createPinia, setActivePinia } from 'pinia'
import { Dialog } from 'quasar'
import { afterEach, expect, it, vi } from 'vitest'
import bootAuth from '../boot/network-auth'
import createKoboRouter from '../router'
import { authenticateBrowser } from '../utils/auth-token'
import { closeNetworkLogin, networkLoginOpen, openNetworkLogin } from '../utils/network-login-bus'
import { installNotificationNavigation, openNotificationTarget } from '../utils/notification-navigation'
import { _clearUnsavedScopesForTest, registerUnsavedScope } from '../utils/unsaved-guard'

vi.mock('quasar', async (original) => ({
  ...(await original<typeof import('quasar')>()),
  Notify: { create: vi.fn() },
  Dialog: { create: vi.fn() },
}))
vi.mock('../router/routes', () => ({
  default: [{ path: '/workspace/:id?', name: 'workspace', component: { template: '<div />' } }],
}))

const originalFetch = window.fetch
afterEach(() => {
  window.fetch = originalFetch
  sessionStorage.clear()
  closeNetworkLogin()
  _clearUnsavedScopesForTest()
  vi.restoreAllMocks()
})

it('conserve le lien froid refusé en 401 puis restaure workspace, session et sprint après connexion', async () => {
  setActivePinia(createPinia())
  sessionStorage.clear()
  window.history.replaceState({}, '', '/#/workspace/w1?session=s1')
  let authenticated = false
  window.fetch = vi.fn(async (input) => {
    if (String(input) === '/api/auth/session') {
      authenticated = true
      return new Response('{}')
    }
    if (!authenticated) return new Response('{}', { status: 401 })
    return Response.json(
      String(input).endsWith('/sessions') ? [{ id: 's1', workspaceId: 'w1' }] : { sprintId: 'sprint1' },
    )
  })
  await (bootAuth as () => Promise<void>)()
  const router = await createKoboRouter({} as never)
  installNotificationNavigation(router)
  await router.push('/workspace/w1?session=s1')
  expect(networkLoginOpen.value).toBe(true)
  expect(JSON.parse(sessionStorage.getItem('kobo:notification-target') ?? '{}')).toEqual({
    workspaceId: 'w1',
    sessionId: 's1',
  })
  expect((await authenticateBrowser('token')).ok).toBe(true)
  closeNetworkLogin()
  // The dialog reloads the page; create a fresh router and restore the stored target.
  const reloaded = await createKoboRouter({} as never)
  installNotificationNavigation(reloaded)
  await reloaded.push('/workspace')
  await vi.waitFor(() => expect(reloaded.currentRoute.value.params.id).toBe('w1'))
  expect(reloaded.currentRoute.value.query).toMatchObject({ session: 's1', sprint: 'sprint1' })
})

it('ne mémorise pas une cible refusée par la garde même si le dialogue de connexion est ouvert', async () => {
  setActivePinia(createPinia())
  sessionStorage.clear()
  window.fetch = vi.fn(async () => Response.json({ sprintId: 's' }))
  const router = await createKoboRouter({} as never)
  await router.push('/workspace/source')
  installNotificationNavigation(router)
  openNetworkLogin()
  registerUnsavedScope('notification-test', () => true)
  vi.mocked(Dialog.create).mockImplementation((() => ({
    onOk() {
      return this
    },
    onCancel(fn: () => void) {
      fn()
      return this
    },
  })) as never)
  openNotificationTarget({ workspaceId: 'destination' })
  await vi.waitFor(() => expect(Dialog.create).toHaveBeenCalled())
  await Promise.resolve()
  expect(router.currentRoute.value.params.id).toBe('source')
  expect(sessionStorage.getItem('kobo:notification-target')).toBeNull()
})

it('ignore un 401 arrivé après une authentification plus récente', async () => {
  setActivePinia(createPinia())
  sessionStorage.clear()
  let finish!: (response: Response) => void
  window.fetch = vi.fn((input) =>
    String(input) === '/api/auth/session'
      ? Promise.resolve(new Response('{}'))
      : new Promise<Response>((resolve) => {
          finish = resolve
        }),
  )
  await (bootAuth as () => Promise<void>)()
  const router = await createKoboRouter({} as never)
  const pending = router.push('/workspace/w1?session=s1')
  await vi.waitFor(() => expect(finish).toBeDefined())
  await authenticateBrowser('token')
  finish(new Response('{}', { status: 401 }))
  await pending
  expect(sessionStorage.getItem('kobo:notification-target')).toBeNull()
  expect(networkLoginOpen.value).toBe(false)
})

it('mémorise la notification lorsque le garde reçoit un 401 après une prévalidation réussie', async () => {
  setActivePinia(createPinia())
  sessionStorage.clear()
  let destinationReads = 0
  window.fetch = vi.fn(async (input) => {
    const url = String(input)
    if (url.includes('/destination')) {
      destinationReads++
      if (destinationReads === 4) return new Response('{}', { status: 401 })
      if (url.endsWith('/sessions')) return Response.json([{ id: 's1', workspaceId: 'destination' }])
    }
    return Response.json({ sprintId: 'sprint1' })
  })
  await (bootAuth as () => Promise<void>)()
  const router = await createKoboRouter({} as never)
  await router.push('/workspace/source')
  installNotificationNavigation(router)
  openNotificationTarget({ workspaceId: 'destination', sessionId: 's1' })
  await vi.waitFor(() => expect(sessionStorage.getItem('kobo:notification-target')).not.toBeNull())
  expect(destinationReads).toBe(4)
  expect(JSON.parse(sessionStorage.getItem('kobo:notification-target') ?? '{}')).toEqual({
    workspaceId: 'destination',
    sessionId: 's1',
  })
  expect(router.currentRoute.value.params.id).toBe('source')
  expect(networkLoginOpen.value).toBe(true)
})

it('mémorise la notification après un changement de sprint puis un 401 sur la redirection', async () => {
  setActivePinia(createPinia())
  sessionStorage.clear()
  let destinationReads = 0
  window.fetch = vi.fn(async (input) => {
    const url = String(input)
    if (url.includes('/destination')) {
      destinationReads++
      if (destinationReads === 7) return new Response('{}', { status: 401 })
      if (url.endsWith('/sessions')) return Response.json([{ id: 's1', workspaceId: 'destination' }])
    }
    return Response.json({ sprintId: destinationReads >= 4 ? 'sprint2' : 'sprint1' })
  })
  await (bootAuth as () => Promise<void>)()
  const router = await createKoboRouter({} as never)
  await router.push('/workspace/source')
  installNotificationNavigation(router)
  openNotificationTarget({ workspaceId: 'destination', sessionId: 's1' })
  await vi.waitFor(() => expect(sessionStorage.getItem('kobo:notification-target')).not.toBeNull())
  expect(destinationReads).toBe(7)
  expect(JSON.parse(sessionStorage.getItem('kobo:notification-target') ?? '{}')).toEqual({
    workspaceId: 'destination',
    sessionId: 's1',
  })
  expect(router.currentRoute.value.params.id).toBe('source')
  expect(networkLoginOpen.value).toBe(true)
})
