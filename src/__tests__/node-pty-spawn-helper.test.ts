import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureSpawnHelperExecutable } from '../server/utils/node-pty-spawn-helper.js'

let root: string

function helper(arch: string): string {
  const file = path.join(root, 'prebuilds', `darwin-${arch}`, 'spawn-helper')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'binary')
  fs.chmodSync(file, 0o644) // As published by node-pty 1.1.0.
  return file
}

const mode = (file: string) => fs.statSync(file).mode & 0o777

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-node-pty-'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('ensureSpawnHelperExecutable', () => {
  it('restores the execute bit on the macOS prebuilt helper for this architecture', () => {
    const arm = helper('arm64')
    const intel = helper('x64')
    expect(ensureSpawnHelperExecutable({ platform: 'darwin', arch: 'arm64', root })).toBe(arm)
    expect(mode(arm)).toBe(0o755)
    expect(mode(intel)).toBe(0o644)
  })

  it('leaves an already executable helper untouched', () => {
    const arm = helper('arm64')
    fs.chmodSync(arm, 0o700)
    ensureSpawnHelperExecutable({ platform: 'darwin', arch: 'arm64', root })
    expect(mode(arm)).toBe(0o700)
  })

  it('does nothing outside macOS, where node-pty does not use the helper', () => {
    const arm = helper('arm64')
    expect(ensureSpawnHelperExecutable({ platform: 'linux', arch: 'arm64', root })).toBeNull()
    expect(mode(arm)).toBe(0o644)
  })

  it('does nothing when no prebuilt helper exists (built from source)', () => {
    expect(ensureSpawnHelperExecutable({ platform: 'darwin', arch: 'arm64', root })).toBeNull()
  })
})
