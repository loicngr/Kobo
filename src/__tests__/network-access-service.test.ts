import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authorizeWsUpgrade,
  evaluateNetworkAccess,
  generateToken,
  getLanHostnames,
  getLanUrls,
  isAllowedOrigin,
  isAllowedRequestHost,
  isLocalRequestHost,
  isLoopbackAddress,
  resolveBindHost,
  resolveDevClientOrigin,
  resolveNetworkAccessEnvOverrides,
  resolveProxyHostname,
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
  it('trustLoopback=false: loopback still needs a valid token when enabled', () => {
    expect(
      evaluateNetworkAccess({
        address: '127.0.0.1',
        enabled: true,
        expectedToken,
        providedToken: undefined,
        trustLoopback: false,
      }),
    ).toEqual({ allow: false, status: 401 })
    expect(
      evaluateNetworkAccess({
        address: '127.0.0.1',
        enabled: true,
        expectedToken,
        providedToken: expectedToken,
        trustLoopback: false,
      }),
    ).toEqual({ allow: true, status: 200 })
  })
  it('trustLoopback=false: 403 for loopback when disabled', () => {
    expect(
      evaluateNetworkAccess({
        address: '127.0.0.1',
        enabled: false,
        expectedToken,
        providedToken: undefined,
        trustLoopback: false,
      }),
    ).toEqual({ allow: false, status: 403 })
  })
  it('trustLoopback omitted defaults to true (unchanged behavior)', () => {
    expect(
      evaluateNetworkAccess({ address: '127.0.0.1', enabled: true, expectedToken, providedToken: undefined }),
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
  it('trustLoopback=false: loopback WS upgrade needs the token', () => {
    expect(
      authorizeWsUpgrade({
        address: '::1',
        rawUrl: '/ws',
        enabled: true,
        expectedToken: 'secret',
        trustLoopback: false,
      }),
    ).toBe(false)
    expect(
      authorizeWsUpgrade({
        address: '::1',
        rawUrl: '/ws?token=secret',
        enabled: true,
        expectedToken: 'secret',
        trustLoopback: false,
      }),
    ).toBe(true)
  })
})

describe('resolveNetworkAccessEnvOverrides', () => {
  it('returns {} when both env vars are unset', () => {
    expect(resolveNetworkAccessEnvOverrides({})).toEqual({})
  })
  it('KOBO_NETWORK_ACCESS_ENABLED=true → networkAccessEnabled: true', () => {
    expect(resolveNetworkAccessEnvOverrides({ KOBO_NETWORK_ACCESS_ENABLED: 'true' })).toEqual({
      networkAccessEnabled: true,
    })
  })
  it('KOBO_NETWORK_ACCESS_ENABLED=1 → networkAccessEnabled: true', () => {
    expect(resolveNetworkAccessEnvOverrides({ KOBO_NETWORK_ACCESS_ENABLED: '1' })).toEqual({
      networkAccessEnabled: true,
    })
  })
  it('KOBO_NETWORK_ACCESS_ENABLED=false → networkAccessEnabled: false (explicit off)', () => {
    expect(resolveNetworkAccessEnvOverrides({ KOBO_NETWORK_ACCESS_ENABLED: 'false' })).toEqual({
      networkAccessEnabled: false,
    })
  })
  it('KOBO_NETWORK_ACCESS_ENABLED=garbage → networkAccessEnabled: false (any non-true/1 is off)', () => {
    expect(resolveNetworkAccessEnvOverrides({ KOBO_NETWORK_ACCESS_ENABLED: 'garbage' })).toEqual({
      networkAccessEnabled: false,
    })
  })
  it('KOBO_NETWORK_ACCESS_BEHIND_PROXY=true → networkAccessBehindProxy: true', () => {
    expect(resolveNetworkAccessEnvOverrides({ KOBO_NETWORK_ACCESS_BEHIND_PROXY: 'true' })).toEqual({
      networkAccessBehindProxy: true,
    })
  })
  it('both env vars set → both keys present', () => {
    expect(
      resolveNetworkAccessEnvOverrides({
        KOBO_NETWORK_ACCESS_ENABLED: 'true',
        KOBO_NETWORK_ACCESS_BEHIND_PROXY: 'true',
      }),
    ).toEqual({ networkAccessEnabled: true, networkAccessBehindProxy: true })
  })
})

describe('isAllowedRequestHost', () => {
  const base = { enabled: false, lanHostnames: [] as string[] }

  it('accepts the host machine own names, with or without a port', () => {
    expect(isAllowedRequestHost({ ...base, host: 'localhost:3000' })).toBe(true)
    expect(isAllowedRequestHost({ ...base, host: '127.0.0.1:3000' })).toBe(true)
    expect(isAllowedRequestHost({ ...base, host: 'localhost' })).toBe(true)
    expect(isAllowedRequestHost({ ...base, host: '[::1]:3000' })).toBe(true)
  })

  it('rejects a foreign hostname (DNS rebinding)', () => {
    expect(isAllowedRequestHost({ ...base, host: 'evil.com' })).toBe(false)
    expect(isAllowedRequestHost({ ...base, host: 'evil.com:3000' })).toBe(false)
  })

  it('accepts a LAN address only when network access is enabled', () => {
    const lanHostnames = ['192.168.1.20']
    expect(isAllowedRequestHost({ enabled: false, lanHostnames, host: '192.168.1.20:3000' })).toBe(false)
    expect(isAllowedRequestHost({ enabled: true, lanHostnames, host: '192.168.1.20:3000' })).toBe(true)
    expect(isAllowedRequestHost({ enabled: true, lanHostnames, host: '192.168.1.99:3000' })).toBe(false)
  })

  it('accepts any host behind a reverse proxy, where the token gate owns the boundary', () => {
    expect(isAllowedRequestHost({ ...base, host: 'kobo.example.com', behindProxy: true })).toBe(true)
  })

  it('enforces the declared proxy hostname when the operator supplies one', () => {
    // Without a declared hostname we cannot tell the operator's domain from an
    // attacker's, so proxy mode accepts anything. Declaring it closes that.
    const proxied = { ...base, behindProxy: true, proxyHostname: 'kobo.example.com' }
    expect(isAllowedRequestHost({ ...proxied, host: 'kobo.example.com' })).toBe(true)
    expect(isAllowedRequestHost({ ...proxied, host: 'kobo.example.com:8443' })).toBe(true)
    expect(isAllowedRequestHost({ ...proxied, host: 'evil.com' })).toBe(false)
    // Loopback stays reachable so a local healthcheck still works.
    expect(isAllowedRequestHost({ ...proxied, host: 'localhost:3000' })).toBe(true)
  })

  it('denies a missing or unparseable host (deny-safe)', () => {
    expect(isAllowedRequestHost({ ...base, host: undefined })).toBe(false)
    expect(isAllowedRequestHost({ ...base, host: '' })).toBe(false)
    expect(isAllowedRequestHost({ ...base, host: 'ht tp://x' })).toBe(false)
  })
})

describe('isAllowedOrigin', () => {
  it('allows a request with no Origin (non-browser client)', () => {
    expect(isAllowedOrigin({ origin: undefined, requestHost: 'localhost:3000' })).toBe(true)
  })

  it('allows the page we served ourselves, whatever port that is', () => {
    // The real invariant: this page came from us. It survives a port remap
    // (docker -p 3001:3000, ssh -L) that a fixed port list would break.
    expect(isAllowedOrigin({ origin: 'http://localhost:3000', requestHost: 'localhost:3000' })).toBe(true)
    expect(isAllowedOrigin({ origin: 'http://localhost:3001', requestHost: 'localhost:3001' })).toBe(true)
    expect(isAllowedOrigin({ origin: 'http://192.168.1.20:3000', requestHost: '192.168.1.20:3000' })).toBe(true)
    expect(isAllowedOrigin({ origin: 'http://localhost', requestHost: 'localhost' })).toBe(true)
  })

  it('refuses a page served from another loopback port', () => {
    // Kobo starts a dev server per workspace on a loopback port, serving code
    // an agent just wrote.
    expect(isAllowedOrigin({ origin: 'http://localhost:5173', requestHost: 'localhost:3000' })).toBe(false)
    expect(isAllowedOrigin({ origin: 'http://localhost:8080', requestHost: 'localhost:3000' })).toBe(false)
  })

  it('refuses a page served from another site, even when it reaches us by our own name', () => {
    expect(isAllowedOrigin({ origin: 'http://evil.com', requestHost: 'localhost:3000' })).toBe(false)
    // A rebinding page matches Host and Origin, so the Host check is what
    // rejects it; this one only has to not undo that.
    expect(isAllowedOrigin({ origin: 'http://evil.com', requestHost: 'evil.com' })).toBe(true)
  })

  it('refuses the opaque null origin and anything unparseable', () => {
    expect(isAllowedOrigin({ origin: 'null', requestHost: 'localhost:3000' })).toBe(false)
    expect(isAllowedOrigin({ origin: '', requestHost: 'localhost:3000' })).toBe(false)
    expect(isAllowedOrigin({ origin: 'http://localhost:3000', requestHost: undefined })).toBe(false)
  })

  it('accepts the declared dev client origin, which the proxy hides behind a rewritten Host', () => {
    // `quasar dev` proxies to the backend with changeOrigin, so the Host we
    // see is our own while the browser sits on the Quasar port.
    const devOrigin = 'http://localhost:8080'
    expect(isAllowedOrigin({ origin: 'http://localhost:8080', requestHost: 'localhost:3300', devOrigin })).toBe(true)
    expect(isAllowedOrigin({ origin: 'http://localhost:5173', requestHost: 'localhost:3300', devOrigin })).toBe(false)
  })

  it('behind a proxy, enforces the declared hostname and accepts anything without one', () => {
    expect(isAllowedOrigin({ origin: 'https://evil.com', requestHost: 'kobo.example.com', behindProxy: true })).toBe(
      true,
    )
    const declared = { behindProxy: true, proxyHostname: 'kobo.example.com' }
    expect(isAllowedOrigin({ ...declared, origin: 'https://kobo.example.com', requestHost: 'kobo.example.com' })).toBe(
      true,
    )
    expect(isAllowedOrigin({ ...declared, origin: 'https://evil.com', requestHost: 'kobo.example.com' })).toBe(false)
  })
})

describe('resolveProxyHostname', () => {
  it('reads the declared hostname, with or without a scheme or port', () => {
    expect(resolveProxyHostname({ KOBO_NETWORK_ACCESS_PROXY_HOST: 'kobo.example.com' })).toBe('kobo.example.com')
    expect(resolveProxyHostname({ KOBO_NETWORK_ACCESS_PROXY_HOST: 'https://kobo.example.com' })).toBe(
      'kobo.example.com',
    )
    expect(resolveProxyHostname({ KOBO_NETWORK_ACCESS_PROXY_HOST: 'kobo.example.com:8443' })).toBe('kobo.example.com')
  })

  it('returns null when unset, empty or unparseable, keeping today behaviour', () => {
    expect(resolveProxyHostname({})).toBeNull()
    expect(resolveProxyHostname({ KOBO_NETWORK_ACCESS_PROXY_HOST: '   ' })).toBeNull()
    expect(resolveProxyHostname({ KOBO_NETWORK_ACCESS_PROXY_HOST: 'ht tp://x' })).toBeNull()
  })
})

describe('resolveDevClientOrigin', () => {
  it('reads the origin the dev script declares, and nothing otherwise', () => {
    expect(resolveDevClientOrigin({ KOBO_DEV_CLIENT_ORIGIN: 'http://localhost:8080' })).toBe('http://localhost:8080')
    expect(resolveDevClientOrigin({})).toBeNull()
    expect(resolveDevClientOrigin({ KOBO_DEV_CLIENT_ORIGIN: '  ' })).toBeNull()
  })
})

describe('isLocalRequestHost', () => {
  it('recognises every form of the machine own address', () => {
    expect(isLocalRequestHost('localhost:3000')).toBe(true)
    expect(isLocalRequestHost('127.0.0.1')).toBe(true)
    expect(isLocalRequestHost('[::1]:3000')).toBe(true)
    expect(isLocalRequestHost('[::ffff:127.0.0.1]:3000')).toBe(true)
    expect(isLocalRequestHost('http://localhost:8080')).toBe(true)
  })

  it('rejects anything else, including undefined', () => {
    expect(isLocalRequestHost('evil.com')).toBe(false)
    expect(isLocalRequestHost('192.168.1.20:3000')).toBe(false)
    expect(isLocalRequestHost(undefined)).toBe(false)
  })
})

describe('getLanHostnames / getLanUrls', () => {
  const sample = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [
      { address: '192.168.1.20', family: 'IPv4', internal: false },
      { address: 'fe80::1%eth0', family: 'IPv6', internal: false },
      { address: 'fd00::1', family: 'IPv6', internal: false },
    ],
  }

  afterEach(() => vi.restoreAllMocks())

  it('lists both families for the allowlist, zone suffix stripped', () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue(sample as never)

    expect(getLanHostnames()).toEqual(['192.168.1.20', 'fe80::1', 'fd00::1'])
  })

  it('keeps the displayed URLs and the QR IPv4-only', () => {
    // An IPv6 literal is not something anyone reads off a screen or scans.
    vi.spyOn(os, 'networkInterfaces').mockReturnValue(sample as never)

    expect(getLanUrls(3000)).toEqual(['http://192.168.1.20:3000'])
  })
})
