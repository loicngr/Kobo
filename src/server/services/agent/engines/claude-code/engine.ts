import { type ChildProcess, spawn } from 'node:child_process'
import readline from 'node:readline'
import type { AgentEngine, EngineProcess, StartOptions } from '../types.js'
import { buildClaudeArgs } from './args-builder.js'
import { CLAUDE_CODE_CAPABILITIES } from './capabilities.js'
import { cleanupMcpConfig, writeMcpConfig } from './mcp-config.js'
import { createParserState, parseClaudeLine } from './stream-parser.js'

export function createClaudeCodeEngine(): AgentEngine {
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilities: CLAUDE_CODE_CAPABILITIES,
    async start(options: StartOptions, onEvent): Promise<EngineProcess> {
      // Write MCP config if any servers requested + engine supports MCP
      let mcpConfigPath: string | undefined
      if (options.mcpServers && options.mcpServers.length > 0) {
        mcpConfigPath = writeMcpConfig(options.workingDir, options.mcpServers)
      }

      const { args } = buildClaudeArgs({
        prompt: options.prompt,
        model: options.model,
        effort: options.effort,
        permissionMode: options.permissionMode ?? 'auto-accept',
        skipPermissions: options.settings.dangerouslySkipPermissions ?? true,
        permissionProfile: options.permissionProfile,
        resumeFromEngineSessionId: options.resumeFromEngineSessionId,
        mcpConfigPath,
      })

      const proc: ChildProcess = spawn('claude', args, {
        cwd: options.workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const parserState = createParserState()

      if (!proc.stdout) throw new Error('Claude process has no stdout')
      const rl = readline.createInterface({
        input: proc.stdout,
        crlfDelay: Number.POSITIVE_INFINITY,
      })

      let discoveredSessionId: string | undefined

      rl.on('line', (line: string) => {
        const { events } = parseClaudeLine(line, parserState)
        for (const ev of events) {
          if (ev.kind === 'session:started') discoveredSessionId = ev.engineSessionId
          onEvent(ev)
        }
      })

      // Line-buffer stderr so we see one event per log line instead of
      // arbitrary byte chunks, and restrict quota detection to clear rate-
      // limit signals (not every occurrence of the word "rate" or "quota").
      // Non-quota stderr lines are logged to the console but do NOT emit
      // an error event — this avoids false positives flooding the UI.
      const stderrRl = proc.stderr
        ? readline.createInterface({
            input: proc.stderr,
            crlfDelay: Number.POSITIVE_INFINITY,
          })
        : undefined

      // Known benign stderr lines from the Claude CLI that should NOT be
      // logged — they flood the dev console and carry no actionable info.
      // Strip ANSI color codes before matching.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes by design
      const stripAnsi = (s: string) => s.replace(/\u001b\[\d+m/g, '')
      function isBenignStderr(line: string): boolean {
        const cleaned = stripAnsi(line).trim()
        return /^warning: no stdin data received in \d+s/i.test(cleaned)
      }

      stderrRl?.on('line', (line: string) => {
        const lower = line.toLowerCase()
        const isQuota =
          lower.includes('rate limit exceeded') ||
          lower.includes('rate_limit_exceeded') ||
          (lower.includes('429') && lower.includes('rate')) ||
          lower.includes('quota exceeded')
        const isResumeFailed = lower.includes('no conversation found with session id')
        if (isQuota) {
          onEvent({ kind: 'error', category: 'quota', message: line })
        } else if (isResumeFailed) {
          onEvent({ kind: 'error', category: 'resume_failed', message: line })
          console.warn(`[claude-engine stderr] ${line}`)
        } else if (line.trim().length > 0 && !isBenignStderr(line)) {
          console.warn(`[claude-engine stderr] ${line}`)
        }
      })

      // 'error' fires when spawn itself fails (e.g. ENOENT if the `claude`
      // binary is missing from PATH). In that case 'exit' never fires, so we
      // emit the lifecycle pair here and clean the MCP config ourselves.
      proc.on('error', (err: Error) => {
        onEvent({ kind: 'error', category: 'spawn_failed', message: err.message })
        onEvent({ kind: 'session:ended', reason: 'error', exitCode: null })
        cleanupMcpConfig(options.workingDir)
        rl.close()
        stderrRl?.close()
      })

      proc.on('exit', (code: number | null) => {
        cleanupMcpConfig(options.workingDir)
        rl.close()
        stderrRl?.close()
        onEvent({
          kind: 'session:ended',
          reason: code === 0 ? 'completed' : code === null ? 'killed' : 'error',
          exitCode: code,
        })
      })

      const engineProcess: EngineProcess = {
        get pid() {
          return proc.pid
        },
        get engineSessionId() {
          return discoveredSessionId
        },
        sendMessage(text: string) {
          if (!proc.stdin?.writable) throw new Error('Agent stdin not writable')
          proc.stdin.write(`${text}\n`)
        },
        interrupt() {
          if (proc.pid !== undefined) process.kill(proc.pid, 'SIGINT')
        },
        stop() {
          return new Promise<void>((resolve) => {
            if (proc.killed || proc.exitCode !== null) return resolve()
            let resolved = false
            let killTimer: ReturnType<typeof setTimeout> | undefined
            let hardTimeout: ReturnType<typeof setTimeout> | undefined
            const doResolve = () => {
              if (resolved) return
              resolved = true
              if (killTimer) clearTimeout(killTimer)
              if (hardTimeout) clearTimeout(hardTimeout)
              resolve()
            }
            proc.once('exit', doResolve)
            try {
              proc.kill('SIGTERM')
            } catch {
              // Already dead
            }
            killTimer = setTimeout(() => {
              try {
                if (!proc.killed) proc.kill('SIGKILL')
              } catch {
                // Ignore
              }
            }, 5000)
            killTimer.unref?.()
            // Hard-timeout safety net: if the process hasn't exited within 10s
            // (5s after SIGKILL), resolve anyway so callers never hang forever.
            hardTimeout = setTimeout(() => {
              console.warn('[claude-engine] stop() hard-timeout reached, resolving anyway')
              doResolve()
            }, 10000)
            hardTimeout.unref?.()
          })
        },
      }
      return engineProcess
    },
  }
}
