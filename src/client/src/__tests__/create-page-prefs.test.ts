import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCreatePagePrefs, saveCreatePagePrefs } from '../utils/create-page-prefs'

describe('create-page-prefs', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('loadCreatePagePrefs', () => {
    it('returns {} when storage is empty', () => {
      expect(loadCreatePagePrefs()).toEqual({})
    })

    it('returns {} when storage holds invalid JSON', () => {
      localStorage.setItem('kobo:create-page-prefs', '{not json')
      expect(loadCreatePagePrefs()).toEqual({})
    })

    it('returns {} when getItem throws', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError')
      })
      expect(loadCreatePagePrefs()).toEqual({})
    })

    it('drops fields with the wrong type but keeps valid siblings', () => {
      localStorage.setItem('kobo:create-page-prefs', JSON.stringify({ projectPath: 42, autoLoop: true }))
      expect(loadCreatePagePrefs()).toEqual({ autoLoop: true })
    })

    it('drops empty-string projectPath', () => {
      localStorage.setItem('kobo:create-page-prefs', JSON.stringify({ projectPath: '', autoLoop: false }))
      expect(loadCreatePagePrefs()).toEqual({ autoLoop: false })
    })

    it('ignores unknown keys', () => {
      localStorage.setItem('kobo:create-page-prefs', JSON.stringify({ projectPath: '/p', autoLoop: true, foo: 'bar' }))
      expect(loadCreatePagePrefs()).toEqual({ projectPath: '/p', autoLoop: true })
    })

    it('loads a valid autoLoopSessionMode', () => {
      localStorage.setItem(
        'kobo:create-page-prefs',
        JSON.stringify({ autoLoop: true, autoLoopSessionMode: 'continuous' }),
      )
      expect(loadCreatePagePrefs()).toEqual({ autoLoop: true, autoLoopSessionMode: 'continuous' })
    })

    it('drops an invalid autoLoopSessionMode value', () => {
      localStorage.setItem('kobo:create-page-prefs', JSON.stringify({ autoLoop: true, autoLoopSessionMode: 'bogus' }))
      expect(loadCreatePagePrefs()).toEqual({ autoLoop: true })
    })

    it('returns {} when stored value is an array', () => {
      localStorage.setItem('kobo:create-page-prefs', JSON.stringify([1, 2, 3]))
      expect(loadCreatePagePrefs()).toEqual({})
    })
  })

  describe('saveCreatePagePrefs', () => {
    it('swallows errors when setItem throws', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })
      expect(() => saveCreatePagePrefs({ projectPath: '/p', autoLoop: true })).not.toThrow()
    })
  })

  describe('round-trip', () => {
    it('save then load returns a structurally-equal object', () => {
      saveCreatePagePrefs({ projectPath: '/home/me/proj', autoLoop: true })
      expect(loadCreatePagePrefs()).toEqual({ projectPath: '/home/me/proj', autoLoop: true })
    })

    it('load returns just the field that was saved (partial)', () => {
      saveCreatePagePrefs({ autoLoop: true })
      expect(loadCreatePagePrefs()).toEqual({ autoLoop: true })
    })

    it('save then load round-trips autoLoopSessionMode', () => {
      saveCreatePagePrefs({ autoLoop: true, autoLoopSessionMode: 'continuous' })
      expect(loadCreatePagePrefs()).toEqual({ autoLoop: true, autoLoopSessionMode: 'continuous' })
    })
  })

  describe('brainstormModel', () => {
    it('loads a valid brainstormModel string', () => {
      localStorage.setItem(
        'kobo:create-page-prefs',
        JSON.stringify({ autoLoop: true, brainstormModel: 'claude-opus-4-8' }),
      )
      expect(loadCreatePagePrefs()).toEqual({ autoLoop: true, brainstormModel: 'claude-opus-4-8' })
    })

    it('drops a non-string brainstormModel', () => {
      localStorage.setItem('kobo:create-page-prefs', JSON.stringify({ autoLoop: true, brainstormModel: 42 }))
      expect(loadCreatePagePrefs()).toEqual({ autoLoop: true })
    })

    it('drops an empty-string brainstormModel', () => {
      localStorage.setItem('kobo:create-page-prefs', JSON.stringify({ autoLoop: true, brainstormModel: '' }))
      expect(loadCreatePagePrefs()).toEqual({ autoLoop: true })
    })

    it('save then load round-trips brainstormModel', () => {
      saveCreatePagePrefs({ autoLoop: true, brainstormModel: 'claude-opus-4-8' })
      expect(loadCreatePagePrefs()).toEqual({ autoLoop: true, brainstormModel: 'claude-opus-4-8' })
    })
  })
})
