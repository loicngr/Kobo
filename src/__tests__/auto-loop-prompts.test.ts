import { describe, expect, it } from 'vitest'
import {
  AUTO_LOOP_GROOMING_STEPS,
  buildAutoLoopGroomingSteps,
  buildE2eIterationBlock,
  buildFinalizationIterationBlock,
} from '../shared/auto-loop-prompts.js'

describe('buildAutoLoopGroomingSteps(e2e, finalization)', () => {
  it('produces the legacy 4-step output when both framework and finalization are empty', () => {
    const out = buildAutoLoopGroomingSteps({ framework: '', skill: '', prompt: '' }, { prompt: '' })
    expect(out).toBe(AUTO_LOOP_GROOMING_STEPS)
    expect(out).toContain('1. Call `kobo__list_tasks`')
    expect(out).toContain('4. Call `kobo__mark_auto_loop_ready`')
    expect(out).not.toContain('E2E review')
    expect(out).not.toContain('Finalization task')
    // Sentinel: no '5.' numbering — required because the workspace creation
    // handler appends an unnumbered "[BRAINSTORM_COMPLETE]" directive after
    // this output, and the previous design collided with a hardcoded "5.".
    expect(out).not.toMatch(/^5\./m)
  })

  it('inserts the E2E review step at position 4 and renumbers mark_auto_loop_ready to 5 when framework is set', () => {
    const out = buildAutoLoopGroomingSteps({ framework: 'cypress', skill: '', prompt: '' }, { prompt: '' })
    expect(out).toContain('4. **E2E review**')
    expect(out).toContain('5. Call `kobo__mark_auto_loop_ready`')
    expect(out).toContain('The project uses `cypress`.')
  })

  it('mentions the configured skill in the E2E step', () => {
    const out = buildAutoLoopGroomingSteps(
      { framework: 'cypress', skill: 'cypress-tester', prompt: '' },
      { prompt: '' },
    )
    expect(out).toContain('Use the `cypress-tester` skill for this task.')
  })

  it('mentions the configured prompt in the E2E step', () => {
    const out = buildAutoLoopGroomingSteps(
      { framework: 'cypress', skill: '', prompt: 'use page-object pattern' },
      { prompt: '' },
    )
    expect(out).toContain('Additional guidance: use page-object pattern')
  })

  it('combines skill + prompt when both are set', () => {
    const out = buildAutoLoopGroomingSteps(
      { framework: 'playwright', skill: 'pw-skill', prompt: 'extra' },
      { prompt: '' },
    )
    expect(out).toContain('Use the `pw-skill` skill for this task.')
    expect(out).toContain('Additional guidance: extra')
  })

  it('uses the literal "other" framework name', () => {
    const out = buildAutoLoopGroomingSteps({ framework: 'other', skill: 'wdio', prompt: '' }, { prompt: '' })
    expect(out).toContain('The project uses `other`.')
    expect(out).toContain('Use the `wdio` skill for this task.')
  })

  it('inserts the finalization step at position 4 when only finalization is set', () => {
    const out = buildAutoLoopGroomingSteps(
      { framework: '', skill: '', prompt: '' },
      { prompt: 'Run quality checks at the end.' },
    )
    expect(out).toContain('4. **Finalization task**:')
    expect(out).toContain('5. Call `kobo__mark_auto_loop_ready`')
    expect(out).not.toContain('E2E review')
  })

  it('inserts the finalization step at position 5 (after E2E) and renumbers mark_auto_loop_ready to 6', () => {
    const out = buildAutoLoopGroomingSteps(
      { framework: 'cypress', skill: '', prompt: '' },
      { prompt: 'Run quality checks at the end.' },
    )
    expect(out).toContain('4. **E2E review**')
    expect(out).toContain('5. **Finalization task**:')
    expect(out).toContain('6. Call `kobo__mark_auto_loop_ready`')
  })

  it('omits the finalization step when finalization.prompt is empty', () => {
    const out = buildAutoLoopGroomingSteps({ framework: 'cypress', skill: '', prompt: '' }, { prompt: '' })
    expect(out).not.toContain('Finalization task')
    expect(out).toContain('5. Call `kobo__mark_auto_loop_ready`')
  })
})

describe('buildE2eIterationBlock(e2e)', () => {
  it('returns empty string when framework is empty', () => {
    expect(buildE2eIterationBlock({ framework: '', skill: '', prompt: '' })).toBe('')
  })

  it('returns the override block with framework, skill, and prompt when configured', () => {
    const out = buildE2eIterationBlock({ framework: 'cypress', skill: 'cy', prompt: 'pop' })
    expect(out).toContain('This is an **E2E regression test** task.')
    expect(out).toContain('Project E2E framework: cypress')
    expect(out).toContain('Use the `cy` skill for this task.')
    expect(out).toContain('Additional guidance: pop')
    expect(out).toContain('Override of step 4 of the standard prompt below')
  })

  it('omits skill / prompt lines when not configured', () => {
    const out = buildE2eIterationBlock({ framework: 'playwright', skill: '', prompt: '' })
    expect(out).toContain('Project E2E framework: playwright')
    expect(out).not.toContain('Use the `')
    expect(out).not.toContain('Additional guidance:')
  })
})

describe('buildFinalizationIterationBlock(finalization)', () => {
  it('returns empty string when prompt is empty', () => {
    expect(buildFinalizationIterationBlock({ prompt: '' })).toBe('')
  })

  it('returns the user prompt verbatim when set', () => {
    const out = buildFinalizationIterationBlock({ prompt: 'Run lint and tests.' })
    expect(out).toContain('Run lint and tests.')
    expect(out).toContain('finalization task')
  })
})
