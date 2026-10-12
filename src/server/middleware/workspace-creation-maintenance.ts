import type { MiddlewareHandler } from 'hono'
import { beginWorkspaceCreation } from '../services/update-maintenance-service.js'

/** Admission remains held across every await and the handler's rollback paths. */
export const workspaceCreationMaintenance: MiddlewareHandler = async (c, next) => {
  const release = beginWorkspaceCreation()
  if (!release)
    return c.json(
      { code: 'update-maintenance', error: 'Workspace creation is unavailable during update maintenance' },
      503,
    )
  try {
    await next()
  } finally {
    release()
  }
}
