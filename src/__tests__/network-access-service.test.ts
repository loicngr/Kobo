import { describe, expect, it } from 'vitest'
import {
  authorizeWsUpgrade,
  evaluateNetworkAccess,
  generateToken,
  isLoopbackAddress,
  resolveBindHost,
  tokenMatches,
} from '../server/services/network-access-service.js'

describe('isLoopbackAddress', () => {
  it('accepts the loopback forms', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
  })
  it('rejects LAN addresses and undefined (deny-safe)', () => {
    expect(isLoopbackAddress('192.168.1.20')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })
})

describe('resolveBindHost', () => {
  it('binds localhost when disabled, all interfaces when enabled', () => {
    expect(resolveBindHost(false)).toBe('127.0.0.1')
    expect(resolveBindHost(true)).toBeUndefined()
  })
})

describe('tokenMatches', () => {
  it('is true only for an exact match', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true)
    expect(tokenMatches('abc', 'abd')).toBe(false)
  })
  it('is false for empty/undefined/length mismatch (no throw)', () => {
    expect(tokenMatches('', 'abc')).toBe(false)
    expect(tokenMatches(undefined, 'abc')).toBe(false)
    expect(tokenMatches('abc', '')).toBe(false)
    expect(tokenMatches('ab', 'abc')).toBe(false)
  })
})

describe('generateToken', () => {
  it('returns a long unique url-safe token', () => {
    const a = generateToken()
    const b = generateToken()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(24)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('evaluateNetworkAccess', () => {
  const expectedToken = 'secret'
  it('allows loopback regardless of token', () => {
    expect(
      evaluateNetworkAccess({ address: '127.0.0.1', enabled: true, expectedToken, providedToken: undefined }),
    ).toEqual({ allow: true, status: 200 })
  })
  it('403 when disabled and non-loopback', () => {
    expect(
      evaluateNetworkAccess({ address: '10.0.0.5', enabled: false, expectedToken, providedToken: 'secret' }),
    ).toEqual({ allow: false, status: 403 })
  })
  it('401 when enabled, non-loopback, wrong/absent token', () => {
    expect(evaluateNetworkAccess({ address: '10.0.0.5', enabled: true, expectedToken, providedToken: 'nope' })).toEqual(
      { allow: false, status: 401 },
    )
    expect(
      evaluateNetworkAccess({ address: '10.0.0.5', enabled: true, expectedToken, providedToken: undefined }),
    ).toEqual({ allow: false, status: 401 })
  })
  it('200 when enabled, non-loopback, correct token', () => {
    expect(
      evaluateNetworkAccess({ address: '10.0.0.5', enabled: true, expectedToken, providedToken: 'secret' }),
    ).toEqual({ allow: true, status: 200 })
  })
})

describe('authorizeWsUpgrade', () => {
  it('authorizes loopback without token', () => {
    expect(authorizeWsUpgrade({ address: '::1', rawUrl: '/ws', enabled: true, expectedToken: 'secret' })).toBe(true)
  })
  it('parses ?token= for non-loopback', () => {
    expect(
      authorizeWsUpgrade({ address: '10.0.0.5', rawUrl: '/ws?token=secret', enabled: true, expectedToken: 'secret' }),
    ).toBe(true)
    expect(
      authorizeWsUpgrade({ address: '10.0.0.5', rawUrl: '/ws?token=bad', enabled: true, expectedToken: 'secret' }),
    ).toBe(false)
    expect(authorizeWsUpgrade({ address: '10.0.0.5', rawUrl: '/ws', enabled: true, expectedToken: 'secret' })).toBe(
      false,
    )
  })
})
