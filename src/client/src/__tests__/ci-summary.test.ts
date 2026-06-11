import { describe, expect, it } from 'vitest'
import { type CiCheck, summarizeCiChecks } from '../utils/ci-summary'

function check(name: string, status: string, conclusion: string | null): CiCheck {
  return { name, status, conclusion, detailsUrl: null }
}

describe('summarizeCiChecks', () => {
  it('groups checks by outcome (pending / failed / passed / skipped)', () => {
    const { failed, pending, passed, skipped } = summarizeCiChecks([
      check('build', 'IN_PROGRESS', null),
      check('queued-job', 'QUEUED', null),
      check('unit', 'COMPLETED', 'SUCCESS'),
      check('lint', 'COMPLETED', 'FAILURE'),
      check('cancelled-job', 'COMPLETED', 'CANCELLED'),
      check('timeout-job', 'COMPLETED', 'TIMED_OUT'),
      check('optional', 'COMPLETED', 'SKIPPED'),
      check('neutral-job', 'COMPLETED', 'NEUTRAL'),
    ])
    expect(pending.map((c) => c.name)).toEqual(['build', 'queued-job'])
    expect(failed.map((c) => c.name)).toEqual(['cancelled-job', 'lint', 'timeout-job'])
    expect(passed.map((c) => c.name)).toEqual(['unit'])
    expect(skipped.map((c) => c.name)).toEqual(['neutral-job', 'optional'])
  })

  it('sorts each group by name for stable rendering', () => {
    const { pending } = summarizeCiChecks([check('zeta', 'IN_PROGRESS', null), check('alpha', 'IN_PROGRESS', null)])
    expect(pending.map((c) => c.name)).toEqual(['alpha', 'zeta'])
  })

  it('returns empty groups for no checks', () => {
    expect(summarizeCiChecks([])).toEqual({ failed: [], pending: [], passed: [], skipped: [] })
  })
})
