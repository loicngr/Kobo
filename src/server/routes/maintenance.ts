import { Hono } from 'hono'
import {
  UPDATE_TRIGGER_PHASES,
  UPDATE_TRIGGER_REASONS,
  type UpdateTriggerPhase,
  type UpdateTriggerReason,
} from '../../shared/update-trigger.js'
import {
  isIdleForForcedUpdate,
  isIdleForUpdate,
  isShuttingDown,
  resumeAfterUpdateMaintenance,
  stopAgentsForUpdate,
} from '../services/agent/orchestrator.js'
import { hasActiveSessionHandoff } from '../services/session-handoff-service.js'
import {
  acquireUpdateMaintenance,
  isUpdateMaintenanceActive,
  releaseUpdateMaintenance,
} from '../services/update-maintenance-service.js'
import {
  getUpdateTriggerState,
  isStopAgentsRequest,
  pollUpdateTrigger,
  reportUpdateTrigger,
  requestUpdate,
  stopAgentsAllowed,
  UpdateTriggerError,
} from '../services/update-trigger-service.js'
import { preserveForUpdateMaintenance } from '../services/wakeup-service.js'

/** Protected by the same network-token/Host/Origin middleware as other APIs. */
const app = new Hono()
const OWNER_PATTERN = /^[a-f0-9]{32}$/

app.get('/update', (c) => c.json({ protocol: 1, active: isUpdateMaintenanceActive() }))

app.on(['POST', 'DELETE'], '/update', async (c) => {
  const body = await c.req.json<{ owner?: unknown }>().catch(() => null)
  if (!body || typeof body.owner !== 'string' || !OWNER_PATTERN.test(body.owner)) {
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

app.get('/update-trigger', (c) => {
  try {
    return c.json(getUpdateTriggerState())
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.post('/update-trigger', async (c) => {
  try {
    const body = await c.req.json<{ skipBackup?: unknown; stopAgents?: unknown }>().catch(() => null)
    if (!body || typeof body.skipBackup !== 'boolean' || typeof body.stopAgents !== 'boolean') {
      return c.json({ error: 'Expected boolean skipBackup and stopAgents' }, 400)
    }
    const request = requestUpdate({ skipBackup: body.skipBackup, stopAgents: body.stopAgents })
    return c.json({ id: request.id }, 202)
  } catch (err) {
    if (err instanceof UpdateTriggerError) return c.json({ error: err.message, code: err.code }, 409)
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.get('/update-trigger/poll', (c) => {
  try {
    // `1` means the host opted in; anything else, absent included (an older updater), means not allowed.
    const allowed = { skipBackup: c.req.query('skipBackup') === '1', stopAgents: c.req.query('stopAgents') === '1' }
    return c.json({ protocol: 1, request: pollUpdateTrigger(Date.now(), allowed) })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.post('/update-trigger/stop-agents', async (c) => {
  try {
    const body = await c.req.json<{ id?: unknown; owner?: unknown }>().catch(() => null)
    if (!body || typeof body.id !== 'string' || typeof body.owner !== 'string' || !OWNER_PATTERN.test(body.owner))
      return c.json({ error: 'Expected an id and a 32-character update reservation identifier' }, 400)
    if (!isStopAgentsRequest(body.id))
      return c.json({ error: 'Unknown update request or agents not to be stopped' }, 409)
    if (!stopAgentsAllowed())
      return c.json(
        { error: 'The host updater does not allow stopping agents', code: 'not-allowed', stopped: 0, unconfirmed: 0 },
        409,
      )
    const owner = body.owner
    // This call only ever works on a reservation it creates: an existing one (even the same
    // owner's, e.g. an overlapping retry) is never reused, extended or released here.
    if (isUpdateMaintenanceActive())
      return c.json({ error: 'Update already reserved', code: 'conflict', stopped: 0, unconfirmed: 0 }, 409)
    // Close admission BEFORE stopping: while reserved, isShuttingDown() makes capacity checks,
    // review returns, auto-loop waiters, wakeups, cron and quota retries defer instead of restarting agents.
    // A running transfer is refused rather than interrupted (no handoff suspension on this path).
    const reservation = acquireUpdateMaintenance(owner, () => {
      if (isShuttingDown() || hasActiveSessionHandoff()) return false
      preserveForUpdateMaintenance()
      return true
    })
    if (reservation !== 'acquired') {
      const error = reservation === 'busy' ? 'Kōbō is busy' : 'Update already reserved'
      return c.json({ error, code: reservation, stopped: 0, unconfirmed: 0 }, 409)
    }
    let kept = false
    try {
      const { stopped, unconfirmed } = await stopAgentsForUpdate()
      if (unconfirmed === 0 && isIdleForForcedUpdate()) {
        // The updater now owns the reservation: it stops the container or releases it with DELETE /update.
        kept = true
        return c.json({ protocol: 1, stopped, unconfirmed, reserved: true })
      }
      // An unconfirmed stop is never treated as stopped.
      return c.json({ error: 'Kōbō is busy', code: 'busy', stopped, unconfirmed }, 409)
    } finally {
      // Refusal or failure: reopen admission and keep Kōbō running.
      if (!kept) {
        releaseUpdateMaintenance(owner)
        resumeAfterUpdateMaintenance()
      }
    }
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.post('/update-trigger/report', async (c) => {
  try {
    const body = await c.req.json<{ id?: unknown; phase?: unknown; reason?: unknown }>().catch(() => null)
    if (
      !body ||
      typeof body.id !== 'string' ||
      !(UPDATE_TRIGGER_PHASES as readonly unknown[]).includes(body.phase) ||
      (body.reason !== undefined && !(UPDATE_TRIGGER_REASONS as readonly unknown[]).includes(body.reason))
    ) {
      return c.json({ error: 'Expected an id, a known phase and an optional known reason' }, 400)
    }
    if (!reportUpdateTrigger(body.id, body.phase as UpdateTriggerPhase, body.reason as UpdateTriggerReason | undefined))
      return c.json({ error: 'Unknown update request' }, 409)
    return c.json({ protocol: 1 })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

export default app
