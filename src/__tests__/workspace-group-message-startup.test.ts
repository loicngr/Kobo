import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import type { AgentEngine, EngineProcess } from '../server/services/agent/engines/types.js'
import { _getControllers } from '../server/services/agent/orchestrator.js'
import { SessionController } from '../server/services/agent/session-controller.js'
import { enable } from '../server/services/auto-loop-service.js'
import { _setSettingsPath, getEffectiveSettings } from '../server/services/settings-service.js'
import {
  getGroupMessageBatch,
  reconcileGroupMessageBatches,
  startGroupMessageBatch,
  stopGroupMessageBatches,
} from '../server/services/workspace-group-message-service.js'
import { resetDb } from './helpers/reset-db.js'

beforeEach(async () => {
  const { tmpDir } = await resetDb()
  _setSettingsPath(`${tmpDir}/settings.json`)
  const db = getDb()
  reconcileGroupMessageBatches(db)
  db.exec(`
    INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,status,
      auto_loop_ready,agent_permission_mode,created_at,updated_at)
    VALUES ('w1','Workspace','/tmp','main','work','executing',1,'bypass','now','now');
    INSERT INTO tasks(id,workspace_id,title,created_at,updated_at)
    VALUES ('t1','w1','Work','now','now');
  `)
})

afterEach(async () => {
  await stopGroupMessageBatches()
  _getControllers().delete('w1')
  closeDb()
})

it.each([false, true])('checks the delivery mode after engine startup (enable auto-loop: %s)', async (enableLoop) => {
  let releaseStart!: () => void
  const startingGate = new Promise<void>((resolve) => {
    releaseStart = resolve
  })
  const engineProcess: EngineProcess = {
    pid: undefined,
    engineSessionId: undefined,
    sendMessage: vi.fn(),
    interrupt() {},
    async stop() {},
    resolvePendingUserInput: () => false,
  }
  const engine: AgentEngine = {
    id: 'claude-code',
    displayName: 'Delayed test engine',
    capabilities: {
      models: [],
      permissionModes: ['bypass'],
      supportsResume: true,
      supportsMcp: true,
      supportsSkills: true,
      supportsSubagents: false,
      supportsQuotaStatus: false,
    },
    async start() {
      await startingGate
      return engineProcess
    },
  }
  const controller = new SessionController('w1', 'session-1', engine, () => {})
  const starting = controller.start({
    workspaceId: 'w1',
    workingDir: '/tmp',
    prompt: 'Initial work',
    agentPermissionMode: 'bypass',
    backendUrl: 'http://127.0.0.1:3000',
    koboHome: process.env.KOBO_HOME!,
    settings: getEffectiveSettings('/tmp'),
  })
  _getControllers().set('w1', controller)
  const input = { requestId: 'startup-race', workspaceIds: ['w1'], content: 'Group instruction' }
  try {
    const batch = startGroupMessageBatch(input)
    await vi.waitFor(() => expect(getGroupMessageBatch(batch.id)?.recipients[0].state).toBe('sending'))
    expect(engineProcess.sendMessage).not.toHaveBeenCalled()
    if (enableLoop) enable('w1')
    releaseStart()
    await starting
    await vi.waitFor(() => expect(getGroupMessageBatch(batch.id)?.complete).toBe(true))
    const receipt = getGroupMessageBatch(batch.id)!
    expect(receipt.recipients[0].state).toBe(enableLoop ? 'rejected' : 'sent')
    expect(engineProcess.sendMessage).toHaveBeenCalledTimes(enableLoop ? 0 : 1)
    if (enableLoop) expect(receipt.recipients[0].error).toContain('Auto-loop mode changed')
    else expect(engineProcess.sendMessage).toHaveBeenCalledWith(input.content)
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM auto_loop_messages').get()).toEqual({ count: 0 })
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM ws_events WHERE type='user:message'").get()).toEqual({
      count: enableLoop ? 0 : 1,
    })
    expect(startGroupMessageBatch(input)).toEqual(receipt)
    expect(engineProcess.sendMessage).toHaveBeenCalledTimes(enableLoop ? 0 : 1)
  } finally {
    releaseStart()
    await starting
    await controller.stop()
  }
})
