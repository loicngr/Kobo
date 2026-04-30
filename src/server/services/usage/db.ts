import { getDb } from '../../db/index.js'
import type { ProviderId, UsageBucket, UsageSnapshot } from './types.js'

interface UsageSnapshotRow {
  provider_id: string
  status: string
  error_message: string | null
  buckets_json: string
  fetched_at: string
}

function rowToSnapshot(row: UsageSnapshotRow): UsageSnapshot {
  const buckets = JSON.parse(row.buckets_json) as UsageBucket[]
  const snap: UsageSnapshot = {
    providerId: row.provider_id as ProviderId,
    status: row.status as UsageSnapshot['status'],
    buckets,
    fetchedAt: row.fetched_at,
  }
  if (row.error_message !== null) {
    snap.errorMessage = row.error_message
  }
  return snap
}

export function upsertUsageSnapshot(snap: UsageSnapshot): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO usage_snapshots (provider_id, status, error_message, buckets_json, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider_id) DO UPDATE SET
       status        = excluded.status,
       error_message = excluded.error_message,
       buckets_json  = excluded.buckets_json,
       fetched_at    = excluded.fetched_at`,
  ).run(snap.providerId, snap.status, snap.errorMessage ?? null, JSON.stringify(snap.buckets), snap.fetchedAt)
}

export function getAllPersistedSnapshots(): UsageSnapshot[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM usage_snapshots ORDER BY provider_id').all() as UsageSnapshotRow[]
  return rows.map(rowToSnapshot)
}
