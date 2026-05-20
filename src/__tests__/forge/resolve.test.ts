// src/__tests__/forge/resolve.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getProjectSettingsMock = vi.fn()
vi.mock('../../server/services/settings-service.js', () => ({
  getProjectSettings: (p: string) => getProjectSettingsMock(p),
}))

const execFileSyncMock = vi.fn()
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}))

import { forgeFromRemoteUrl, resolveForge } from '../../server/services/forge/resolve.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('forgeFromRemoteUrl', () => {
  it('detects github from an https remote', () => {
    expect(forgeFromRemoteUrl('https://github.com/o/r.git')).toBe('github')
  })

  it('detects github from an ssh remote', () => {
    expect(forgeFromRemoteUrl('git@github.com:o/r.git')).toBe('github')
  })

  it('detects gitlab.com', () => {
    expect(forgeFromRemoteUrl('https://gitlab.com/o/r.git')).toBe('gitlab')
  })

  it('detects a self-hosted gitlab host', () => {
    expect(forgeFromRemoteUrl('git@gitlab.mycorp.com:o/r.git')).toBe('gitlab')
  })

  it('returns none for an unrecognised host', () => {
    expect(forgeFromRemoteUrl('https://example.com/o/r.git')).toBe('none')
  })

  it('returns none for an empty url', () => {
    expect(forgeFromRemoteUrl('')).toBe('none')
  })
})

describe('resolveForge', () => {
  it('returns the explicit project setting, ignoring the remote', () => {
    getProjectSettingsMock.mockReturnValue({ forge: 'gitlab' })
    execFileSyncMock.mockReturnValue('https://github.com/o/r.git\n')
    expect(resolveForge('/p')).toBe('gitlab')
  })

  it('auto-detects from the remote when the setting is "auto"', () => {
    getProjectSettingsMock.mockReturnValue({ forge: 'auto' })
    execFileSyncMock.mockReturnValue('https://github.com/o/r.git\n')
    expect(resolveForge('/p')).toBe('github')
  })

  it('returns none when auto and there is no remote', () => {
    getProjectSettingsMock.mockReturnValue({ forge: 'auto' })
    execFileSyncMock.mockImplementation(() => {
      throw new Error('no remote')
    })
    expect(resolveForge('/p')).toBe('none')
  })

  it('defaults to auto-detection when project settings are null', () => {
    getProjectSettingsMock.mockReturnValue(null)
    execFileSyncMock.mockReturnValue('git@gitlab.com:o/r.git\n')
    expect(resolveForge('/p')).toBe('gitlab')
  })
})
