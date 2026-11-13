import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getIntegrationConfig, saveIntegrationConfig } from '../server/services/integration-config-service.js'
import { getSlackCredentials, saveSlackCredentials } from '../server/services/slack/slack-credentials.js'

let directory: string
const notion = { command: 'npx', args: ['n'], env: { TOKEN: 't' } }
const slack = { botToken: 'xoxb-1', appToken: 'xapp-1' }

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-slack-cred-'))
  vi.stubEnv('KOBO_HOME', directory)
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})

it('round-trips credentials with mode 0600', () => {
  expect(getSlackCredentials()).toBeNull()
  saveSlackCredentials(slack)
  expect(getSlackCredentials()).toEqual(slack)
  expect(fs.statSync(path.join(directory, 'integrations.json')).mode & 0o777).toBe(0o600)
})

it('rejects bad tokens without echoing them', () => {
  expect(() => saveSlackCredentials({ botToken: 'x', appToken: 'xapp-1' })).toThrow('Invalid Slack bot token')
  expect(() => saveSlackCredentials({ botToken: 'xoxb-SECRET', appToken: 'SECRET2' })).toThrow(
    'Invalid Slack app token',
  )
  try {
    saveSlackCredentials({ botToken: 'xoxb-SECRET', appToken: 'SECRET2' })
  } catch (e) {
    expect((e as Error).message).not.toContain('SECRET')
  }
})

it('keeps slack intact when notion is saved, and vice versa', () => {
  saveSlackCredentials(slack)
  saveIntegrationConfig('notion', notion)
  expect(getSlackCredentials()).toEqual(slack)
  saveSlackCredentials({ botToken: 'xoxb-2', appToken: 'xapp-2' })
  expect(getIntegrationConfig('notion')).toEqual(notion)
})

it('null removes only the slack key', () => {
  saveIntegrationConfig('notion', notion)
  saveSlackCredentials(slack)
  saveSlackCredentials(null)
  expect(getSlackCredentials()).toBeNull()
  expect(getIntegrationConfig('notion')).toEqual(notion)
})

it('returns null for a corrupt or non-object integrations file', () => {
  const file = path.join(directory, 'integrations.json')
  fs.writeFileSync(file, '{ truncated')
  expect(getSlackCredentials()).toBeNull()
  fs.writeFileSync(file, '[1]')
  expect(getSlackCredentials()).toBeNull()
})

it('returns null for a non-object slack entry or a missing appToken', () => {
  const file = path.join(directory, 'integrations.json')
  fs.writeFileSync(file, JSON.stringify({ slack: 'x' }))
  expect(getSlackCredentials()).toBeNull()
  fs.writeFileSync(file, JSON.stringify({ slack: { botToken: 'xoxb-1' } }))
  expect(getSlackCredentials()).toBeNull()
})

it('stores tokens trimmed', () => {
  saveSlackCredentials({ botToken: ' xoxb-1\n', appToken: 'xapp-1\n' })
  expect(getSlackCredentials()).toEqual(slack)
})
