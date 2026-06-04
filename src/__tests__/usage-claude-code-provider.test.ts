import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createClaudeCodeProvider } from '../server/services/usage/providers/claude-code.js'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

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

  // macOS keeps the Claude Code OAuth token in the login Keychain, not in
  // ~/.claude/.credentials.json (the beforeEach tmp dir has no creds file).
  describe('macOS Keychain fallback', () => {
    const KEYCHAIN_JSON = JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-tok' } })
    const originalPlatform = process.platform

    function setPlatform(p: NodeJS.Platform): void {
      Object.defineProperty(process, 'platform', { value: p, configurable: true })
    }

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      vi.mocked(execFile).mockReset()
    })

    it('reads the token from the Keychain when the file is absent (darwin)', async () => {
      setPlatform('darwin')
      vi.mocked(execFile).mockImplementation(((
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (e: Error | null, stdout: string) => void,
      ) => {
        cb(null, KEYCHAIN_JSON)
        return {} as never
      }) as never)
      const p = createClaudeCodeProvider()
      expect(await p.isAvailable()).toBe(true)
      expect(execFile).toHaveBeenCalledWith(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        expect.objectContaining({ timeout: expect.any(Number) }),
        expect.any(Function),
      )
    })

    it('returns false when the Keychain lookup fails (graceful — locked / SSH / absent)', async () => {
      setPlatform('darwin')
      vi.mocked(execFile).mockImplementation(((
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (e: Error | null, stdout: string) => void,
      ) => {
        cb(new Error('SecKeychainSearchCopyNext: item not found'), '')
        return {} as never
      }) as never)
      const p = createClaudeCodeProvider()
      expect(await p.isAvailable()).toBe(false)
    })

    it('does not consult the Keychain on non-darwin platforms', async () => {
      setPlatform('linux')
      const p = createClaudeCodeProvider()
      expect(await p.isAvailable()).toBe(false)
      expect(execFile).not.toHaveBeenCalled()
    })
  })
})
