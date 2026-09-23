import type { PrSnapshot } from 'src/stores/workspace'

export type CiCheck = PrSnapshot['ci']['checks'][number]

export interface CiSummary {
  failed: CiCheck[]
  pending: CiCheck[]
  passed: CiCheck[]
  skipped: CiCheck[]
}

/**
 * Group a PR's CI checks by outcome, mirroring GitHub's status rollup:
 * - not COMPLETED            → pending (still running / queued)
 * - FAILURE/CANCELLED/TIMED_OUT → failed
 * - SUCCESS                  → passed
 * - SKIPPED/NEUTRAL/unknown  → skipped
 * Each group is sorted by name for stable rendering. Pure — shared by the PR
 * panel and the compact workspace-card CI recap.
 */
export function summarizeCiChecks(checks: CiCheck[]): CiSummary {
  const failed: CiCheck[] = []
  const pending: CiCheck[] = []
  const passed: CiCheck[] = []
  const skipped: CiCheck[] = []
  for (const c of checks) {
    if (c.status !== 'COMPLETED') {
      pending.push(c)
      continue
    }
    if (c.conclusion === 'FAILURE' || c.conclusion === 'CANCELLED' || c.conclusion === 'TIMED_OUT') {
      failed.push(c)
    } else if (c.conclusion === 'SUCCESS') {
      passed.push(c)
    } else {
      skipped.push(c)
    }
  }
  const byName = (a: CiCheck, b: CiCheck) => a.name.localeCompare(b.name)
  failed.sort(byName)
  pending.sort(byName)
  passed.sort(byName)
  skipped.sort(byName)
  return { failed, pending, passed, skipped }
}
