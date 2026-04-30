import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createClaudeCodeProvider } from '../server/services/usage/providers/claude-code.js'

describe('claude-code usage provider', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kobo-claude-creds-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
  })

  afterEach(async () => {
    delete process.env.CLAUDE_CONFIG_DIR
    await fs.rm(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function writeCreds(content: unknown): Promise<void> {
    await fs.writeFile(path.join(tmpDir, '.credentials.json'), JSON.stringify(content))
  }

  it('isAvailable returns false when credentials file is missing', async () => {
    const p = createClaudeCodeProvider()
    expect(await p.isAvailable()).toBe(false)
  })

  it('isAvailable returns false when credentials file is malformed', async () => {
    await fs.writeFile(path.join(tmpDir, '.credentials.json'), '{ not json')
    const p = createClaudeCodeProvider()
    expect(await p.isAvailable()).toBe(false)
  })

  it('isAvailable returns false when accessToken is absent', async () => {
    await writeCreds({ claudeAiOauth: {} })
    const p = createClaudeCodeProvider()
    expect(await p.isAvailable()).toBe(false)
  })

  it('isAvailable returns true when accessToken is present', async () => {
    await writeCreds({ claudeAiOauth: { accessToken: 'tok' } })
    const p = createClaudeCodeProvider()
    expect(await p.isAvailable()).toBe(true)
  })

  it('fetchSnapshot returns unauthenticated snapshot when credentials missing', async () => {
    const p = createClaudeCodeProvider()
    const snap = await p.fetchSnapshot()
    expect(snap.status).toBe('unauthenticated')
    expect(snap.providerId).toBe('claude-code')
    expect(snap.buckets).toEqual([])
    expect(snap.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('fetchSnapshot returns ok snapshot mapping the API response', async () => {
    await writeCreds({ claudeAiOauth: { accessToken: 'tok' } })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 23.4, resets_at: '2026-04-29T18:00:00Z' },
          seven_day: { utilization: 67.2, resets_at: '2026-05-04T12:00:00Z' },
        }),
        { status: 200 },
      ),
    )
    const p = createClaudeCodeProvider()
    const snap = await p.fetchSnapshot()
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer tok',
          'anthropic-beta': 'oauth-2025-04-20',
        }),
      }),
    )
    expect(snap.status).toBe('ok')
    expect(snap.buckets).toEqual([
      { id: 'five_hour', label: 'five_hour', usedPct: 23.4, resetsAt: '2026-04-29T18:00:00Z' },
      { id: 'seven_day', label: 'seven_day', usedPct: 67.2, resetsAt: '2026-05-04T12:00:00Z' },
    ])
  })

  it('fetchSnapshot returns error snapshot on non-200', async () => {
    await writeCreds({ claudeAiOauth: { accessToken: 'tok' } })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 401 }))
    const p = createClaudeCodeProvider()
    const snap = await p.fetchSnapshot()
    expect(snap.status).toBe('error')
    expect(snap.errorMessage).toContain('401')
    expect(snap.buckets).toEqual([])
  })

  it('fetchSnapshot returns error snapshot on network failure', async () => {
    await writeCreds({ claudeAiOauth: { accessToken: 'tok' } })
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const p = createClaudeCodeProvider()
    const snap = await p.fetchSnapshot()
    expect(snap.status).toBe('error')
    expect(snap.errorMessage).toBe('ECONNREFUSED')
  })
})
