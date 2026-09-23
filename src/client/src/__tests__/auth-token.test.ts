import { appendTokenToWsUrl, clearToken, getToken, setToken, shouldAttachToken } from 'src/utils/auth-token'
import { beforeEach, describe, expect, it } from 'vitest'

beforeEach(() => localStorage.clear())

describe('auth-token storage', () => {
  it('round-trips and clears', () => {
    expect(getToken()).toBeNull()
    setToken('abc')
    expect(getToken()).toBe('abc')
    clearToken()
    expect(getToken()).toBeNull()
  })
})

describe('shouldAttachToken', () => {
  it('true for same-origin /api/ urls', () => {
    expect(shouldAttachToken('/api/workspaces')).toBe(true)
    expect(shouldAttachToken(`${window.location.origin}/api/settings`)).toBe(true)
  })
  it('false for non-api or cross-origin', () => {
    expect(shouldAttachToken('/assets/logo.png')).toBe(false)
    expect(shouldAttachToken('https://example.com/api/x')).toBe(false)
  })
})

describe('appendTokenToWsUrl', () => {
  it('appends token when present, leaves url alone when null', () => {
    expect(appendTokenToWsUrl('ws://h/ws', 'abc')).toBe('ws://h/ws?token=abc')
    expect(appendTokenToWsUrl('ws://h/ws?x=1', 'abc')).toBe('ws://h/ws?x=1&token=abc')
    expect(appendTokenToWsUrl('ws://h/ws', null)).toBe('ws://h/ws')
  })
})
