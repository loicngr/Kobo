import { describe, expect, it, vi } from 'vitest'

describe('formFieldsEqual', () => {
  it('returns true for two identical flat forms', async () => {
    const { formFieldsEqual } = await import('../utils/form-fields-equal')
    expect(formFieldsEqual({ a: 1, b: 'x', c: true }, { a: 1, b: 'x', c: true })).toBe(true)
  })

  it('returns false as soon as one primitive differs', async () => {
    const { formFieldsEqual } = await import('../utils/form-fields-equal')
    expect(formFieldsEqual({ a: 1, b: 'x' }, { a: 1, b: 'y' })).toBe(false)
  })

  it('treats null and undefined as distinct from empty string', async () => {
    const { formFieldsEqual } = await import('../utils/form-fields-equal')
    expect(formFieldsEqual({ a: null }, { a: '' })).toBe(false)
    expect(formFieldsEqual({ a: null }, { a: null })).toBe(true)
    expect(formFieldsEqual({ a: undefined }, { a: undefined })).toBe(true)
  })

  it('compares arrays element by element, order included', async () => {
    const { formFieldsEqual } = await import('../utils/form-fields-equal')
    expect(formFieldsEqual({ tags: ['a', 'b'] }, { tags: ['a', 'b'] })).toBe(true)
    expect(formFieldsEqual({ tags: ['a', 'b'] }, { tags: ['b', 'a'] })).toBe(false)
    expect(formFieldsEqual({ tags: ['a'] }, { tags: ['a', 'b'] })).toBe(false)
  })

  it('compares nested plain objects', async () => {
    const { formFieldsEqual } = await import('../utils/form-fields-equal')
    expect(formFieldsEqual({ m: { x: 1 } }, { m: { x: 1 } })).toBe(true)
    expect(formFieldsEqual({ m: { x: 1 } }, { m: { x: 2 } })).toBe(false)
    expect(formFieldsEqual({ m: { x: 1 } }, { m: { x: 1, y: 2 } })).toBe(false)
  })

  it('detects a key present on one side only', async () => {
    const { formFieldsEqual } = await import('../utils/form-fields-equal')
    expect(formFieldsEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(formFieldsEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false)
  })

  it('never serialises a multi-kilobyte script field', async () => {
    const { formFieldsEqual } = await import('../utils/form-fields-equal')
    const script = 'echo hello\n'.repeat(500)
    const stringify = vi.spyOn(JSON, 'stringify')
    // Same string reference on both sides: a `===` is enough, no serialisation.
    expect(formFieldsEqual({ setupScript: script }, { setupScript: script })).toBe(true)
    expect(stringify).not.toHaveBeenCalled()
    stringify.mockRestore()
  })

  it('short-circuits on the first differing field', async () => {
    const { formFieldsEqual } = await import('../utils/form-fields-equal')
    let touched = 0
    const probe = {
      get value() {
        touched++
        return 1
      },
    }
    const a = { first: 'x', second: probe }
    const b = { first: 'y', second: probe }
    expect(formFieldsEqual(a, b)).toBe(false)
    // `second` must never have been reached: the walk stopped at `first`.
    expect(touched).toBe(0)
  })
})

describe('captureFormSnapshot', () => {
  it('detaches arrays from the live form so an in-place push is still detected', async () => {
    const { captureFormSnapshot } = await import('../utils/form-snapshot')
    const { formFieldsEqual } = await import('../utils/form-fields-equal')
    const tags = ['a']
    const live = { tags }

    const saved = captureFormSnapshot(live)
    tags.push('b')

    expect(saved.tags).toEqual(['a'])
    expect(formFieldsEqual(live, saved)).toBe(false)
  })

  it('detaches nested objects so a v-model on a nested field is still detected', async () => {
    const { captureFormSnapshot } = await import('../utils/form-snapshot')
    const { formFieldsEqual } = await import('../utils/form-fields-equal')
    const live = { devServer: { startCommand: 'npm run dev' }, e2e: { framework: 'playwright' } }

    const saved = captureFormSnapshot(live)
    live.devServer.startCommand = 'pnpm dev'

    expect((saved.devServer as { startCommand: string }).startCommand).toBe('npm run dev')
    expect(formFieldsEqual(live, saved)).toBe(false)
  })

  it('keeps an untouched form equal to its snapshot', async () => {
    const { captureFormSnapshot } = await import('../utils/form-snapshot')
    const { formFieldsEqual } = await import('../utils/form-fields-equal')
    const live = { tags: ['a'], nested: { n: 1 }, flag: true, empty: null, missing: undefined }
    expect(formFieldsEqual(live, captureFormSnapshot(live))).toBe(true)
  })
})

describe('captureFormSnapshot on Vue reactive state', () => {
  // The settings form holds `reactive()` / `ref()` state, so the values reaching
  // the snapshot are Proxy objects. `structuredClone` REFUSES to clone a Proxy
  // ("DataCloneError: #<Object> could not be cloned"), which took the whole
  // Settings page down at setup() time.
  it('clones a reactive form without throwing, and detaches it', async () => {
    const { reactive } = await import('vue')
    const { captureFormSnapshot } = await import('../utils/form-snapshot')
    const { formFieldsEqual } = await import('../utils/form-fields-equal')
    const form = reactive({ tags: ['a'], devServer: { startCommand: 'npm run dev' } })

    const saved = captureFormSnapshot({ ...form })
    form.tags.push('b')
    form.devServer.startCommand = 'pnpm dev'

    expect(saved.tags).toEqual(['a'])
    expect((saved.devServer as { startCommand: string }).startCommand).toBe('npm run dev')
    expect(formFieldsEqual({ ...form }, saved)).toBe(false)
  })
})
