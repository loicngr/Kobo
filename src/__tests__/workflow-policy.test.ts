import { describe, expect, it } from 'vitest'
import {
  isWorkflowPolicy,
  MANUAL_WORKFLOW_POLICY,
  renderWorkflowPolicy,
  resolveWorkflowPolicy,
} from '../shared/workflow-policy.js'

describe('workflow policy', () => {
  it('resolves independent actions with workspace then project then global precedence', () => {
    expect(resolveWorkflowPolicy({ commit: 'automatic' }, { push: 'automatic' }, { commit: 'manual' })).toEqual({
      commit: 'manual',
      push: 'automatic',
      publish: 'manual',
    })
    expect(resolveWorkflowPolicy()).toEqual(MANUAL_WORKFLOW_POLICY)
    expect(isWorkflowPolicy({ commit: 'yes' })).toBe(false)
    expect(isWorkflowPolicy({ publish: 'automatic' })).toBe(true)
    expect(isWorkflowPolicy({ merge: 'automatic' })).toBe(false)
  })
  it('keeps preferences subordinate to user constraints and OS permissions', () => {
    const prompt = renderWorkflowPolicy({ commit: 'automatic', push: 'manual', publish: 'automatic' })
    expect(prompt).toContain('push: manual')
    expect(prompt).toContain('Never merge')
    expect(prompt).toContain('more restrictive')
    expect(prompt).toContain('not an OS sandbox')
  })
})
