import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { createRequire } from 'node:module'

const requireFn = createRequire(import.meta.url)

export function resolveCodexBinary(): string {
  try {
    const pkgPath = requireFn.resolve('@openai/codex/package.json')
    const pkg = requireFn(pkgPath) as {
      bin?: Record<string, string> | string
    }
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.codex
    if (binRel) {
      const url = new URL(binRel, `file://${pkgPath}`)
      return url.pathname
    }
  } catch {
    // fall through to default
  }
  return 'codex'
}

export function spawnAppServer(opts: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): ChildProcess {
  const bin = resolveCodexBinary()
  return nodeSpawn(bin, ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: opts.cwd,
    env: opts.env,
    signal: opts.signal,
  })
}
