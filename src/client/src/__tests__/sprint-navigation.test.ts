import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Router } from 'vue-router'
import {
  invalidatePendingTargetNavigation,
  navigateToWorkspaceTarget,
  resolveWorkspaceRoute,
} from '../utils/sprint-navigation'

vi.mock('quasar', () => ({ Notify: { create: vi.fn() } }))

describe('navigation vers un workspace', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('résout le sprint courant et conserve la session demandée', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ sprintId: 'current' })))
        .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 's1', workspaceId: 'w1' }])))
        .mockResolvedValueOnce(new Response(JSON.stringify({ sprintId: 'current' }))),
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
      query: { sprint: 'current', session: 's1' },
    })
  })

  it('revient à l’accueil si le workspace est absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    const push = vi.fn().mockResolvedValue(undefined)
    expect(await navigateToWorkspaceTarget({ push } as unknown as Router, { workspaceId: 'missing' })).toBe(false)
    expect(push).toHaveBeenCalledWith({ name: 'workspace' })
  })

  it('renvoie false lorsque le routeur refuse la navigation', async () => {
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
    expect(push.mock.calls[0]?.[0].query).toEqual({ sprint: 's' })
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
