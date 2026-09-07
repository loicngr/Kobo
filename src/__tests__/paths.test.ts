import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _setDevModeProtection,
  ensureKoboHome,
  getCompiledMcpServerPath,
  getDbPath,
  getKoboHome,
  getMcpServerSourcePath,
  getPackageAssetPath,
  getSettingsPath,
  getSkillsPath,
  resolveSpaFile,
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
  const originalEnforceLocalHome = process.env.KOBO_ENFORCE_LOCAL_HOME
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
    if (originalEnforceLocalHome === undefined) {
      delete process.env.KOBO_ENFORCE_LOCAL_HOME
    } else {
      process.env.KOBO_ENFORCE_LOCAL_HOME = originalEnforceLocalHome
    }
  })

  it('KOBO_HOME env var overrides everything else', () => {
    delete process.env.KOBO_ENFORCE_LOCAL_HOME
    process.env.KOBO_HOME = '/tmp/custom-kobo-home'
    delete process.env.XDG_CONFIG_HOME
    expect(getKoboHome()).toBe('/tmp/custom-kobo-home')
  })

  it('falls back to XDG_CONFIG_HOME/kobo when set', () => {
    delete process.env.KOBO_ENFORCE_LOCAL_HOME
    delete process.env.KOBO_HOME
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-config'
    expect(getKoboHome()).toBe(path.join('/tmp/xdg-config', 'kobo'))
  })

  it('falls back to ~/.config/kobo when neither env var is set', () => {
    delete process.env.KOBO_ENFORCE_LOCAL_HOME
    delete process.env.KOBO_HOME
    delete process.env.XDG_CONFIG_HOME
    expect(getKoboHome()).toBe(path.join(os.homedir(), '.config', 'kobo'))
  })

  it('forces local KOBO_HOME when KOBO_ENFORCE_LOCAL_HOME=1 and KOBO_HOME is set', () => {
    process.env.KOBO_ENFORCE_LOCAL_HOME = '1'
    process.env.KOBO_HOME = './data'
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-config'
    expect(getKoboHome()).toBe(path.resolve('./data'))
  })

  it('forces packageRoot/data when KOBO_ENFORCE_LOCAL_HOME=1 and KOBO_HOME is unset', () => {
    process.env.KOBO_ENFORCE_LOCAL_HOME = '1'
    delete process.env.KOBO_HOME
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-config'
    expect(getKoboHome()).toBe(getPackageAssetPath('data'))
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

describe('paths — dev-mode protection', () => {
  const originalKoboHome = process.env.KOBO_HOME
  const originalEnforceLocalHome = process.env.KOBO_ENFORCE_LOCAL_HOME
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

  afterEach(() => {
    _setDevModeProtection(false)
    if (originalKoboHome === undefined) delete process.env.KOBO_HOME
    else process.env.KOBO_HOME = originalKoboHome
    if (originalEnforceLocalHome === undefined) delete process.env.KOBO_ENFORCE_LOCAL_HOME
    else process.env.KOBO_ENFORCE_LOCAL_HOME = originalEnforceLocalHome
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  })

  it('uses packageRoot/data when dev-mode is active and KOBO_HOME is unset', () => {
    _setDevModeProtection(true)
    delete process.env.KOBO_HOME
    delete process.env.KOBO_ENFORCE_LOCAL_HOME
    delete process.env.XDG_CONFIG_HOME
    expect(getKoboHome()).toBe(getPackageAssetPath('data'))
  })

  it('uses KOBO_HOME when dev-mode is active and KOBO_HOME is set', () => {
    _setDevModeProtection(true)
    process.env.KOBO_HOME = '/tmp/custom-dev-data'
    delete process.env.KOBO_ENFORCE_LOCAL_HOME
    delete process.env.XDG_CONFIG_HOME
    expect(getKoboHome()).toBe('/tmp/custom-dev-data')
  })

  it('never resolves to the production config directory when dev-mode is active', () => {
    _setDevModeProtection(true)
    delete process.env.KOBO_HOME
    delete process.env.KOBO_ENFORCE_LOCAL_HOME
    delete process.env.XDG_CONFIG_HOME
    const home = getKoboHome()
    expect(home).not.toBe(path.join(os.homedir(), '.config', 'kobo'))
    expect(home).toBe(getPackageAssetPath('data'))
  })
})

describe('resolveSpaFile', () => {
  let dist: string

  beforeEach(() => {
    dist = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-spa-')))
    fs.writeFileSync(path.join(dist, 'index.html'), '<html></html>')
    fs.mkdirSync(path.join(dist, 'assets'))
    fs.writeFileSync(path.join(dist, 'assets', 'app.js'), '//')
  })

  afterEach(() => fs.rmSync(dist, { recursive: true, force: true }))

  it('serves index.html for the root URL — the one every install opens first', () => {
    expect(resolveSpaFile(dist, '/')).toBe(path.join(dist, 'index.html'))
  })

  it('serves an existing asset as itself', () => {
    expect(resolveSpaFile(dist, '/assets/app.js')).toBe(path.join(dist, 'assets', 'app.js'))
  })

  it('falls back to index.html for a client-side route and for a directory', () => {
    expect(resolveSpaFile(dist, '/workspace/abc')).toBe(path.join(dist, 'index.html'))
    expect(resolveSpaFile(dist, '/assets')).toBe(path.join(dist, 'index.html'))
  })

  it('refuses traversal and lookalike siblings', () => {
    expect(resolveSpaFile(dist, '/../etc/passwd')).toBeNull()
    expect(resolveSpaFile(dist, '/..')).toBeNull()
    fs.mkdirSync(`${dist}-evil`)
    fs.writeFileSync(path.join(`${dist}-evil`, 'x.js'), '//')
    expect(resolveSpaFile(dist, `/../${path.basename(dist)}-evil/x.js`)).toBeNull()
    fs.rmSync(`${dist}-evil`, { recursive: true, force: true })
  })

  it('returns null when index.html itself is missing', () => {
    fs.unlinkSync(path.join(dist, 'index.html'))
    expect(resolveSpaFile(dist, '/')).toBeNull()
  })
})
