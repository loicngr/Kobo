import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/agent/orchestrator.js', () => ({ getBackendPort: () => 3300 }))

import settingsRouter from '../server/routes/settings.js'
import { _setSettingsPath, getSettings } from '../server/services/settings-service.js'
import { createTemplate, listTemplates } from '../server/services/templates-service.js'

let directory = ''
let previousHome: string | undefined
beforeEach(() => {
  previousHome = process.env.KOBO_HOME
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-settings-import-'))
  process.env.KOBO_HOME = directory
  _setSettingsPath(path.join(directory, 'settings.json'))
})
afterEach(() => {
  process.env.KOBO_HOME = previousHome
  fs.rmSync(directory, { recursive: true, force: true })
})

const app = new Hono().route('/api/settings', settingsRouter)
function importRequest(templates?: unknown) {
  const current = getSettings()
  return app.request('/api/settings/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bundleVersion: 1,
      settings: { ...current, global: { ...current.global, editorCommand: 'imported-editor' } },
      ...(templates === undefined ? {} : { templates }),
    }),
  })
}

describe('configuration import persistence', () => {
  it.each([
    { templates: 'not-an-array' },
    { templates: [{ slug: 'UPPERCASE', description: 'Invalid slug', content: 'Text' }] },
    {
      templates: [
        { slug: 'duplicate', description: 'First', content: 'Text' },
        { slug: 'duplicate', description: 'Second', content: 'Text' },
      ],
    },
  ])('rejects invalid templates before changing either settings or templates ($templates)', async ({ templates }) => {
    getSettings()
    createTemplate({ slug: 'saved', description: 'Saved prompt', content: 'Preserve this' })
    const settingsFile = path.join(directory, 'settings.json')
    const templatesFile = path.join(directory, 'templates.json')
    const settingsBefore = fs.readFileSync(settingsFile, 'utf8')
    const templatesBefore = fs.readFileSync(templatesFile, 'utf8')
    const result = await importRequest(templates)
    expect(result.status).toBe(400)
    expect((await result.json()).error).toMatch(/template|slug/i)
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(settingsBefore)
    expect(fs.readFileSync(templatesFile, 'utf8')).toBe(templatesBefore)
  })

  it('restores valid imported templates while retaining a damaged file backup', async () => {
    getSettings()
    const damaged = '{ damaged template data'
    fs.writeFileSync(path.join(directory, 'templates.json'), damaged)
    const result = await importRequest([{ slug: 'imported', description: 'Recovered', content: 'Imported prompt' }])
    expect(result.status).toBe(200)
    expect(getSettings().global.editorCommand).toBe('imported-editor')
    expect(listTemplates().map((template) => template.slug)).toEqual(['imported'])
    const backup = fs.readdirSync(directory).find((name) => name.startsWith('templates.json.recovery-'))
    expect(backup).toBeDefined()
    expect(fs.readFileSync(path.join(directory, backup!), 'utf8')).toBe(damaged)
  })

  it('keeps the existing templates when importing an older bundle without them', async () => {
    getSettings()
    createTemplate({ slug: 'saved', description: 'Saved prompt', content: 'Preserve this' })
    const before = fs.readFileSync(path.join(directory, 'templates.json'), 'utf8')
    const result = await importRequest()
    expect(result.status).toBe(200)
    expect(getSettings().global.editorCommand).toBe('imported-editor')
    expect(fs.readFileSync(path.join(directory, 'templates.json'), 'utf8')).toBe(before)
  })
})
