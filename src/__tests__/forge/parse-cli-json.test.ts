import { describe, expect, it } from 'vitest'
import { parseCliJson } from '../../server/services/forge/parse-cli-json.js'

describe('parseCliJson', () => {
  it('parses valid JSON', () => {
    expect(parseCliJson<{ a: number }>('{"a":1}', 'gh test')).toEqual({ a: 1 })
  })

  it('wraps a syntax error in an actionable message', () => {
    expect(() => parseCliJson('not json', 'gh pr list')).toThrow(/gh pr list returned unparsable output/)
  })
})
