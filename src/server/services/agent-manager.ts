import { type ChildProcess, spawn } from 'node:child_process'
import fs, { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { nanoid } from 'nanoid'
import { getDb } from '../db/index.js'
import {
  ensureKoboHome,
  getCompiledMcpServerPath,
  getDbPath,
  getMcpServerSourcePath,
  getSkillsPath,
} from '../utils/paths.js'
import { registerProcess, unregisterProcess } from '../utils/process-tracker.js'
import { emit } from './websocket-service.js'
import { getWorkspace as getWs, listTasks, updateWorkspaceStatus } from './workspace-service.js'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AgentInstance {
  workspaceId: string
  process: ChildProcess
  rl: readline.Interface
  status: 'running' | 'stopping'
  agentSessionId: string
  claudeSessionId?: string
}

// ── State ──────────────────────────────────────────────────────────────────────

/** workspaceId -> agent instance */
const agents = new Map<string, AgentInstance>()

/** workspaceId -> last Claude session ID (for --resume) */
const sessionIds = new Map<string, string>()

/** Cached list of available slash commands — persisted to <KOBO_HOME>/skills.json */
let availableSkills: string[] = (() => {
  try {
    const data = JSON.parse(readFileSync(getSkillsPath(), 'utf-8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
})()

/** workspaceId -> retry count (for quota backoff) */
const retryCounts = new Map<string, number>()

/** workspaceId -> backoff timer */
const backoffTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** workspaceId -> pending SIGKILL timer */
const killTimers = new Map<string, ReturnType<typeof setTimeout>>()

// ── Start agent ────────────────────────────────────────────────────────────────

export function startAgent(
  workspaceId: string,
  workingDir: string,
  prompt: string,
  model?: string,
  resume = false,
): AgentInstance {
  // Check if agent already running for this workspace
  if (agents.has(workspaceId)) {
    throw new Error(`Agent already running for workspace '${workspaceId}'`)
  }

  const db = getDb()
  let agentSessionId: string
  let resumedClaudeSessionId: string | undefined

  // Build CLI args
  const args = ['--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose']
  if (model && model !== 'auto') {
    args.push('--model', model)
  }
  if (resume) {
    const lastSession = db
      .prepare(
        'SELECT id, claude_session_id FROM agent_sessions WHERE workspace_id = ? AND claude_session_id IS NOT NULL ORDER BY started_at DESC LIMIT 1',
      )
      .get(workspaceId) as { id: string; claude_session_id: string } | undefined

    const claudeSessionId = sessionIds.get(workspaceId) ?? lastSession?.claude_session_id

    if (claudeSessionId) {
      resumedClaudeSessionId = claudeSessionId
      args.push('--resume', claudeSessionId, '-p', prompt)
      // Always reuse existing session — find by claude_session_id if lastSession didn't match
      const existingId =
        lastSession?.id ??
        (
          db
            .prepare('SELECT id FROM agent_sessions WHERE claude_session_id = ? ORDER BY started_at DESC LIMIT 1')
            .get(claudeSessionId) as { id: string } | undefined
        )?.id
      agentSessionId = existingId ?? nanoid()
      if (existingId) {
        db.prepare('UPDATE agent_sessions SET status = ?, ended_at = NULL WHERE id = ?').run('running', agentSessionId)
      } else {
        db.prepare(
          'INSERT INTO agent_sessions (id, workspace_id, pid, status, claude_session_id, started_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(agentSessionId, workspaceId, null, 'running', claudeSessionId, new Date().toISOString())
      }
    } else {
      args.push('-p', prompt)
      agentSessionId = nanoid()
      db.prepare('INSERT INTO agent_sessions (id, workspace_id, pid, status, started_at) VALUES (?, ?, ?, ?, ?)').run(
        agentSessionId,
        workspaceId,
        null,
        'running',
        new Date().toISOString(),
      )
    }
  } else {
    args.push('-p', prompt)
    agentSessionId = nanoid()
    db.prepare('INSERT INTO agent_sessions (id, workspace_id, pid, status, started_at) VALUES (?, ?, ?, ?, ?)').run(
      agentSessionId,
      workspaceId,
      null,
      'running',
      new Date().toISOString(),
    )
  }

  // Write .mcp.json to workingDir so claude picks up the kobo-tasks MCP server
  const mcpConfigPath = path.join(workingDir, '.mcp.json')
  try {
    const mcpServerCompiled = getCompiledMcpServerPath()
    const mcpServerSource = getMcpServerSourcePath()

    const mcpConfig = {
      mcpServers: {
        'kobo-tasks': {
          command: mcpServerCompiled ? 'node' : 'npx',
          args: mcpServerCompiled ? [mcpServerCompiled] : ['tsx', mcpServerSource],
          env: {
            KOBO_WORKSPACE_ID: workspaceId,
            KOBO_DB_PATH: getDbPath(),
            KOBO_BACKEND_URL: `http://localhost:${process.env.PORT ?? '3000'}`,
          },
        },
      },
    }
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2))
    args.push('--mcp-config', mcpConfigPath)
  } catch (err) {
    console.error(
      '[agent-manager] Failed to write .mcp.json, continuing without kobo-tasks MCP:',
      err instanceof Error ? err.message : err,
    )
  }

  // Spawn Claude Code process
  const proc = spawn('claude', args, {
    cwd: workingDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Create readline interface for NDJSON parsing from stdout
  const rl = readline.createInterface({
    input: proc.stdout!,
    crlfDelay: Infinity,
  })

  // Update PID in DB session
  db.prepare('UPDATE agent_sessions SET pid = ? WHERE id = ?').run(proc.pid ?? null, agentSessionId)

  // Register with process tracker
  registerProcess(workspaceId, proc)

  const agent: AgentInstance = {
    workspaceId,
    process: proc,
    rl,
    status: 'running',
    agentSessionId,
    claudeSessionId: resumedClaudeSessionId,
  }

  // ── stdout line-by-line (NDJSON) ──
  rl.on('line', (line: string) => {
    if (!line.trim()) return

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Parsing failed — emit raw line
      emit(workspaceId, 'agent:output', { type: 'raw', content: line }, agent.claudeSessionId)
      // Check for BRAINSTORM_COMPLETE marker in raw lines
      if (line.includes('[BRAINSTORM_COMPLETE]')) {
        try {
          updateWorkspaceStatus(workspaceId, 'executing')
          emit(workspaceId, 'agent:status', { status: 'executing' }, agent.claudeSessionId)
        } catch (err) {
          console.error('[agent] Failed to transition to executing:', err)
        }
      }
      return
    }

    const p = parsed as Record<string, unknown>
    const msgType = p.type as string | undefined

    // Capture available skills from init message
    if (
      msgType === 'system' &&
      p.subtype === 'init' &&
      Array.isArray(p.slash_commands) &&
      p.slash_commands.length > 0
    ) {
      availableSkills = p.slash_commands as string[]
      try {
        ensureKoboHome()
        writeFileSync(getSkillsPath(), JSON.stringify(availableSkills))
      } catch (err) {
        console.error('[agent] Failed to persist skills:', err)
      }
    }

    // Capture session_id for --resume support
    if (typeof p.session_id === 'string' && p.session_id) {
      sessionIds.set(workspaceId, p.session_id)
      if (!agent.claudeSessionId) {
        agent.claudeSessionId = p.session_id as string
        const db = getDb()
        db.prepare('UPDATE agent_sessions SET claude_session_id = ? WHERE id = ?').run(
          agent.claudeSessionId,
          agent.agentSessionId,
        )
      }
    }

    // After compact, reinject criteria so the agent doesn't lose track
    if (msgType === 'system' && (p.subtype === 'compact' || p.subtype === 'compact_boundary')) {
      try {
        const ws = getWs(workspaceId)
        const tasks = listTasks(workspaceId)
        const criteria = tasks.filter((t) => t.isAcceptanceCriterion)
        const todos = tasks.filter((t) => !t.isAcceptanceCriterion)

        if (criteria.length > 0 || todos.length > 0) {
          let reminder = `\n--- Context reminder after compaction ---\n`
          reminder += `Task: ${ws?.name ?? workspaceId}\n`
          if (todos.length > 0) {
            reminder += `\nTasks:\n${todos.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}`).join('\n')}\n`
          }
          if (criteria.length > 0) {
            reminder += `\nAcceptance criteria:\n${criteria.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}`).join('\n')}\n`
            reminder += `\nWhen you complete a criterion, tell me which one so I can mark it as done.\n`
          }
          reminder += `--- End of reminder ---\n`

          if (agent.process.stdin?.writable) {
            agent.process.stdin.write(`${reminder}\n`)
          }
        }
      } catch (err) {
        console.error('[agent] Failed to inject post-compact reminder:', err)
      }
    }

    // Filter out user messages (tool results) — they create noise in the feed
    if (msgType === 'user') {
      return
    }

    emit(workspaceId, 'agent:output', parsed, agent.claudeSessionId)

    // Detect brainstorming completion from parsed output
    if (msgType === 'assistant' && Array.isArray(p.content)) {
      const hasMarker = (p.content as unknown[]).some((block: unknown) => {
        const b = block as Record<string, unknown>
        return b.type === 'text' && typeof b.text === 'string' && b.text.includes('[BRAINSTORM_COMPLETE]')
      })
      if (hasMarker) {
        try {
          updateWorkspaceStatus(workspaceId, 'executing')
          emit(workspaceId, 'agent:status', { status: 'executing' }, agent.claudeSessionId)
        } catch (err) {
          console.error('[agent] Failed to transition to executing:', err)
        }
      }
    }
  })

  // ── stderr — detect quota / rate limit errors ──
  proc.stderr?.on('data', (data: Buffer) => {
    // I1: Don't process quota errors if the agent is already stopping or gone
    const currentAgent = agents.get(workspaceId)
    if (!currentAgent || currentAgent.status === 'stopping') return

    const text = data.toString()
    const lowerText = text.toLowerCase()

    if (lowerText.includes('rate limit') || lowerText.includes('quota') || lowerText.includes('limit exceeded')) {
      handleQuota(workspaceId, workingDir, agent.claudeSessionId)
    }

    // Also emit stderr for visibility
    emit(workspaceId, 'agent:stderr', { content: text }, agent.claudeSessionId)
  })

  // ── process exit ──
  proc.on('exit', (code: number | null) => {
    // Clean up the .mcp.json file written before spawn
    try {
      fs.unlinkSync(mcpConfigPath)
    } catch {
      // File may not exist (spawn failed) — ignore
    }

    // I3: Close readline interface to release the stream reference
    agent.rl.close()

    unregisterProcess(workspaceId)
    agents.delete(workspaceId)

    // Clean up retry state and inactivity timer
    retryCounts.delete(workspaceId)
    // C2: Clear the kill timer if it's still pending (process exited naturally before SIGKILL)
    const pendingKillTimer = killTimers.get(workspaceId)
    if (pendingKillTimer) {
      clearTimeout(pendingKillTimer)
      killTimers.delete(workspaceId)
    }

    // Update agent_sessions row
    {
      const db = getDb()
      db.prepare('UPDATE agent_sessions SET status = ?, ended_at = ? WHERE id = ?').run(
        code === 0 ? 'completed' : 'error',
        new Date().toISOString(),
        agent.agentSessionId,
      )
    }

    if (agent.status === 'stopping') {
      // Clean stop requested
      emit(workspaceId, 'agent:status', { status: 'stopped' }, agent.claudeSessionId)
      return
    }

    // C1: Also clear backoff timers on non-stopping exit
    const pendingBackoff = backoffTimers.get(workspaceId)
    if (pendingBackoff) {
      clearTimeout(pendingBackoff)
      backoffTimers.delete(workspaceId)
    }

    if (code !== null && code !== 0) {
      try {
        updateWorkspaceStatus(workspaceId, 'error')
      } catch (err) {
        console.error('[agent] Failed to update workspace status on exit:', err)
      }
      emit(workspaceId, 'agent:status', { status: 'error', exitCode: code }, agent.claudeSessionId)
    } else {
      try {
        updateWorkspaceStatus(workspaceId, 'completed')
      } catch (err) {
        console.error('[agent] Failed to update workspace status on exit:', err)
      }
      emit(workspaceId, 'agent:status', { status: 'completed' }, agent.claudeSessionId)
    }
  })

  // Store in agents map
  agents.set(workspaceId, agent)

  // Notify frontend that agent is now running
  emit(workspaceId, 'agent:status', { status: 'executing' }, agent.claudeSessionId)

  return agent
}

// ── Stop agent ─────────────────────────────────────────────────────────────────

export function stopAgent(workspaceId: string): void {
  const agent = agents.get(workspaceId)
  if (!agent) {
    throw new Error(`No agent running for workspace '${workspaceId}'`)
  }

  agent.status = 'stopping'

  // Cancel any pending backoff timer
  const timer = backoffTimers.get(workspaceId)
  if (timer) {
    clearTimeout(timer)
    backoffTimers.delete(workspaceId)
  }

  // I3: Close readline interface now that we're stopping
  try {
    agent.rl.close()
  } catch {
    // Ignore
  }

  // Send SIGTERM
  try {
    agent.process.kill('SIGTERM')
  } catch {
    // Process may already be dead
  }

  // After 5s timeout, send SIGKILL if still running
  const killTimer = setTimeout(() => {
    // C2: Guard against race with natural exit — only act if this exact agent instance is still current
    if (agents.get(workspaceId) !== agent) {
      killTimers.delete(workspaceId)
      return
    }

    try {
      if (!agent.process.killed) {
        agent.process.kill('SIGKILL')
      }
    } catch {
      // Ignore
    }
    killTimers.delete(workspaceId)
  }, 5000)

  // Don't keep the process alive for this timer
  killTimer.unref?.()
  killTimers.set(workspaceId, killTimer)
}

// ── Send message to agent stdin ────────────────────────────────────────────────

export function sendMessage(workspaceId: string, content: string): void {
  const agent = agents.get(workspaceId)
  if (!agent) {
    throw new Error(`No agent running for workspace '${workspaceId}'`)
  }

  if (!agent.process.stdin?.writable) {
    throw new Error(`Agent stdin not writable for workspace '${workspaceId}'`)
  }

  agent.process.stdin.write(`${content}\n`)
}

// ── Status queries ─────────────────────────────────────────────────────────────

export function getAgentStatus(workspaceId: string): 'running' | 'stopping' | null {
  const agent = agents.get(workspaceId)
  return agent?.status ?? null
}

export function getRunningCount(): number {
  return agents.size
}

export function getAvailableSkills(): string[] {
  return availableSkills
}

// ── Quota handling ─────────────────────────────────────────────────────────────

function handleQuota(workspaceId: string, workingDir: string, claudeSessionId?: string): void {
  // Update workspace status
  try {
    updateWorkspaceStatus(workspaceId, 'quota')
  } catch {
    // May fail if transition is not valid
  }

  // Emit status event
  emit(workspaceId, 'agent:status', { status: 'quota' }, claudeSessionId)

  // Calculate backoff: 15min first, then 30min, then 60min cap
  const retryCount = retryCounts.get(workspaceId) ?? 0
  const backoffMinutes = Math.min(15 * 2 ** retryCount, 60)
  const backoffMs = backoffMinutes * 60 * 1000

  retryCounts.set(workspaceId, retryCount + 1)

  emit(
    workspaceId,
    'agent:status',
    {
      status: 'quota:backoff',
      retryCount: retryCount + 1,
      backoffMinutes,
    },
    claudeSessionId,
  )

  // Set timer to restart agent
  const timer = setTimeout(() => {
    backoffTimers.delete(workspaceId)

    // Only restart if not already running or stopped
    if (!agents.has(workspaceId)) {
      try {
        startAgent(workspaceId, workingDir, 'Continue the previous task where you left off.', undefined, true)
      } catch {
        // Agent restart failed
        emit(workspaceId, 'agent:status', { status: 'error', message: 'Quota retry failed' })
      }
    }
  }, backoffMs)

  timer.unref?.()
  backoffTimers.set(workspaceId, timer)
}

// ── Testing utilities ──────────────────────────────────────────────────────────

/**
 * Get the internal agents map — exposed for testing only.
 * @internal
 */
export function _getAgents(): Map<string, AgentInstance> {
  return agents
}

/**
 * Get retry counts — exposed for testing only.
 * @internal
 */
export function _getRetryCounts(): Map<string, number> {
  return retryCounts
}

/**
 * Get backoff timers — exposed for testing only.
 * @internal
 */
export function _getBackoffTimers(): Map<string, ReturnType<typeof setTimeout>> {
  return backoffTimers
}

/**
 * Get kill timers — exposed for testing only.
 * @internal
 */
export function _getKillTimers(): Map<string, ReturnType<typeof setTimeout>> {
  return killTimers
}

/**
 * Get session IDs map — exposed for testing only.
 * @internal
 */
export function _getSessionIds(): Map<string, string> {
  return sessionIds
}
