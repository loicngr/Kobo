import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const merge = require('../client/src-pwa/vendor/deepmerge/index.cjs')

describe('PWA deepmerge security patch', () => {
  it.each(['target', 'source'])('does not poison the result prototype through the %s', (operand) => {
    const malicious = JSON.parse('{"__proto__":{"injected":true},"safe":1}')
    const result = operand === 'target' ? merge(malicious, {}) : merge(Object.create(null), malicious)
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(result.injected).toBeUndefined()
    expect(Object.hasOwn(result, '__proto__')).toBe(true)
    expect(result.safe).toBe(1)
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')).toMatchObject({
      enumerable: true,
      writable: true,
      configurable: true,
    })
  })

  it('retains cloning, arrays, symbols and custom merge options', () => {
    const symbol = Symbol('key')
    const source = { nested: { a: 1 }, items: ['a'], [symbol]: 'value' }
    const result = merge(source, { nested: { b: 2 }, items: ['b'] })
    expect(result).toEqual({ nested: { a: 1, b: 2 }, items: ['a', 'b'], [symbol]: 'value' })
    expect(result.nested).not.toBe(source.nested)
    expect(source.nested).toEqual({ a: 1 })
    expect(merge.all([{ a: 1 }, { b: 2 }])).toEqual({ a: 1, b: 2 })
    expect(merge({ items: [1] }, { items: [2] }, { arrayMerge: (_: unknown, next: unknown) => next })).toEqual({
      items: [2],
    })
  })
})
