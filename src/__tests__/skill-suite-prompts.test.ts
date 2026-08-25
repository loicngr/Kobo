import { describe, expect, it } from 'vitest'
import {
  AGNOSTIC_PROMPTS,
  ALL_THREE_PROMPTS,
  ECC_PROMPTS,
  GSTACK_PROMPTS,
  getSuitePrompts,
  SUPERPOWERS_PROMPTS,
} from '../server/services/skill-suite-prompts.js'
import { getGroomingIntro } from '../shared/skill-suite-prompts.js'

describe('skill-suite-prompts', () => {
  it('every constant has all 5 fields populated', () => {
    for (const c of [SUPERPOWERS_PROMPTS, GSTACK_PROMPTS, ECC_PROMPTS, ALL_THREE_PROMPTS, AGNOSTIC_PROMPTS]) {
      expect(c.reviewTemplate).toBeTruthy()
      expect(c.autoLoopReviewGate).toBeTruthy()
      expect(c.autoLoopGroomingIntro).toBeTruthy()
      expect(c.qaPromptTemplate).toBeTruthy()
      expect(c.brainstormingInstruction).toBeTruthy()
    }
  })

  it('superpowers and gstack are not the same set', () => {
    expect(SUPERPOWERS_PROMPTS.reviewTemplate).not.toBe(GSTACK_PROMPTS.reviewTemplate)
    expect(SUPERPOWERS_PROMPTS.autoLoopReviewGate).not.toBe(GSTACK_PROMPTS.autoLoopReviewGate)
    expect(SUPERPOWERS_PROMPTS.autoLoopGroomingIntro).not.toBe(GSTACK_PROMPTS.autoLoopGroomingIntro)
    expect(SUPERPOWERS_PROMPTS.qaPromptTemplate).not.toBe(GSTACK_PROMPTS.qaPromptTemplate)
    expect(SUPERPOWERS_PROMPTS.brainstormingInstruction).not.toBe(GSTACK_PROMPTS.brainstormingInstruction)
  })

  it('agnostic prompts mention no specific suite by name', () => {
    for (const v of Object.values(AGNOSTIC_PROMPTS)) {
      expect(v).not.toMatch(/superpowers:/i)
      expect(v).not.toMatch(/ecc:/i)
      expect(v).not.toMatch(/\/review\b|\/ship\b|\/qa\b|\/office-hours\b|\/autoplan\b|\/land-and-deploy\b/)
    }
  })

  it('superpowers prompts mention superpowers', () => {
    expect(SUPERPOWERS_PROMPTS.reviewTemplate).toMatch(/superpowers:/)
    expect(SUPERPOWERS_PROMPTS.autoLoopReviewGate).toMatch(/superpowers:/)
    expect(SUPERPOWERS_PROMPTS.autoLoopGroomingIntro).toMatch(/superpowers:executing-plans/)
  })

  it('gstack prompts mention gstack slash commands', () => {
    expect(GSTACK_PROMPTS.reviewTemplate).toMatch(/\/review/)
    expect(GSTACK_PROMPTS.autoLoopReviewGate).toMatch(/\/review/)
    expect(GSTACK_PROMPTS.autoLoopGroomingIntro).toMatch(/\/ship|\/autoplan/)
    expect(GSTACK_PROMPTS.qaPromptTemplate).toMatch(/\/qa/)
  })

  it('ecc prompts mention ecc skills/agents', () => {
    expect(ECC_PROMPTS.reviewTemplate).toMatch(/ecc:/)
    expect(ECC_PROMPTS.autoLoopReviewGate).toMatch(/ecc:/)
    expect(ECC_PROMPTS.autoLoopGroomingIntro).toMatch(/ecc:/)
    expect(ECC_PROMPTS.qaPromptTemplate).toMatch(/ecc:/)
    expect(ECC_PROMPTS.brainstormingInstruction).toMatch(/ecc:/)
  })

  it('getSuitePrompts returns the right baked-in set for superpowers, gstack, ecc, and the triple combo', () => {
    expect(getSuitePrompts('superpowers', {})).toEqual(SUPERPOWERS_PROMPTS)
    expect(getSuitePrompts('gstack', {})).toEqual(GSTACK_PROMPTS)
    expect(getSuitePrompts('ecc', {})).toEqual(ECC_PROMPTS)
    expect(getSuitePrompts('superpowers+gstack+ecc', {})).toEqual(ALL_THREE_PROMPTS)
  })

  it('all-three prompts mention superpowers, gstack, and ecc', () => {
    for (const v of Object.values(ALL_THREE_PROMPTS)) {
      expect(v).toMatch(/ecc:/)
    }
    expect(ALL_THREE_PROMPTS.reviewTemplate).toMatch(/superpowers:/)
    expect(ALL_THREE_PROMPTS.reviewTemplate).toMatch(/\/review\b/)
  })

  it('getSuitePrompts in custom mode falls back to AGNOSTIC for missing overrides', () => {
    expect(getSuitePrompts('custom', {})).toEqual(AGNOSTIC_PROMPTS)
  })

  it('getSuitePrompts in custom mode honours per-field overrides', () => {
    const result = getSuitePrompts('custom', { reviewTemplate: 'CUSTOM_REVIEW' })
    expect(result.reviewTemplate).toBe('CUSTOM_REVIEW')
    expect(result.qaPromptTemplate).toBe(AGNOSTIC_PROMPTS.qaPromptTemplate)
  })

  it('getSuitePrompts ignores empty-string overrides in custom mode', () => {
    const result = getSuitePrompts('custom', { reviewTemplate: '' })
    expect(result.reviewTemplate).toBe(AGNOSTIC_PROMPTS.reviewTemplate)
  })

  it('getSuitePrompts ignores whitespace-only overrides in custom mode', () => {
    const result = getSuitePrompts('custom', { reviewTemplate: '   \n  ' })
    expect(result.reviewTemplate).toBe(AGNOSTIC_PROMPTS.reviewTemplate)
  })

  describe('getGroomingIntro', () => {
    it('resolves ecc and the triple combo to distinct, ecc-aware intros', () => {
      const eccIntro = getGroomingIntro('ecc')
      const tripleIntro = getGroomingIntro('superpowers+gstack+ecc')
      const superpowersIntro = getGroomingIntro('superpowers')
      const combinedIntro = getGroomingIntro('superpowers+gstack')

      expect(eccIntro).toMatch(/ecc:/)
      expect(tripleIntro).toMatch(/ecc:/)
      expect(tripleIntro).not.toBe(combinedIntro)
      expect(eccIntro).not.toBe(superpowersIntro)
    })
  })
})
