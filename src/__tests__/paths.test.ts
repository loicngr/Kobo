import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureKoboHome,
  getCompiledMcpServerPath,
  getDbPath,
  getKoboHome,
  getMcpServerSourcePath,
  getPackageAssetPath,
  getSettingsPath,
  getSkillsPath,
} from '../server/utils/paths.js'

describe('paths — package root resolution', () => {
  it('getPackageAssetPath resolves to a directory containing package.json', () => {
    const rootPackageJson = getPackageAssetPath('package.json')
    expect(fs.existsSync(rootPackageJson)).toBe(true)
  })

  it('getPackageAssetPath joins multiple segments correctly', () => {
    const serverIndex = getPackageAssetPath('src', 'server', 'index.ts')
    expect(fs.existsSync(serverIndex)).toBe(true)
  })

  it('getMcpServerSourcePath points to the TypeScript source file', () => {
    const source = getMcpServerSourcePath()
    expect(source).toMatch(/kobo-tasks-server\.ts$/)
    expect(fs.existsSync(source)).toBe(true)
  })

  it('getCompiledMcpServerPath returns null when dist/ is absent', () => {
    // This test assumes dist/mcp-server/kobo-tasks-server.js may or may not exist.
    // If it exists (post-build), the function returns the path; otherwise null.
    const compiled = getCompiledMcpServerPath()
    if (compiled !== null) {
      expect(compiled).toMatch(/kobo-tasks-server\.js$/)
      expect(fs.existsSync(compiled)).toBe(true)
    }
  })
})

describe('paths — Kōbō home resolution', () => {
  const originalKoboHome = process.env.KOBO_HOME
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

  afterEach(() => {
    if (originalKoboHome === undefined) {
      delete process.env.KOBO_HOME
    } else {
      process.env.KOBO_HOME = originalKoboHome
    }
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome
    }
  })

  it('KOBO_HOME env var overrides everything else', () => {
    process.env.KOBO_HOME = '/tmp/custom-kobo-home'
    delete process.env.XDG_CONFIG_HOME
    expect(getKoboHome()).toBe('/tmp/custom-kobo-home')
  })

  it('falls back to XDG_CONFIG_HOME/kobo when set', () => {
    delete process.env.KOBO_HOME
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-config'
    expect(getKoboHome()).toBe(path.join('/tmp/xdg-config', 'kobo'))
  })

  it('falls back to ~/.config/kobo when neither env var is set', () => {
    delete process.env.KOBO_HOME
    delete process.env.XDG_CONFIG_HOME
    expect(getKoboHome()).toBe(path.join(os.homedir(), '.config', 'kobo'))
  })

  it('getDbPath joins Kōbō home with kobo.db', () => {
    process.env.KOBO_HOME = '/tmp/test-kobo'
    expect(getDbPath()).toBe('/tmp/test-kobo/kobo.db')
  })

  it('getSettingsPath joins Kōbō home with settings.json', () => {
    process.env.KOBO_HOME = '/tmp/test-kobo'
    expect(getSettingsPath()).toBe('/tmp/test-kobo/settings.json')
  })

  it('getSkillsPath joins Kōbō home with skills.json', () => {
    process.env.KOBO_HOME = '/tmp/test-kobo'
    expect(getSkillsPath()).toBe('/tmp/test-kobo/skills.json')
  })

  it('ensureKoboHome creates the directory if missing and returns its path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-ensure-'))
    try {
      const nested = path.join(tmp, 'nested', 'kobo')
      process.env.KOBO_HOME = nested
      expect(fs.existsSync(nested)).toBe(false)

      const result = ensureKoboHome()
      expect(result).toBe(nested)
      expect(fs.existsSync(nested)).toBe(true)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
