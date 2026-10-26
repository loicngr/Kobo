import { describe, expect, it } from 'vitest'
import { readMistralSelect } from '../../server/services/agent/engines/mistral-vibe/configuration.js'

const option = { value: 'alias', name: 'Native model', description: 'native/model' }
const select = (options: unknown = [option], currentValue: unknown = 'alias') => ({
  configOptions: [{ id: 'model', type: 'select', currentValue, options }],
})
describe('native ACP configuration projection', () => {
  it('preserves native flat and grouped labels without leaking config fields', () => {
    expect(readMistralSelect(select(), 'model')).toEqual({ currentValue: 'alias', options: [option] })
    expect(readMistralSelect(select([{ group: 'provider', name: 'Provider', options: [option] }]), 'model')).toEqual({
      currentValue: 'alias',
      options: [{ ...option, group: 'Provider' }],
    })
  })
  it.each([
    select([], 'missing'),
    select([option, option]),
    select([{ ...option, name: '' }]),
    select([{ ...option, value: '\0' }]),
    select([{ ...option, description: 'x'.repeat(2049) }]),
    select(new Array(257).fill(option)),
    select([
      { group: 'p', name: 'P', options: [option] },
      { group: 'p', name: 'P', options: [] },
    ]),
    { configOptions: [...select().configOptions, ...select().configOptions] },
  ])('rejects malformed or ambiguous unchecked native responses', (response) => {
    expect(() => readMistralSelect(response, 'model')).toThrow(/Invalid Vibe ACP/)
  })
})
