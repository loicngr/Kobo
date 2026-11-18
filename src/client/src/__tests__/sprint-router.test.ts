import { createPinia, setActivePinia } from 'pinia'
import { Dialog, Notify } from 'quasar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import createKoboRouter from '../router'
import { useSprintStore } from '../stores/sprints'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'
import { markInternalSprintTarget, navigateToWorkspaceTarget } from '../utils/sprint-navigation'
import { _clearUnsavedScopesForTest, registerUnsavedScope } from '../utils/unsaved-guard'

vi.mock('quasar', async (original) => ({
  ...(await original<typeof import('quasar')>()),
  Notify: { create: vi.fn() },
  Dialog: { create: vi.fn() },
}))

vi.mock('../router/routes', () => ({
  default: [{ path: '/workspace/:id?', name: 'workspace', component: { template: '<div />' } }],
}))

it.each(['workspaces', 'archivedWorkspaces'] as const)(
  'opens a loaded internal target without waiting for the network (%s)',
  async (list) => {
    setActivePinia(createPinia())
    useWorkspaceStore()[list] = [{ id: 'loaded' } as Workspace]
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )
    const router = await createKoboRouter({} as never)
    markInternalSprintTarget('loaded', '__all__')
    await router.push('/workspace/loaded?sprint=__all__')
    expect(router.currentRoute.value.params.id).toBe('loaded')
    expect(fetch).not.toHaveBeenCalled()
  },
)

it.each(['external', 'session', 'unknown'])('still validates %s targets over the network', async (kind) => {
  setActivePinia(createPinia())
  if (kind !== 'unknown') useWorkspaceStore().workspaces = [{ id: 'loaded' } as Workspace]
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
  )
  const router = await createKoboRouter({} as never)
  if (kind !== 'external') markInternalSprintTarget('loaded', '__all__')
  await router.push(`/workspace/loaded?sprint=__all__${kind === 'session' ? '&session=s1' : ''}`)
  expect(fetch).toHaveBeenCalled()
  expect(router.currentRoute.value.params.id).toBeUndefined()
})

it('attend la validation de session et relit le sprint avant de valider un lien brut', async () => {
  setActivePinia(createPinia())
  let finishSessions!: (response: Response) => void
  let sprint = 'old'
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.endsWith('/sessions'))
        return new Promise<Response>((resolve) => {
          finishSessions = resolve
        })
      return Promise.resolve(Response.json({ sprintId: sprint }))
    }),
  )
  const router = await createKoboRouter({} as never)
  const pending = router.push('/workspace/w1?session=s1')
  await vi.waitFor(() => expect(finishSessions).toBeDefined())
  expect(router.currentRoute.value.params.id).toBeUndefined()
  sprint = 'new'
  finishSessions(Response.json([{ id: 's1', workspaceId: 'w1' }]))
  // A redirect may validate the session once more; later reads need no delay.
  vi.mocked(fetch).mockImplementation((url) =>
    Promise.resolve(
      Response.json(String(url).endsWith('/sessions') ? [{ id: 's1', workspaceId: 'w1' }] : { sprintId: sprint }),
    ),
  )
  await pending
  expect(router.currentRoute.value.params.id).toBe('w1')
  expect(router.currentRoute.value.query).toMatchObject({ sprint: 'new', session: 's1' })
})

it('retire une session étrangère avant que la route soit sélectionnée', async () => {
  setActivePinia(createPinia())
  vi.spyOn(Notify, 'create').mockReturnValue(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        Response.json(url.endsWith('/sessions') ? [{ id: 's1', workspaceId: 'other' }] : { sprintId: 's' }),
      ),
    ),
  )
  const router = await createKoboRouter({} as never)
  await router.push('/workspace/w1?session=s1')
  expect(router.currentRoute.value.params.id).toBe('w1')
  expect(router.currentRoute.value.query).toEqual({ sprint: 's' })
  expect(Notify.create).toHaveBeenCalled()
})

it('résout un lien externe périmé depuis une route ouverte et signale une cible supprimée', async () => {
  setActivePinia(createPinia())
  vi.spyOn(Notify, 'create').mockReturnValue(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url.includes('/deleted') ? new Response('', { status: 404 }) : Response.json({ sprintId: 'new' }),
      ),
    ),
  )
  const router = await createKoboRouter({} as never)
  markInternalSprintTarget('source', '__all__')
  await router.push({
    name: 'workspace',
    params: { id: 'source' },
    query: { sprint: '__all__' },
    state: { koboSprintContext: true },
  })
  expect(router.currentRoute.value.query.sprint).toBe('__all__')
  await router.push('/workspace/target?sprint=old')
  expect(router.currentRoute.value.query.sprint).toBe('new')
  await router.push('/workspace/deleted?sprint=old')
  expect(router.currentRoute.value.params.id).toBeUndefined()
  expect(Notify.create).toHaveBeenCalledTimes(1)
})

it('conserve Tous pour retour et avance vers des entrées internes', async () => {
  setActivePinia(createPinia())
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json({ sprintId: 'real' }))),
  )
  const router = await createKoboRouter({} as never)
  for (const id of ['left', 'right']) {
    markInternalSprintTarget(id, '__all__')
    await router.push({
      name: 'workspace',
      params: { id },
      query: { sprint: '__all__' },
      state: { koboSprintContext: true },
    })
  }
  router.back()
  await vi.waitFor(() => expect(router.currentRoute.value.params.id).toBe('left'))
  expect(router.currentRoute.value.query.sprint).toBe('__all__')
  router.forward()
  await vi.waitFor(() => expect(router.currentRoute.value.params.id).toBe('right'))
  expect(router.currentRoute.value.query.sprint).toBe('__all__')
})

it('ne signale rien lorsque la garde refuse une cible absente', async () => {
  setActivePinia(createPinia())
  vi.spyOn(Notify, 'create').mockReturnValue(() => {})
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ sprintId: 's' })))
  vi.stubGlobal('fetch', fetchMock)
  const router = await createKoboRouter({} as never)
  await router.push('/workspace/source')
  expect(router.currentRoute.value.params.id).toBe('source')
  fetchMock.mockClear()
  registerUnsavedScope('review-test', () => true)
  vi.spyOn(Dialog, 'create').mockImplementation((() => ({
    onOk() {
      return this
    },
    onCancel(fn: () => void) {
      fn()
      return this
    },
  })) as never)
  await router.push('/workspace/deleted?sprint=old')
  expect(router.currentRoute.value.params.id).toBe('source')
  expect(fetchMock).not.toHaveBeenCalled()
  expect(Notify.create).not.toHaveBeenCalled()
})

it('ignore un avertissement issu d’une résolution dépassée', async () => {
  setActivePinia(createPinia())
  vi.spyOn(Notify, 'create').mockReturnValue(() => {})
  let finish!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url.includes('/slow')
        ? new Promise<Response>((resolve) => {
            finish = resolve
          })
        : Promise.resolve(Response.json({ sprintId: 's' })),
    ),
  )
  const router = await createKoboRouter({} as never)
  await router.push('/workspace/source')
  const slow = router.push('/workspace/slow')
  await vi.waitFor(() => expect(finish).toBeDefined())
  await router.push('/workspace/fast')
  finish(new Response('', { status: 404 }))
  await slow
  expect(router.currentRoute.value.params.id).toBe('fast')
  expect(Notify.create).not.toHaveBeenCalled()
})

describe('raccourcis qui gardent l’onglet actif', () => {
  // A route is already open and the history state is clean, so the guard cannot take the first-load shortcut.
  async function startedRouter() {
    window.history.replaceState({}, '', '#/')
    const router = await createKoboRouter({} as never)
    await router.push('/workspace?sprint=sprint-a')
    return router
  }

  function stubWorkspaceInSprintB() {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(Response.json(String(url).endsWith('/sessions') ? [] : { sprintId: 'sprint-b' })),
      ),
    )
  }

  it.each([
    ['présent dans le store', true],
    ['absent du store', false],
  ])('ne redirige pas vers le sprint du workspace (%s)', async (_label, inStore) => {
    setActivePinia(createPinia())
    useSprintStore().setActive('sprint-a')
    if (inStore) useWorkspaceStore().workspaces = [{ id: 'w1', sprintId: 'sprint-b' } as Workspace]
    stubWorkspaceInSprintB()
    const router = await startedRouter()
    expect(await navigateToWorkspaceTarget(router, { workspaceId: 'w1' })).toBe(true)
    expect(router.currentRoute.value.params.id).toBe('w1')
    expect(router.currentRoute.value.query.sprint).toBe('sprint-a')
    expect(useSprintStore().active).toBe('sprint-a')
  })

  it('garde un workspace sans sprint dans l’onglet actif et la valeur Tous', async () => {
    setActivePinia(createPinia())
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ sprintId: null }))),
    )
    const router = await startedRouter()
    for (const active of ['sprint-a', '__all__']) {
      useSprintStore().setActive(active)
      await navigateToWorkspaceTarget(router, { workspaceId: `w-${active}` })
      expect(router.currentRoute.value.query.sprint).toBe(active)
    }
  })

  it('conserve l’onglet de chaque entrée au retour et à l’avance', async () => {
    setActivePinia(createPinia())
    stubWorkspaceInSprintB()
    const router = await startedRouter()
    useSprintStore().setActive('sprint-a')
    await navigateToWorkspaceTarget(router, { workspaceId: 'left' })
    useSprintStore().setActive('sprint-c')
    await navigateToWorkspaceTarget(router, { workspaceId: 'right' })
    router.back()
    await vi.waitFor(() => expect(router.currentRoute.value.params.id).toBe('left'))
    expect(router.currentRoute.value.query.sprint).toBe('sprint-a')
    router.forward()
    await vi.waitFor(() => expect(router.currentRoute.value.params.id).toBe('right'))
    expect(router.currentRoute.value.query.sprint).toBe('sprint-c')
  })

  it('garde l’onglet d’une première charge dont l’état d’historique est interne (rechargement)', async () => {
    setActivePinia(createPinia())
    stubWorkspaceInSprintB()
    window.history.replaceState({ koboSprintContext: true }, '', '#/workspace/w1?sprint=sprint-a')
    const router = await createKoboRouter({} as never)
    await router.push('/workspace/w1?sprint=sprint-a')
    expect(router.currentRoute.value.query.sprint).toBe('sprint-a')
    window.history.replaceState({}, '', '#/')
  })

  it('résout encore le sprint du workspace pour une navigation non interne', async () => {
    setActivePinia(createPinia())
    useSprintStore().setActive('sprint-a')
    stubWorkspaceInSprintB()
    const router = await startedRouter()
    await router.push('/workspace/w1')
    expect(router.currentRoute.value.query.sprint).toBe('sprint-b')
    await router.push('/workspace/w2?sprint=sprint-a')
    expect(router.currentRoute.value.query.sprint).toBe('sprint-b')
  })
})

afterEach(() => {
  _clearUnsavedScopesForTest()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
