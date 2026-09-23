import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import type { EnvironmentCheckStatus, EnvironmentReport } from '../../shared/environment.js'
import { getKoboHome } from '../utils/paths.js'
import { resolveWorktreesRoot } from '../utils/worktree-paths.js'
import { detectPlatform, resolveClaudeBinaryPath } from './agent/engines/claude-code/resolve-binary.js'
import { resolveCodexBinary } from './agent/engines/codex/spawn.js'
import { getGlobalSettings } from './settings-service.js'

const runFile = promisify(execFile)
const require = createRequire(import.meta.url)

export interface EnvironmentRequest {
  engine: EnvironmentReport['engine']
  projectPath?: string
}

export interface EnvironmentProbe {
  platform: NodeJS.Platform
  nodeVersion: string
  dataDirectory: string
  run: (command: string, args: string[]) => Promise<string>
  writableDirectory: (directory: string, allowMissing?: boolean) => Promise<boolean>
  claudeBinary: () => string | undefined
  worktreesDirectory: (projectPath: string) => string
  codexBinary: () => string
}

/** Probe the nearest existing parent without creating directories or test files. */
async function writableDirectory(directory: string, allowMissing = false): Promise<boolean> {
  let current = path.resolve(directory)
  for (;;) {
    try {
      const info = await stat(current)
      if (!info.isDirectory()) return false
      await access(current, constants.W_OK | constants.X_OK)
      return true
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') return false
      const parent = path.dirname(current)
      if (parent === current) return false
      current = parent
    }
  }
}

function liveProbe(): EnvironmentProbe {
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    dataDirectory: getKoboHome(),
    run: async (command, args) => {
      const { stdout } = await runFile(command, args, {
        timeout: 3_000,
        killSignal: 'SIGKILL',
        maxBuffer: 16_384,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
      return stdout.trim()
    },
    writableDirectory,
    claudeBinary: () => {
      const binary = resolveClaudeBinaryPath()
      if (binary) return binary
      const platform = detectPlatform()
      try {
        if (platform.platform === 'darwin')
          return require.resolve(`@anthropic-ai/claude-agent-sdk-darwin-${platform.arch}/claude`)
        if (platform.platform === 'linux' && !platform.isGlibc)
          return require.resolve(`@anthropic-ai/claude-agent-sdk-linux-${platform.arch}-musl/claude`)
      } catch {
        /* The SDK may support another layout: do not claim it is executable. */
      }
      return undefined
    },
    worktreesDirectory: (project) => resolveWorktreesRoot(project, getGlobalSettings().worktreesPath),
    codexBinary: resolveCodexBinary,
  }
}

/** No credential files, provider calls, generated prompts, or raw process errors in this report. */
export async function checkEnvironment(
  request: EnvironmentRequest,
  probe: EnvironmentProbe = liveProbe(),
): Promise<EnvironmentReport> {
  const [major, minor] = probe.nodeVersion.split('.').map(Number)
  const checks: EnvironmentReport['checks'] = [
    { code: 'node', status: major > 24 || (major === 24 && minor >= 15) ? 'ok' : 'error' },
    { code: 'platform', status: ['linux', 'darwin'].includes(probe.platform) ? 'ok' : 'error' },
  ]
  const commandAvailable = async (command: string, args: string[]): Promise<EnvironmentCheckStatus> => {
    try {
      await probe.run(command, args)
      return 'ok'
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'error'
    }
  }
  const binary = request.engine === 'codex' ? probe.codexBinary() : probe.claudeBinary()
  const [git, shell, storage, runtime] = await Promise.all([
    commandAvailable('git', ['--version']),
    commandAvailable('bash', ['--version']),
    probe.writableDirectory(probe.dataDirectory, true),
    binary ? commandAvailable(binary, ['--version']) : Promise.resolve('unknown' as const),
  ])
  checks.push(
    { code: 'git', status: git },
    { code: 'shell', status: shell },
    { code: 'storage', status: storage ? 'ok' : 'error' },
    { code: 'runtime', status: runtime },
    { code: 'authentication', status: 'unknown' },
    { code: 'model', status: 'unknown' },
  )
  if (request.projectPath) {
    const args = ['-C', path.resolve(request.projectPath)]
    let repository = false
    try {
      repository = (await probe.run('git', [...args, 'rev-parse', '--is-inside-work-tree'])) === 'true'
    } catch {
      // No stderr is returned: it may contain a private path or remote URL.
    }
    const [commit, writable, worktrees] = await Promise.all([
      repository ? commandAvailable('git', [...args, 'rev-parse', '--verify', 'HEAD']) : false,
      probe.writableDirectory(request.projectPath),
      probe.writableDirectory(probe.worktreesDirectory(request.projectPath), true),
    ])
    checks.push(
      { code: 'repository', status: repository ? 'ok' : 'error' },
      { code: 'firstCommit', status: commit === 'ok' ? 'ok' : 'missing' },
      { code: 'projectWritable', status: writable ? 'ok' : 'error' },
      { code: 'worktrees', status: worktrees ? 'ok' : 'error' },
    )
  }
  return { engine: request.engine, checkedAt: new Date().toISOString(), checks }
}

const pending = new Map<string, Promise<EnvironmentReport>>()

/** Coalesce tabs checking the same target; do not retain private paths after completion. */
export function getEnvironmentReport(request: EnvironmentRequest): Promise<EnvironmentReport> {
  const key = JSON.stringify(request)
  const existing = pending.get(key)
  if (existing) return existing
  if (pending.size >= 8) return Promise.reject(new Error('ENVIRONMENT_BUSY'))
  const result = checkEnvironment(request).finally(() => pending.delete(key))
  pending.set(key, result)
  return result
}
