import { type ChildProcess, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { getPackageVersion } from './paths.js'

/** JSON-RPC response envelope from an MCP server. */
export interface JsonRpcResponse {
  jsonrpc: string
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** An entry from the user's `~/.claude.json` under `mcpServers`. */
export interface ClaudeMcpEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  disabled?: boolean
}

interface ClaudeConfig {
  mcpServers?: Record<string, ClaudeMcpEntry>
}

export interface ActiveClaudeMcpEntry {
  key: string
  entry: ClaudeMcpEntry
}

function getClaudeConfigPath(): string {
  const homedir = process.env.HOME ?? process.env.USERPROFILE ?? ''
  return `${homedir}/.claude.json`
}

function readClaudeConfig(): ClaudeConfig | null {
  try {
    const raw = readFileSync(getClaudeConfigPath(), 'utf-8')
    return JSON.parse(raw) as ClaudeConfig
  } catch {
    return null
  }
}

/**
 * Read `~/.claude.json` and return the first `mcpServers` entry whose key
 * matches the predicate AND is not disabled (`disabled !== true`).
 * Returns `null` when the file is unreadable or no enabled match is found.
 *
 * Shared helper so every Kōbō integration that reuses a user-configured MCP
 * (Notion, Sentry, …) picks entries by the same rule.
 */
export function readClaudeMcpEntry(match: (key: string) => boolean): { key: string; entry: ClaudeMcpEntry } | null {
  const config = readClaudeConfig()
  if (!config) return null
  const servers = config.mcpServers ?? {}
  const key = Object.keys(servers).find((k) => match(k) && servers[k].disabled !== true)
  if (!key) return null
  return { key, entry: servers[key] }
}

/**
 * Read all enabled MCP entries from `~/.claude.json`.
 * Disabled entries (`disabled === true`) are excluded.
 */
export function listClaudeMcpEntries(): ActiveClaudeMcpEntry[] {
  const config = readClaudeConfig()
  if (!config) return []
  const servers = config.mcpServers ?? {}
  return Object.keys(servers)
    .filter((key) => servers[key].disabled !== true)
    .map((key) => ({ key, entry: servers[key] }))
}

const nextRpcId = (() => {
  let counter = 1
  return () => counter++
})()

/**
 * Spawn an MCP server process given explicit command, args, and env.
 * The caller is responsible for constructing the full env (including auth headers).
 * stderr is consumed silently; set DEBUG_MCP_STDERR=1 to print it.
 */
export function spawnMcpProcess(command: string, args: string[], env: Record<string, string>): ChildProcess {
  const mcpProcess = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })

  mcpProcess.stderr?.on('data', (data: Buffer) => {
    if (process.env.DEBUG_MCP_STDERR) {
      console.error('[mcp stderr]', data.toString())
    }
  })

  return mcpProcess
}

/** Send MCP initialize handshake (30s timeout). Kills process on timeout.
 *  Generous to accommodate slow MCP servers (npx cold start, remote host
 *  validation, first-run package fetch). Override with KOBO_MCP_INIT_TIMEOUT_MS. */
export async function initializeMcp(mcpProcess: ChildProcess): Promise<void> {
  const id = nextRpcId()
  const request = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'kobo', version: getPackageVersion() },
    },
  })

  await new Promise<void>((resolve, reject) => {
    if (!mcpProcess.stdin || !mcpProcess.stdout) {
      reject(new Error('MCP process not ready'))
      return
    }

    let buffer = ''

    const initTimeoutMs = Number(process.env.KOBO_MCP_INIT_TIMEOUT_MS) || 30_000
    const timeout = setTimeout(() => {
      mcpProcess.stdout?.removeListener('data', onData)
      mcpProcess.kill()
      reject(new Error(`initializeMcp timed out after ${initTimeoutMs}ms`))
    }, initTimeoutMs)

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const parsed = JSON.parse(trimmed) as JsonRpcResponse
          if (parsed.id === id) {
            clearTimeout(timeout)
            mcpProcess.stdout?.removeListener('data', onData)

            const initialized = JSON.stringify({
              jsonrpc: '2.0',
              method: 'notifications/initialized',
            })
            mcpProcess.stdin?.write(`${initialized}\n`)

            resolve()
          }
        } catch {
          // ignore
        }
      }
    }

    const onError = (err: Error) => {
      clearTimeout(timeout)
      mcpProcess.stdout?.removeListener('data', onData)
      reject(err)
    }

    mcpProcess.stdout.on('data', onData)
    mcpProcess.stdout.once('error', onError)

    mcpProcess.stdin.write(`${request}\n`)
  })
}

/** Send a JSON-RPC tools/call request and return the raw result (30s timeout). */
export async function callMcpTool(mcpProcess: ChildProcess, toolName: string, args: object): Promise<unknown> {
  const id = nextRpcId()
  const request = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  })

  return new Promise((resolve, reject) => {
    if (!mcpProcess.stdin || !mcpProcess.stdout) {
      reject(new Error('MCP process stdin/stdout not available'))
      return
    }

    let buffer = ''

    const timeout = setTimeout(() => {
      mcpProcess.stdout?.removeListener('data', onData)
      mcpProcess.stdout?.removeListener('error', onError)
      mcpProcess.kill()
      reject(new Error(`callMcpTool('${toolName}') timed out after 30s`))
    }, 30_000)

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        try {
          const parsed = JSON.parse(trimmed) as JsonRpcResponse
          if (parsed.id === id) {
            clearTimeout(timeout)
            mcpProcess.stdout?.removeListener('data', onData)
            mcpProcess.stdout?.removeListener('error', onError)

            if (parsed.error) {
              reject(new Error(`MCP tool '${toolName}' error: ${parsed.error.message} (code: ${parsed.error.code})`))
            } else {
              resolve(parsed.result)
            }
          }
        } catch {
          // Ignore JSON parse errors for partial lines
        }
      }
    }

    const onError = (err: Error) => {
      clearTimeout(timeout)
      mcpProcess.stdout?.removeListener('data', onData)
      reject(err)
    }

    mcpProcess.stdout.on('data', onData)
    mcpProcess.stdout.once('error', onError)

    mcpProcess.stdin.write(`${request}\n`)
  })
}

/**
 * Unwrap the MCP tool response envelope.
 * MCP returns `{ content: [{ type: "text", text: "..." }] }` where `text`
 * may be a JSON-stringified object or plain markdown/text.
 */
export function unwrapMcpResult(result: unknown): unknown {
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>
    if (Array.isArray(obj.content)) {
      const first = obj.content[0] as { type?: string; text?: string } | undefined
      if (first?.type === 'text' && first.text) {
        try {
          return JSON.parse(first.text)
        } catch {
          return first.text
        }
      }
    }
  }
  return result
}
