import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  getIntegrationConfig,
  getIntegrationStatus,
  saveIntegrationConfig,
} from '../server/services/integration-config-service.js'
import { buildNotionMcpConfig } from '../server/services/notion-service.js'
import { readSentryMcpConfig } from '../server/services/sentry-service.js'

let directory: string
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-integration-'))
  vi.stubEnv('KOBO_HOME', directory)
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})
it('stores a direct integration without Claude configuration and exposes no credentials', () => {
  saveIntegrationConfig('sentry', { command: 'npx', args: ['sentry-server'], env: { TOKEN: 'SECRET_CANARY' } })
  expect(getIntegrationConfig('sentry')?.env.TOKEN).toBe('SECRET_CANARY')
  expect(getIntegrationStatus('sentry')).toEqual({ configured: true })
  expect(JSON.stringify(getIntegrationStatus('sentry'))).not.toContain('SECRET_CANARY')
  if (process.platform !== 'win32')
    expect(fs.statSync(path.join(directory, 'integrations.json')).mode & 0o777).toBe(0o600)
})
it('does not corrupt the other integration when replacing or clearing a connection', () => {
  const entry = { command: 'node', args: ['server.js'], env: {} }
  saveIntegrationConfig('sentry', entry)
  saveIntegrationConfig('notion', entry)
  saveIntegrationConfig('sentry', null)
  expect(getIntegrationConfig('sentry')).toBeNull()
  expect(getIntegrationConfig('notion')).toEqual(entry)
})
it('rejects malformed configuration without logging or echoing values', () => {
  expect(() => saveIntegrationConfig('notion', { command: '', env: { SECRET: 'SECRET_CANARY' } })).toThrow(
    'Invalid integration configuration',
  )
  expect(getIntegrationConfig('notion')).toBeNull()
})
it('does not overwrite corrupt credential storage with a partial update', () => {
  fs.writeFileSync(path.join(directory, 'integrations.json'), '{broken')
  expect(() => saveIntegrationConfig('notion', { command: 'node', args: [], env: {} })).toThrow(
    'Cannot read integration configuration',
  )
  expect(fs.readFileSync(path.join(directory, 'integrations.json'), 'utf8')).toBe('{broken')
})

it('resolves direct Notion and Sentry configurations without a Claude account', () => {
  vi.stubEnv('HOME', directory)
  vi.stubEnv('NOTION_API_TOKEN', 'environment-token')
  vi.stubEnv('NOTION_MCP_COMMAND', undefined)
  vi.stubEnv('NOTION_MCP_ARGS', undefined)
  saveIntegrationConfig('notion', { command: 'node', args: ['notion.js'], env: { NOTION_TOKEN: 'stored-token' } })
  saveIntegrationConfig('sentry', {
    command: 'node',
    args: ['sentry.js'],
    env: { SENTRY_ACCESS_TOKEN: 'stored-token' },
  })
  const notion = buildNotionMcpConfig('missing-legacy-selection')
  expect(notion.command).toBe('node')
  expect(notion.env.OPENAPI_MCP_HEADERS).toContain('environment-token')
  expect(notion.env.NOTION_TOKEN).toBe('environment-token')
  expect(notion.env.NOTION_API_TOKEN).toBe('environment-token')
  expect(readSentryMcpConfig('missing-legacy-selection').args).toEqual(['sentry.js'])
})

it('preserves explicit headers while consistently applying the server token to token variables', () => {
  vi.stubEnv('NOTION_API_TOKEN', undefined)
  vi.stubEnv('NOTION_TOKEN', 'environment-token')
  saveIntegrationConfig('notion', {
    command: 'node',
    args: [],
    env: {
      NOTION_API_TOKEN: 'stored-token',
      OPENAPI_MCP_HEADERS: '{"custom":"header"}',
    },
  })
  const { env } = buildNotionMcpConfig()
  expect(env.NOTION_TOKEN).toBe('environment-token')
  expect(env.NOTION_API_TOKEN).toBe('environment-token')
  expect(env.OPENAPI_MCP_HEADERS).toBe('{"custom":"header"}')
})
