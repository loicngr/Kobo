import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_CODE_CAPABILITIES } from '../server/services/agent/engines/claude-code/capabilities.js'
import { CODEX_CAPABILITIES } from '../server/services/agent/engines/codex/capabilities.js'
import { MISTRAL_CAPABILITIES } from '../server/services/agent/engines/mistral-vibe/capabilities.js'
import { checkEnvironment, type EnvironmentProbe } from '../server/services/environment-check-service.js'
import { MISTRAL_MODELS } from '../shared/mistral-models.js'

function probe(): EnvironmentProbe {
  return {
    platform: 'linux',
    nodeVersion: '26.12.1',
    dataDirectory: '/private/data',
    run: vi.fn(async (_command: string, args: string[]) => (args.includes('--is-inside-work-tree') ? 'true' : 'ok')),
    writableDirectory: vi.fn(async () => true),
    claudeBinary: () => '/private/bin/claude',
    worktreesDirectory: () => '/private/worktrees',
    codexBinary: () => '/private/bin/codex',
    mistralBinary: () => 'vibe-acp',
  }
}

describe('environment readiness', () => {
  it('advertises only native execution capabilities for Mistral', () => {
    expect(MISTRAL_MODELS.map((model) => model.id)).toEqual(['auto'])
    expect(MISTRAL_CAPABILITIES).toEqual({
      models: [{ id: 'auto', label: 'Auto' }],
      effortLevels: [{ id: 'auto', label: 'Auto' }],
      permissionModes: ['interactive', 'strict', 'bypass'],
      supportsResume: true,
      supportsMcp: true,
      supportsReadOnly: false,
      supportsLiveSteering: false,
      supportsSkills: false,
      supportsSubagents: false,
      supportsQuotaStatus: false,
    })
    for (const capabilities of [CLAUDE_CODE_CAPABILITIES, CODEX_CAPABILITIES]) {
      expect(capabilities.supportsReadOnly).toBe(true)
      expect(capabilities.supportsLiveSteering).toBe(true)
    }
  })

  it('checks the Vibe version without claiming authentication or model access', async () => {
    const deps = probe()
    const report = await checkEnvironment({ engine: 'mistral-vibe' }, deps)
    expect(report.engine).toBe('mistral-vibe')
    expect(report.checks.find((check) => check.code === 'runtime')?.status).toBe('ok')
    expect(report.checks.find((check) => check.code === 'authentication')?.status).toBe('unknown')
    expect(report.checks.find((check) => check.code === 'model')?.status).toBe('unknown')
    expect(deps.run).toHaveBeenCalledWith('vibe-acp', ['--version'])
    expect(deps.run).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['ENOENT', 'missing'],
    ['ETIMEDOUT', 'error'],
    ['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'error'],
  ])('sanitizes the Vibe diagnostic failure %s', async (code, expected) => {
    const deps = probe()
    deps.run = vi.fn(async (command) => {
      if (command === 'vibe-acp') throw Object.assign(new Error('SECRET_CANARY /private/credentials'), { code })
      return 'ok'
    })
    const report = await checkEnvironment({ engine: 'mistral-vibe' }, deps)
    expect(report.checks.find((check) => check.code === 'runtime')?.status).toBe(expected)
    expect(JSON.stringify(report)).not.toContain('SECRET_CANARY')
    expect(JSON.stringify(report)).not.toContain('/private')
  })

  it.each([
    ['24.21.0', 'error'],
    ['26.11.99', 'error'],
    ['26.12.0', 'error'],
    ['26.12.1', 'ok'],
    ['26.12.2', 'ok'],
    ['26.13.0', 'ok'],
    ['27.0.0', 'ok'],
  ])('checks the Node.js minimum for %s', async (nodeVersion, expected) => {
    const report = await checkEnvironment({ engine: 'claude-code' }, { ...probe(), nodeVersion })
    expect(report.checks.find((check) => check.code === 'node')?.status).toBe(expected)
  })

  it('distinguishes an installed engine from unverified authentication and model access', async () => {
    const report = await checkEnvironment({ engine: 'claude-code' }, probe())
    expect(report.checks.find((c) => c.code === 'runtime')?.status).toBe('ok')
    expect(report.checks.find((c) => c.code === 'authentication')?.status).toBe('unknown')
    expect(report.checks.find((c) => c.code === 'model')?.status).toBe('unknown')
    expect(JSON.stringify(report)).not.toContain('/private')
  })

  it('reports missing prerequisites without leaking subprocess output or starting a generation', async () => {
    const deps = probe()
    deps.run = vi.fn(async () => {
      throw Object.assign(new Error('SECRET_CANARY /private/auth.json'), { code: 'ENOENT' })
    })
    const report = await checkEnvironment({ engine: 'codex' }, deps)
    expect(report.checks.find((c) => c.code === 'runtime')?.status).toBe('missing')
    expect(JSON.stringify(report)).not.toContain('SECRET_CANARY')
    expect(deps.run).toHaveBeenCalledWith('/private/bin/codex', ['--version'])
    expect(deps.run).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['exec']))
  })

  it('accepts a local repository without a remote but requires its first commit', async () => {
    const deps = probe()
    deps.run = vi.fn(async (_cmd, args) => {
      if (args.includes('--is-inside-work-tree')) return 'true'
      if (args.includes('HEAD')) throw new Error('no commits')
      return 'ok'
    })
    const report = await checkEnvironment({ engine: 'codex', projectPath: '/private/repo' }, deps)
    expect(report.checks.find((c) => c.code === 'repository')?.status).toBe('ok')
    expect(report.checks.find((c) => c.code === 'firstCommit')?.status).toBe('missing')
    expect(deps.run).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['fetch']))
  })

  it('does not advertise native Windows or an old Node version as supported', async () => {
    const deps = { ...probe(), platform: 'win32' as const, nodeVersion: '24.14.0' }
    const report = await checkEnvironment({ engine: 'claude-code' }, deps)
    expect(report.checks.find((c) => c.code === 'platform')?.status).toBe('error')
    expect(report.checks.find((c) => c.code === 'node')?.status).toBe('error')
  })

  it('does not report an unlocated Claude executable as available', async () => {
    const deps = probe()
    deps.claudeBinary = () => undefined
    const report = await checkEnvironment({ engine: 'claude-code' }, deps)
    expect(report.checks.find((c) => c.code === 'runtime')?.status).toBe('unknown')
  })

  it('distinguishes runtime failure from missing executable', async () => {
    const deps = probe()
    deps.run = vi.fn(async () => {
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
    })
    const report = await checkEnvironment({ engine: 'codex' }, deps)
    expect(report.checks.find((c) => c.code === 'runtime')?.status).toBe('error')
  })

  it('checks the effective worktree destination', async () => {
    const deps = probe()
    deps.writableDirectory = vi.fn(async (p) => p !== '/private/worktrees')
    const report = await checkEnvironment({ engine: 'codex', projectPath: '/private/repo' }, deps)
    expect(report.checks.find((c) => c.code === 'worktrees')?.status).toBe('error')
  })

  it('reports unwritable storage and project directories', async () => {
    const deps = probe()
    deps.writableDirectory = vi.fn(async () => false)
    const report = await checkEnvironment({ engine: 'codex', projectPath: '/private/repo' }, deps)
    expect(report.checks.find((c) => c.code === 'storage')?.status).toBe('error')
    expect(report.checks.find((c) => c.code === 'projectWritable')?.status).toBe('error')
  })
})
