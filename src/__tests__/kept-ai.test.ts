import { describe, expect, it } from 'vitest'
import { KEPT_DIR_NAME, keptAiPathOf } from '../shared/kept-ai.js'

const json = (keptAiPath: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ ...extra, keptAiPath })

describe('keptAiPathOf', () => {
  it('names the kept folder .kobo-kept', () => {
    expect(KEPT_DIR_NAME).toBe('.kobo-kept')
  })

  it('returns the stored kept root', () => {
    expect(keptAiPathOf('ws1', json('/w/.kobo-kept/ws1'))).toBe('/w/.kobo-kept/ws1')
  })

  it('tolerates a trailing separator and backslash separators', () => {
    expect(keptAiPathOf('ws1', json('/w/.kobo-kept/ws1/'))).toBe('/w/.kobo-kept/ws1/')
    expect(keptAiPathOf('ws1', json('C:\\w\\.kobo-kept\\ws1'))).toBe('C:\\w\\.kobo-kept\\ws1')
    expect(keptAiPathOf('ws1', json('\\\\host\\w\\.kobo-kept\\ws1\\'))).toBe('\\\\host\\w\\.kobo-kept\\ws1\\')
  })

  it('returns null for another workspace id or another parent folder', () => {
    expect(keptAiPathOf('ws2', json('/w/.kobo-kept/ws1'))).toBeNull()
    expect(keptAiPathOf('ws1', json('/w/kept/ws1'))).toBeNull()
  })

  it('returns null for a relative path or a non-string', () => {
    expect(keptAiPathOf('ws1', json('.kobo-kept/ws1'))).toBeNull()
    expect(keptAiPathOf('ws1', json('w/.kobo-kept/ws1'))).toBeNull()
    expect(keptAiPathOf('ws1', json(42))).toBeNull()
    expect(keptAiPathOf('ws1', json(null))).toBeNull()
  })

  it('returns null for invalid JSON, null, undefined and non-object JSON', () => {
    expect(keptAiPathOf('ws1', '{nope')).toBeNull()
    expect(keptAiPathOf('ws1', null)).toBeNull()
    expect(keptAiPathOf('ws1', undefined)).toBeNull()
    expect(keptAiPathOf('ws1', '"/w/.kobo-kept/ws1"')).toBeNull()
    expect(keptAiPathOf('ws1', 'null')).toBeNull()
  })

  it('returns null when keptAiPath is absent from other restore data', () => {
    expect(keptAiPathOf('ws1', JSON.stringify({ prNumber: 3, forge: 'github' }))).toBeNull()
  })

  it('rejects . and .. segments anywhere and an empty workspace id', () => {
    expect(keptAiPathOf('ws1', json('/a/../b/.kobo-kept/ws1'))).toBeNull()
    expect(keptAiPathOf('ws1', json('/a/./b/.kobo-kept/ws1'))).toBeNull()
    expect(keptAiPathOf('ws1', json('/w/.kobo-kept/ws1/..'))).toBeNull()
    expect(keptAiPathOf('', json('/w/.kobo-kept/'))).toBeNull()
  })

  it('accepts a kept folder at the filesystem root', () => {
    expect(keptAiPathOf('ws1', json('/.kobo-kept/ws1'))).toBe('/.kobo-kept/ws1')
  })
})
