import { beforeEach, describe, expect, it } from 'vitest'
import {
  _clearUnsavedScopesForTest,
  hasUnsavedWork,
  listDirtyScopes,
  registerUnsavedScope,
  unregisterUnsavedScope,
} from '../utils/unsaved-guard'

describe('unsaved-guard registry', () => {
  beforeEach(() => _clearUnsavedScopesForTest())

  it('reports nothing when no scope is registered', () => {
    expect(hasUnsavedWork()).toBe(false)
    expect(listDirtyScopes()).toEqual([])
  })

  it('reports a scope only while its predicate says dirty', () => {
    let dirty = false
    registerUnsavedScope('settings:global', () => dirty)

    expect(hasUnsavedWork()).toBe(false)
    dirty = true
    expect(hasUnsavedWork()).toBe(true)
    expect(listDirtyScopes()).toEqual(['settings:global'])
  })

  it('reports EVERY dirty scope, not just the active one', () => {
    // The settings page used to compute its banner per tab, so switching tabs
    // hid the warning and the user believed they had saved.
    registerUnsavedScope('settings:global', () => true)
    registerUnsavedScope('settings:project', () => true)
    registerUnsavedScope('diff:file', () => false)

    expect(listDirtyScopes().sort()).toEqual(['settings:global', 'settings:project'])
  })

  it('forgets a scope once it is unregistered', () => {
    registerUnsavedScope('create:form', () => true)
    unregisterUnsavedScope('create:form')
    expect(hasUnsavedWork()).toBe(false)
  })

  it('tolerates unregistering a scope that is already gone', () => {
    // The create page unregisters `create:form` on its success path (so the
    // navigation it triggers itself never prompts) AND on unmount. The second
    // call must be a harmless no-op that leaves the rest of the registry
    // untouched.
    registerUnsavedScope('create:form', () => true)
    registerUnsavedScope('settings:global', () => true)

    unregisterUnsavedScope('create:form')
    expect(() => unregisterUnsavedScope('create:form')).not.toThrow()
    unregisterUnsavedScope('never-registered')

    expect(listDirtyScopes()).toEqual(['settings:global'])
  })

  it('replaces the predicate when the same id registers twice', () => {
    registerUnsavedScope('diff:file', () => true)
    registerUnsavedScope('diff:file', () => false)
    expect(hasUnsavedWork()).toBe(false)
  })

  it('never lets a throwing predicate block navigation', () => {
    registerUnsavedScope('broken', () => {
      throw new Error('component was torn down mid-check')
    })
    expect(() => hasUnsavedWork()).not.toThrow()
    expect(hasUnsavedWork()).toBe(false)
  })
})
