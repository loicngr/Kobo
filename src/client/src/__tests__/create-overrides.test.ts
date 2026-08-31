import { describe, expect, it } from 'vitest'
import { resolveCreateOverrides } from '../utils/create-overrides'

describe('resolveCreateOverrides', () => {
  it('leaves the user choices untouched when nothing forces an override', () => {
    expect(
      resolveCreateOverrides({
        useExistingWorktree: false,
        skipSetupScript: false,
        autoLoop: false,
        agentPermissionMode: 'plan',
      }),
    ).toEqual({ skipSetupScript: false, agentPermissionMode: 'plan', applied: [] })
  })

  it('forces skipSetupScript when reusing an existing worktree, and says so', () => {
    const resolved = resolveCreateOverrides({
      useExistingWorktree: true,
      skipSetupScript: false,
      autoLoop: false,
      agentPermissionMode: 'bypass',
    })
    expect(resolved.skipSetupScript).toBe(true)
    expect(resolved.applied).toContain('setup-script-forced')
  })

  it('downgrades plan to bypass under auto-loop, and says so', () => {
    const resolved = resolveCreateOverrides({
      useExistingWorktree: false,
      skipSetupScript: false,
      autoLoop: true,
      agentPermissionMode: 'plan',
    })
    expect(resolved.agentPermissionMode).toBe('bypass')
    expect(resolved.applied).toContain('permission-mode-downgraded')
  })

  it('does not claim a downgrade when auto-loop runs on a non-plan mode', () => {
    const resolved = resolveCreateOverrides({
      useExistingWorktree: false,
      skipSetupScript: false,
      autoLoop: true,
      agentPermissionMode: 'strict',
    })
    expect(resolved.agentPermissionMode).toBe('strict')
    expect(resolved.applied).toEqual([])
  })

  it('does not claim a forced skip when the user asked for it themselves', () => {
    const resolved = resolveCreateOverrides({
      useExistingWorktree: false,
      skipSetupScript: true,
      autoLoop: false,
      agentPermissionMode: 'bypass',
    })
    expect(resolved.skipSetupScript).toBe(true)
    expect(resolved.applied).toEqual([])
  })

  it('applies both overrides at once when reusing a worktree and auto-looping on plan', () => {
    const resolved = resolveCreateOverrides({
      useExistingWorktree: true,
      skipSetupScript: false,
      autoLoop: true,
      agentPermissionMode: 'plan',
    })
    expect(resolved.skipSetupScript).toBe(true)
    expect(resolved.agentPermissionMode).toBe('bypass')
    expect(resolved.applied).toEqual(expect.arrayContaining(['setup-script-forced', 'permission-mode-downgraded']))
    expect(resolved.applied).toHaveLength(2)
  })
})
