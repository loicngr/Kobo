import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { UsageBucket, UsageProvider, UsageSnapshot } from '../types.js'

const API_URL = 'https://api.anthropic.com/api/oauth/usage'
const BETA_HEADER = 'oauth-2025-04-20'
const FETCH_TIMEOUT_MS = 10_000

interface ClaudeAiOauthCreds {
  claudeAiOauth?: { accessToken?: unknown }
}

interface UsageBucketResponse {
  utilization?: unknown
  resets_at?: unknown
}

interface UsageApiResponse {
  five_hour?: UsageBucketResponse
  seven_day?: UsageBucketResponse
}

function credentialsFilePath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
  return path.join(dir, '.credentials.json')
}

async function readAccessToken(): Promise<string | null> {
  try {
    const raw = await fs.readFile(credentialsFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as ClaudeAiOauthCreds
    const token = parsed?.claudeAiOauth?.accessToken
    return typeof token === 'string' && token.length > 0 ? token : null
  } catch {
    return null
  }
}

function mapBucket(id: 'five_hour' | 'seven_day', raw: UsageBucketResponse | undefined): UsageBucket {
  const utilization = typeof raw?.utilization === 'number' ? raw.utilization : 0
  const resetsAt = typeof raw?.resets_at === 'string' ? raw.resets_at : undefined
  return {
    id,
    label: id,
    usedPct: utilization,
    resetsAt,
  }
}

export function createClaudeCodeProvider(): UsageProvider {
  return {
    id: 'claude-code',
    displayName: 'Claude Code',

    async isAvailable(): Promise<boolean> {
      return (await readAccessToken()) !== null
    },

    async fetchSnapshot(): Promise<UsageSnapshot> {
      const fetchedAt = new Date().toISOString()
      const token = await readAccessToken()

      if (!token) {
        return {
          providerId: 'claude-code',
          status: 'unauthenticated',
          buckets: [],
          fetchedAt,
        }
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

      try {
        const res = await fetch(API_URL, {
          headers: {
            Authorization: `Bearer ${token}`,
            'anthropic-beta': BETA_HEADER,
          },
          signal: controller.signal,
        })

        if (!res.ok) {
          return {
            providerId: 'claude-code',
            status: 'error',
            errorMessage: `HTTP ${res.status}`,
            buckets: [],
            fetchedAt,
          }
        }

        const body = (await res.json()) as UsageApiResponse
        const buckets: UsageBucket[] = [mapBucket('five_hour', body.five_hour), mapBucket('seven_day', body.seven_day)]
        return {
          providerId: 'claude-code',
          status: 'ok',
          buckets,
          fetchedAt,
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        return {
          providerId: 'claude-code',
          status: 'error',
          errorMessage,
          buckets: [],
          fetchedAt,
        }
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
