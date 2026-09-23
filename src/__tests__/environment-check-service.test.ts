import { describe, expect, it, vi } from 'vitest'
import { checkEnvironment, type EnvironmentProbe } from '../server/services/environment-check-service.js'

function probe(): EnvironmentProbe {
  return {
    platform: 'linux',
    nodeVersion: '24.21.0',
    dataDirectory: '/private/data',
    run: vi.fn(async (_command: string, args: string[]) => (args.includes('--is-inside-work-tree') ? 'true' : 'ok')),
    writableDirectory: vi.fn(async () => true),
    claudeBinary: () => '/private/bin/claude',
    worktreesDirectory: () => '/private/worktrees',
    codexBinary: () => '/private/bin/codex',
  }
}

describe('environment readiness', () => {
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
