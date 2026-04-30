import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the path helper so tests use a tmpdir file instead of ~/.config/kobo
let tmpFile = ''
vi.mock('../server/utils/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../server/utils/paths.js')>('../server/utils/paths.js')
  return {
    ...actual,
    getTemplatesPath: () => tmpFile,
  }
})

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-templates-test-'))
  tmpFile = path.join(tmpDir, 'templates.json')
  vi.clearAllMocks()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('templates-service', () => {
  describe('listTemplates()', () => {
    it('seeds 10 default templates on first read when file does not exist', async () => {
      const { listTemplates } = await import('../server/services/templates-service.js')
      const templates = listTemplates()
      expect(templates.length).toBe(10)
      expect(templates.map((t) => t.slug).sort()).toEqual(
        [
          'add-tests',
          'ci-status',
          'explain',
          'mark-done',
          'plan-tasks',
          'pr-review-comments',
          'refactor',
          'review-quality',
          'show-tasks',
          'sync-tasks',
        ].sort(),
      )
      expect(fs.existsSync(tmpFile)).toBe(true)
    })

    it('re-seeds if the file is deleted between calls', async () => {
      const { listTemplates } = await import('../server/services/templates-service.js')
      listTemplates()
      fs.unlinkSync(tmpFile)
      const templates = listTemplates()
      expect(templates.length).toBe(10)
    })

    it('does not re-seed when the file exists but is empty', async () => {
      fs.writeFileSync(tmpFile, JSON.stringify({ version: 1, templates: [] }), 'utf-8')
      const { listTemplates } = await import('../server/services/templates-service.js')
      const templates = listTemplates()
      expect(templates).toEqual([])
      // Verify the file wasn't overwritten by the seed — if re-seed ran the file
      // would now contain 8 templates, not the empty array we wrote.
      const afterRead = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'))
      expect(afterRead.templates).toEqual([])
    })

    it('returns empty array on corrupted JSON', async () => {
      fs.writeFileSync(tmpFile, 'not json at all', 'utf-8')
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { listTemplates } = await import('../server/services/templates-service.js')
      const templates = listTemplates()
      expect(templates).toEqual([])
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })

    it('warns on version mismatch but continues best-effort', async () => {
      fs.writeFileSync(
        tmpFile,
        JSON.stringify({
          version: 999,
          templates: [{ slug: 'x', description: 'd', content: 'c', createdAt: '2026-04-10', updatedAt: '2026-04-10' }],
        }),
        'utf-8',
      )
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { listTemplates } = await import('../server/services/templates-service.js')
      const templates = listTemplates()
      expect(templates.length).toBe(1)
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })
  })

  describe('createTemplate()', () => {
    it('creates a template and persists it', async () => {
      const { createTemplate, listTemplates } = await import('../server/services/templates-service.js')
      listTemplates() // trigger seed so we have the baseline
      const created = createTemplate({ slug: 'my-template', description: 'Mine', content: 'Hello {workspace_name}' })
      expect(created.slug).toBe('my-template')
      expect(created.createdAt).toBeTruthy()
      expect(created.updatedAt).toBe(created.createdAt)
      const all = listTemplates()
      expect(all.some((t) => t.slug === 'my-template')).toBe(true)
    })

    it('throws on invalid slug (uppercase)', async () => {
      const { createTemplate, listTemplates } = await import('../server/services/templates-service.js')
      listTemplates()
      expect(() => createTemplate({ slug: 'MyTemplate', description: 'd', content: 'c' })).toThrow(/slug/i)
    })

    it('throws on invalid slug (spaces)', async () => {
      const { createTemplate, listTemplates } = await import('../server/services/templates-service.js')
      listTemplates()
      expect(() => createTemplate({ slug: 'my template', description: 'd', content: 'c' })).toThrow(/slug/i)
    })

    it('throws on invalid slug (too long)', async () => {
      const { createTemplate, listTemplates } = await import('../server/services/templates-service.js')
      listTemplates()
      expect(() => createTemplate({ slug: 'a'.repeat(65), description: 'd', content: 'c' })).toThrow(/slug/i)
    })

    it('throws on duplicate slug with "already exists" marker', async () => {
      const { createTemplate, listTemplates } = await import('../server/services/templates-service.js')
      listTemplates()
      createTemplate({ slug: 'dup', description: 'd', content: 'c' })
      expect(() => createTemplate({ slug: 'dup', description: 'd2', content: 'c2' })).toThrow(/already exists/)
    })

    it('throws on empty content', async () => {
      const { createTemplate, listTemplates } = await import('../server/services/templates-service.js')
      listTemplates()
      expect(() => createTemplate({ slug: 'empty', description: 'd', content: '   ' })).toThrow(/content/i)
    })

    it('throws on content exceeding 4096 chars', async () => {
      const { createTemplate, listTemplates } = await import('../server/services/templates-service.js')
      listTemplates()
      expect(() => createTemplate({ slug: 'big', description: 'd', content: 'a'.repeat(4097) })).toThrow(/content/i)
    })

    it('throws on empty description', async () => {
      const { createTemplate, listTemplates } = await import('../server/services/templates-service.js')
      listTemplates()
      expect(() => createTemplate({ slug: 'nodesc', description: '  ', content: 'c' })).toThrow(/description/i)
    })

    it('throws on description exceeding 120 chars', async () => {
      const { createTemplate, listTemplates } = await import('../server/services/templates-service.js')
      listTemplates()
      expect(() => createTemplate({ slug: 'longdesc', description: 'a'.repeat(121), content: 'c' })).toThrow(
        /description/i,
      )
    })
  })

  describe('updateTemplate()', () => {
    it('updates content and bumps updatedAt', async () => {
      const { createTemplate, updateTemplate, listTemplates } = await import('../server/services/templates-service.js')
      listTemplates()
      const created = createTemplate({ slug: 'upd', description: 'd', content: 'old' })
      // Wait to guarantee a different timestamp
      await new Promise((r) => setTimeout(r, 10))
      const updated = updateTemplate('upd', { content: 'new' })
      expect(updated).not.toBeNull()
      expect(updated!.content).toBe('new')
      expect(updated!.description).toBe('d')
      expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThan(new Date(created.createdAt).getTime())
    })

    it('updates description only', async () => {
      const { createTemplate, updateTemplate, listTemplates } = await import('../server/services/templates-service.js')
      listTemplates()
      createTemplate({ slug: 'upd2', description: 'old', content: 'c' })
      const updated = updateTemplate('upd2', { description: 'new' })
      expect(updated!.description).toBe('new')
      expect(updated!.content).toBe('c')
    })

    it('returns null for unknown slug', async () => {
      const { updateTemplate, listTemplates } = await import('../server/services/templates-service.js')
      listTemplates()
      expect(updateTemplate('does-not-exist', { content: 'x' })).toBeNull()
    })

    it('throws on invalid update (content too long)', async () => {
      const { createTemplate, updateTemplate, listTemplates } = await import('../server/services/templates-service.js')
      listTemplates()
      createTemplate({ slug: 'valid', description: 'd', content: 'c' })
      expect(() => updateTemplate('valid', { content: 'a'.repeat(4097) })).toThrow(/content/i)
    })
  })

  describe('deleteTemplate()', () => {
    it('deletes an existing template and returns true', async () => {
      const { createTemplate, deleteTemplate, listTemplates } = await import('../server/services/templates-service.js')
      listTemplates()
      createTemplate({ slug: 'del', description: 'd', content: 'c' })
      expect(deleteTemplate('del')).toBe(true)
      expect(listTemplates().some((t) => t.slug === 'del')).toBe(false)
    })

    it('returns false for unknown slug', async () => {
      const { deleteTemplate, listTemplates } = await import('../server/services/templates-service.js')
      listTemplates()
      expect(deleteTemplate('never-existed')).toBe(false)
    })

    it('does not re-seed after deleting the last user template (file stays with remaining seeds)', async () => {
      const { createTemplate, deleteTemplate, listTemplates } = await import('../server/services/templates-service.js')
      const initial = listTemplates()
      createTemplate({ slug: 'extra', description: 'd', content: 'c' })
      deleteTemplate('extra')
      const after = listTemplates()
      expect(after.length).toBe(initial.length)
    })
  })

  describe('replaceAllTemplates()', () => {
    it('accepts a valid array and replaces all templates atomically', async () => {
      const { replaceAllTemplates, listTemplates } = await import('../server/services/templates-service.js')
      replaceAllTemplates([
        { slug: 'hello', description: 'hi', content: 'content-a' },
        { slug: 'world', description: 'desc', content: 'content-b' },
      ])
      const after = listTemplates()
      expect(after).toHaveLength(2)
      expect(after.map((t) => t.slug).sort()).toEqual(['hello', 'world'])
    })

    it('rejects non-array payload', async () => {
      const { replaceAllTemplates } = await import('../server/services/templates-service.js')
      expect(() => replaceAllTemplates('not-an-array' as unknown as unknown[])).toThrow('expected an array')
    })

    it('rejects when an entry is not an object', async () => {
      const { replaceAllTemplates } = await import('../server/services/templates-service.js')
      expect(() => replaceAllTemplates(['not-an-object'])).toThrow('not an object')
    })

    it('rejects invalid slug (propagates validator error)', async () => {
      const { replaceAllTemplates } = await import('../server/services/templates-service.js')
      expect(() => replaceAllTemplates([{ slug: 'Invalid Slug With Spaces', description: 'x', content: 'y' }])).toThrow(
        'Invalid slug',
      )
    })

    it('rejects empty description', async () => {
      const { replaceAllTemplates } = await import('../server/services/templates-service.js')
      expect(() => replaceAllTemplates([{ slug: 'ok', description: '', content: 'y' }])).toThrow('Invalid description')
    })

    it('rejects duplicate slugs', async () => {
      const { replaceAllTemplates } = await import('../server/services/templates-service.js')
      expect(() =>
        replaceAllTemplates([
          { slug: 'dup', description: 'd', content: 'c' },
          { slug: 'dup', description: 'd2', content: 'c2' },
        ]),
      ).toThrow('Duplicate')
    })

    it('does not touch the file when validation fails mid-array', async () => {
      const { replaceAllTemplates, listTemplates, createTemplate } = await import(
        '../server/services/templates-service.js'
      )
      // Seed a known state
      createTemplate({ slug: 'existing', description: 'd', content: 'c' })
      const before = listTemplates()
      // The first entry is valid, but the second is not — the whole write must reject.
      expect(() =>
        replaceAllTemplates([
          { slug: 'ok', description: 'valid', content: 'valid' },
          { slug: 'bad slug', description: 'd', content: 'c' },
        ]),
      ).toThrow('Invalid slug')
      const after = listTemplates()
      expect(after).toEqual(before)
    })
  })
})
