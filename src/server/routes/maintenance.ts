import { Hono } from 'hono'
import { isIdleForUpdate, resumeAfterUpdateMaintenance } from '../services/agent/orchestrator.js'
import {
  acquireUpdateMaintenance,
  isUpdateMaintenanceActive,
  releaseUpdateMaintenance,
} from '../services/update-maintenance-service.js'
import { preserveForUpdateMaintenance } from '../services/wakeup-service.js'

/** Protected by the same network-token/Host/Origin middleware as other APIs. */
const app = new Hono()

app.get('/update', (c) => c.json({ protocol: 1, active: isUpdateMaintenanceActive() }))

app.on(['POST', 'DELETE'], '/update', async (c) => {
  const body = await c.req.json<{ owner?: unknown }>().catch(() => null)
  if (!body || typeof body.owner !== 'string' || !/^[a-f0-9]{32}$/.test(body.owner)) {
    return c.json({ error: 'Expected a 32-character update reservation identifier' }, 400)
  }
  if (c.req.method === 'DELETE') {
    if (!releaseUpdateMaintenance(body.owner))
      return c.json({ error: 'Update reservation belongs to another owner' }, 409)
    resumeAfterUpdateMaintenance()
    return c.json({ protocol: 1, active: false })
  }
  // Both operations are synchronous: no agent can start between this check and reservation.
  const result = acquireUpdateMaintenance(body.owner, () => {
    if (!isIdleForUpdate()) return false
    // Commit deferral before acknowledging admission. Future wakeups may become
    // overdue while the stopped volume is backed up and migrated.
    preserveForUpdateMaintenance()
    return true
  })
  if (result !== 'acquired')
    return c.json({ error: result === 'busy' ? 'Kōbō is busy' : 'Update already reserved' }, 409)
  return c.json({ protocol: 1, active: true })
})

export default app
