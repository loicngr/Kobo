import { describe, expect, it, vi } from 'vitest'
import { resolveClaudeBinaryPath } from '../server/services/agent/engines/claude-code/resolve-binary.js'

describe('resolveClaudeBinaryPath', () => {
  it('returns the glibc binary path on Linux glibc x64', () => {
    const resolveFn = vi.fn((id: string) => `/fake/node_modules/${id.replace('@anthropic-ai/', '@anthropic-ai/')}`)
    const path = resolveClaudeBinaryPath({ platform: 'linux', arch: 'x64', isGlibc: true }, resolveFn)
    expect(path).toBe('/fake/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude')
    expect(resolveFn).toHaveBeenCalledWith('@anthropic-ai/claude-agent-sdk-linux-x64/claude')
  })

  it('returns the glibc binary path on Linux glibc arm64', () => {
    const resolveFn = vi.fn((id: string) => `/fake/node_modules/${id}`)
    const path = resolveClaudeBinaryPath({ platform: 'linux', arch: 'arm64', isGlibc: true }, resolveFn)
    expect(path).toBe('/fake/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude')
  })

  it('returns undefined on Linux musl (let the SDK pick its musl variant)', () => {
    const resolveFn = vi.fn(() => '/should/not/be/called')
    const path = resolveClaudeBinaryPath({ platform: 'linux', arch: 'x64', isGlibc: false }, resolveFn)
    expect(path).toBeUndefined()
    expect(resolveFn).not.toHaveBeenCalled()
  })

  it('returns undefined on macOS', () => {
    const resolveFn = vi.fn(() => '/should/not/be/called')
    const path = resolveClaudeBinaryPath({ platform: 'darwin', arch: 'arm64', isGlibc: false }, resolveFn)
    expect(path).toBeUndefined()
    expect(resolveFn).not.toHaveBeenCalled()
  })

  it('returns undefined on Windows', () => {
    const resolveFn = vi.fn(() => '/should/not/be/called')
    const path = resolveClaudeBinaryPath({ platform: 'win32', arch: 'x64', isGlibc: false }, resolveFn)
    expect(path).toBeUndefined()
    expect(resolveFn).not.toHaveBeenCalled()
  })

  it('returns undefined on Linux glibc with an unsupported arch (e.g. ia32)', () => {
    const resolveFn = vi.fn(() => '/should/not/be/called')
    const path = resolveClaudeBinaryPath({ platform: 'linux', arch: 'ia32', isGlibc: true }, resolveFn)
    expect(path).toBeUndefined()
    expect(resolveFn).not.toHaveBeenCalled()
  })

  it('returns undefined when the glibc package is not installed (resolve throws)', () => {
    const resolveFn = vi.fn(() => {
      throw new Error("Cannot find module '@anthropic-ai/claude-agent-sdk-linux-x64/claude'")
    })
    const path = resolveClaudeBinaryPath({ platform: 'linux', arch: 'x64', isGlibc: true }, resolveFn)
    expect(path).toBeUndefined()
    expect(resolveFn).toHaveBeenCalledOnce()
  })
})
