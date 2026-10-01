import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const disk = vi.hoisted(() => ({ failure: null as 'write' | 'rename' | null }))
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (disk.failure === 'write') {
        actual.writeFileSync(args[0], String(args[1]).slice(0, 20), args[2])
        throw new Error('Simulated disk-full write')
      }
      return actual.writeFileSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (disk.failure === 'rename') throw new Error('Simulated rename failure')
      return actual.renameSync(...args)
    },
  }
})

import promptRouter from '../server/routes/templates.js'
import presetRouter from '../server/routes/workspace-templates.js'
import { createTemplate, listTemplates, replaceAllTemplates } from '../server/services/templates-service.js'
import { createWorkspaceTemplate, listWorkspaceTemplates } from '../server/services/workspace-template-service.js'

let directory = ''
let previousHome: string | undefined
beforeEach(() => {
  previousHome = process.env.KOBO_HOME
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-template-persistence-'))
  process.env.KOBO_HOME = directory
  disk.failure = null
})
afterEach(() => {
  disk.failure = null
  process.env.KOBO_HOME = previousHome
  fs.rmSync(directory, { recursive: true, force: true })
})

const cases = [
  {
    name: 'prompt templates',
    file: 'templates.json',
    endpoint: '/api/templates',
    router: promptRouter,
    input: { slug: 'new', description: 'New prompt', content: 'New content' },
    create: () => createTemplate({ slug: 'new', description: 'New prompt', content: 'New content' }),
    seed: () => createTemplate({ slug: 'saved', description: 'Saved prompt', content: 'Preserve this content' }),
    list: listTemplates,
  },
  {
    name: 'workspace presets',
    file: 'workspace-templates.json',
    endpoint: '/api/workspace-templates',
    router: presetRouter,
    input: { name: 'New preset', preset: { description: 'New mission' } },
    create: () => createWorkspaceTemplate({ name: 'New preset', preset: { description: 'New mission' } }),
    seed: () => createWorkspaceTemplate({ name: 'Saved preset', preset: { description: 'Preserve this mission' } }),
    list: listWorkspaceTemplates,
  },
] as const

describe.each(cases)('$name persistence', (entry) => {
  it.each(['{ truncated', 'null', '{"version":1,"templates":null}', '{"templates":[null]}'])(
    'refuses damaged data (%s) without overwriting its bytes',
    (bytes) => {
      const file = path.join(directory, entry.file)
      fs.writeFileSync(file, bytes)
      expect(entry.list).toThrow(/Failed to read/)
      expect(entry.create).toThrow(/Failed to read/)
      expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
    },
  )

  it.each(['write', 'rename'] as const)('preserves the old file when the %s fails', (failure) => {
    entry.seed()
    const file = path.join(directory, entry.file)
    const previous = fs.readFileSync(file, 'utf8')
    disk.failure = failure
    expect(entry.create).toThrow(/Simulated/)
    expect(fs.readFileSync(file, 'utf8')).toBe(previous)
    disk.failure = null
    expect(entry.list().length).toBeGreaterThan(0)
    expect(fs.readdirSync(directory)).toEqual([entry.file])
  })

  it('surfaces damaged files through the existing HTTP routes', async () => {
    const bytes = '{ truncated'
    fs.writeFileSync(path.join(directory, entry.file), bytes)
    const app = new Hono().route(entry.endpoint, entry.router)
    const read = await app.request(entry.endpoint)
    expect(read.status).toBe(500)
    expect((await read.json()).error).toContain(entry.file)
    const create = await app.request(entry.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry.input),
    })
    expect(create.status).toBe(500)
    expect(fs.readFileSync(path.join(directory, entry.file), 'utf8')).toBe(bytes)
  })
})

it('allows explicit prompt-template replacement while backing up damaged bytes', () => {
  const file = path.join(directory, 'templates.json')
  fs.writeFileSync(file, '{ recoverable damaged bytes')
  replaceAllTemplates([{ slug: 'restored', description: 'Recovered', content: 'Imported content' }])
  expect(listTemplates().map((template) => template.slug)).toEqual(['restored'])
  const backup = fs.readdirSync(directory).find((name) => name.startsWith('templates.json.recovery-'))
  expect(backup).toBeDefined()
  expect(fs.readFileSync(path.join(directory, backup!), 'utf8')).toBe('{ recoverable damaged bytes')
})
