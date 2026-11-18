import { createPinia, setActivePinia } from 'pinia'
import { Notify } from 'quasar'
import { ALL_SPRINTS, NO_SPRINT, useSprintStore } from 'src/stores/sprints'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Router } from 'vue-router'
import {
  consumeInternalSprintTarget,
  invalidatePendingTargetNavigation,
  navigateToWorkspaceTarget,
  resolveWorkspaceRoute,
} from '../utils/sprint-navigation'

vi.mock('quasar', () => ({ Notify: { create: vi.fn() } }))

describe('navigation vers un workspace', () => {
  beforeEach(() => {
    sessionStorage.clear()
    setActivePinia(createPinia())
    vi.mocked(Notify.create).mockClear()
  })
  afterEach(() => vi.unstubAllGlobals())

  it("conserve l'onglet actif et la session demandée, même si le workspace est dans un autre sprint", async () => {
    useSprintStore().setActive('sprint-a')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ sprintId: 'sprint-b' })))
        .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 's1', workspaceId: 'w1' }])))
        .mockResolvedValueOnce(new Response(JSON.stringify({ sprintId: 'sprint-b' }))),
    )
    const push = vi.fn().mockResolvedValue(undefined)
    const result = await navigateToWorkspaceTarget({ push } as unknown as Router, {
      workspaceId: 'w1',
      sessionId: 's1',
    })
    expect(result).toBe(true)
    expect(push).toHaveBeenCalledWith({
      name: 'workspace',
      state: { koboSprintContext: true },
      params: { id: 'w1' },
      query: { sprint: 'sprint-a', session: 's1' },
    })
    expect(useSprintStore().active).toBe('sprint-a')
  })

  it('conserve aussi l’onglet actif pour un workspace sans sprint', async () => {
    useSprintStore().setActive('sprint-a')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ sprintId: null })))
    const push = vi.fn().mockResolvedValue(undefined)
    await navigateToWorkspaceTarget({ push } as unknown as Router, { workspaceId: 'w1' })
    expect(push).toHaveBeenCalledWith({
      name: 'workspace',
      state: { koboSprintContext: true },
      params: { id: 'w1' },
      query: { sprint: 'sprint-a' },
    })
    expect(useSprintStore().active).toBe('sprint-a')
  })

  it('porte la valeur Tous quand cet onglet est actif', async () => {
    useSprintStore().setActive(ALL_SPRINTS)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ sprintId: 'sprint-b' })))
    const push = vi.fn().mockResolvedValue(undefined)
    await navigateToWorkspaceTarget({ push } as unknown as Router, { workspaceId: 'w1' })
    expect(push.mock.calls[0]?.[0].query).toEqual({ sprint: ALL_SPRINTS })
  })

  it('marque la navigation comme interne pour le garde pendant le push puis efface le marqueur', async () => {
    useSprintStore().setActive('sprint-a')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ sprintId: 'sprint-b' })))
    let markedDuringPush = false
    const push = vi.fn().mockImplementation(async () => {
      markedDuringPush = consumeInternalSprintTarget('w1', 'sprint-a')
    })
    await navigateToWorkspaceTarget({ push } as unknown as Router, { workspaceId: 'w1' })
    expect(markedDuringPush).toBe(true)
    // Le marqueur est consommé par le garde, ou effacé dans finally : jamais laissé en suspens.
    expect(consumeInternalSprintTarget('w1', 'sprint-a')).toBe(false)
  })

  it('efface le marqueur même si le push échoue', async () => {
    useSprintStore().setActive('sprint-a')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ sprintId: 'sprint-b' })))
    const push = vi.fn().mockRejectedValue(new Error('boom'))
    expect(await navigateToWorkspaceTarget({ push } as unknown as Router, { workspaceId: 'w1' })).toBe(false)
    expect(consumeInternalSprintTarget('w1', 'sprint-a')).toBe(false)
  })

  it("lit l'onglet actif au moment du push, pas au début de la résolution", async () => {
    useSprintStore().setActive('sprint-a')
    let resolve!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done
          }),
      ),
    )
    const push = vi.fn().mockResolvedValue(undefined)
    const pending = navigateToWorkspaceTarget({ push } as unknown as Router, { workspaceId: 'w1' })
    useSprintStore().setActive('sprint-c')
    resolve(Response.json({ sprintId: 'sprint-b' }))
    await pending
    expect(push.mock.calls[0]?.[0].query.sprint).toBe('sprint-c')
  })

  it("retire la session absente, garde l'onglet actif et avertit", async () => {
    useSprintStore().setActive('sprint-a')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ sprintId: 'sprint-b' }))
        .mockResolvedValueOnce(Response.json([]))
        .mockResolvedValueOnce(Response.json({ sprintId: 'sprint-b' })),
    )
    const push = vi.fn().mockResolvedValue(undefined)
    await navigateToWorkspaceTarget({ push } as unknown as Router, { workspaceId: 'w1', sessionId: 'gone' })
    expect(push.mock.calls[0]?.[0].query).toEqual({ sprint: 'sprint-a' })
    expect(Notify.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }))
  })

  it("garde l'onglet actif et avertit pour un workspace absent", async () => {
    useSprintStore().setActive('sprint-a')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    const push = vi.fn().mockResolvedValue(undefined)
    await navigateToWorkspaceTarget({ push } as unknown as Router, { workspaceId: 'missing' })
    expect(push).toHaveBeenCalledWith({ name: 'workspace' })
    expect(Notify.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }))
    expect(useSprintStore().active).toBe('sprint-a')
  })

  it('revient à l’accueil si le workspace est absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    const push = vi.fn().mockResolvedValue(undefined)
    expect(await navigateToWorkspaceTarget({ push } as unknown as Router, { workspaceId: 'missing' })).toBe(false)
    expect(push).toHaveBeenCalledWith({ name: 'workspace' })
  })

  it('renvoie false lorsque le routeur refuse la navigation', async () => {
    useSprintStore().setActive(NO_SPRINT)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ sprintId: null }))))
    const push = vi.fn().mockResolvedValue({ type: 4 })
    expect(await navigateToWorkspaceTarget({ push } as unknown as Router, { workspaceId: 'w1' })).toBe(false)
    expect(push.mock.calls[0]?.[0].query.sprint).toBe('__none__')
  })
  it('ignore une résolution devenue obsolète après une autre navigation', async () => {
    let resolve!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done
          }),
      ),
    )
    const push = vi.fn()
    const pending = navigateToWorkspaceTarget({ push } as unknown as Router, { workspaceId: 'w1' })
    invalidatePendingTargetNavigation()
    resolve(new Response(JSON.stringify({ sprintId: 'sprint' })))
    expect(await pending).toBe(false)
    expect(push).not.toHaveBeenCalled()
  })
  it('écarte une session appartenant à un autre workspace', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ sprintId: 's' })))
        .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'other', workspaceId: 'another' }])))
        .mockResolvedValueOnce(new Response(JSON.stringify({ sprintId: 's' }))),
    )
    const push = vi.fn().mockResolvedValue(undefined)
    expect(
      await navigateToWorkspaceTarget({ push } as unknown as Router, { workspaceId: 'w1', sessionId: 'other' }),
    ).toBe(true)
    expect(push.mock.calls[0]?.[0].query).toEqual({ sprint: ALL_SPRINTS })
  })
  it('prévalide le lien brut et utilise le sprint relu après les sessions', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ sprintId: 'old' }))
        .mockResolvedValueOnce(Response.json([{ id: 's1', workspaceId: 'w1' }]))
        .mockResolvedValueOnce(Response.json({ sprintId: 'new' })),
    )
    const decision = await resolveWorkspaceRoute({ workspaceId: 'w1', sessionId: 's1' }, { session: 's1' }, true)
    expect(decision).toEqual({
      missing: false,
      query: { session: 's1', sprint: 'new' },
      needsRedirect: true,
      sessionMissing: false,
    })
  })

  it('retire du lien brut une session étrangère avant la navigation', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ sprintId: 'a' }))
        .mockResolvedValueOnce(Response.json([{ id: 's1', workspaceId: 'another' }]))
        .mockResolvedValueOnce(Response.json({ sprintId: 'b' })),
    )
    const decision = await resolveWorkspaceRoute(
      { workspaceId: 'w1', sessionId: 's1' },
      { session: 's1', eventId: 'e1' },
      true,
    )
    expect(decision).toEqual({
      missing: false,
      query: { sprint: 'b', eventId: 'e1' },
      needsRedirect: true,
      sessionMissing: true,
    })
  })

  it('conserve Tous pour une session valide dans une navigation interne', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ sprintId: 'a' }))
        .mockResolvedValueOnce(Response.json([{ id: 's1', workspaceId: 'w1' }]))
        .mockResolvedValueOnce(Response.json({ sprintId: 'b' })),
    )
    const decision = await resolveWorkspaceRoute(
      { workspaceId: 'w1', sessionId: 's1' },
      { session: 's1', sprint: '__all__' },
      false,
    )
    expect(decision).toEqual({
      missing: false,
      query: { session: 's1', sprint: '__all__' },
      needsRedirect: false,
      sessionMissing: false,
    })
  })
})
