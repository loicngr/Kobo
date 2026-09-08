import { describe, expect, it } from 'vitest'
import { applyPreset, capturePreset, type PresetFormState } from '../utils/workspace-preset'

const form: PresetFormState = {
  projectPath: '/tmp/p',
  sourceBranch: 'develop',
  branchType: 'feature',
  engine: 'claude-code',
  model: 'opus',
  reasoningEffort: 'medium',
  agentPermissionMode: 'bypass',
  autoLoop: true,
  autoLoopSessionMode: 'per_task',
  brainstormModel: 'sonnet',
  brainstormReasoningEffort: 'auto',
  skipSetupScript: false,
  description: 'Do the thing',
  tasks: ['a', 'b'],
  acceptanceCriteria: ['c'],
}

describe('capturePreset', () => {
  it('captures every field of the form, and nothing the form does not know', () => {
    expect(capturePreset(form)).toEqual(form)
  })

  it('drops blank strings and empty lists, so an untouched field is not saved as ""', () => {
    const preset = capturePreset({ ...form, sourceBranch: '', description: '   ', tasks: [], acceptanceCriteria: [] })
    expect(preset).not.toHaveProperty('sourceBranch')
    expect(preset).not.toHaveProperty('description')
    expect(preset).not.toHaveProperty('tasks')
    expect(preset).not.toHaveProperty('acceptanceCriteria')
  })
})

describe('applyPreset', () => {
  it('changes only the keys the preset carries', () => {
    const next = applyPreset(form, { engine: 'codex', model: 'gpt' })
    expect(next).toEqual({ ...form, engine: 'codex', model: 'gpt' })
  })

  it('round-trips through capturePreset', () => {
    expect(applyPreset({ ...form, model: 'other', tasks: [] }, capturePreset(form))).toEqual(form)
  })

  it('copies lists rather than sharing them with the preset', () => {
    const preset = { tasks: ['x'] }
    const next = applyPreset(form, preset)
    next.tasks.push('y')
    expect(preset.tasks).toEqual(['x'])
  })

  it('never returns the same object', () => {
    expect(applyPreset(form, {})).not.toBe(form)
  })

  it('never shares the tasks array with the form, even when the preset is empty', () => {
    const next = applyPreset(form, {})
    expect(next.tasks).not.toBe(form.tasks)
    expect(next.acceptanceCriteria).not.toBe(form.acceptanceCriteria)
  })

  it('leaves the form field untouched when the preset carries a blank string', () => {
    const next = applyPreset(form, { sourceBranch: '   ' })
    expect(next.sourceBranch).toBe(form.sourceBranch)
  })
})
