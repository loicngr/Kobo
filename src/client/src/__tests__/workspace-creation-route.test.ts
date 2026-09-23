import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import routes from '../router/routes'
import { workspaceCreationRoute } from '../utils/workspace-creation-route'

const router = createRouter({ history: createMemoryHistory(), routes })

describe('navigation after workspace creation', () => {
  it('opens both successful comparison results in the existing split view, in creation order', () => {
    const destination = workspaceCreationRoute([{ id: 'claude-workspace' }, { id: 'codex-workspace' }])
    expect(destination).not.toBeNull()
    const resolved = router.resolve(destination!)
    expect(resolved.path).toBe('/split')
    expect(resolved.query).toEqual({ left: 'claude-workspace', right: 'codex-workspace' })
    expect(router.resolve(resolved.fullPath).query).toEqual(resolved.query)
  })

  it('opens the available workspace for a single creation or a partially failed comparison', () => {
    const destination = workspaceCreationRoute([{ id: 'only-created' }])
    expect(destination).not.toBeNull()
    const resolved = router.resolve(destination!)
    expect(resolved.path).toBe('/workspace/only-created')
    expect(resolved.query).toEqual({})
  })

  it('leaves the creation form open when no workspace was created', () => {
    expect(workspaceCreationRoute([])).toBeNull()
  })
})
