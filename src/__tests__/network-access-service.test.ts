import { afterEach, describe, expect, it } from 'vitest'
import {
  authorizeWsUpgrade,
  evaluateNetworkAccess,
  generateToken,
  isAllowedOrigin,
  isAllowedRequestHost,
  isLocalRequestHost,
  isLoopbackAddress,
  resolveBindHost,
  resolveNetworkAccessEnvOverrides,
  resolveProxyHostname,
  tokenMatches,
  trustedLocalOriginPorts,
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
  const base = { enabled: false, lanHostnames: [] as string[] }

  it('allows a request with no Origin (non-browser client)', () => {
    expect(isAllowedOrigin({ ...base, origin: undefined })).toBe(true)
  })

  it('allows a loopback page on any port, so the Quasar dev server keeps working', () => {
    expect(isAllowedOrigin({ ...base, origin: 'http://localhost:3000' })).toBe(true)
    expect(isAllowedOrigin({ ...base, origin: 'http://localhost:8080' })).toBe(true)
    expect(isAllowedOrigin({ ...base, origin: 'http://127.0.0.1:9999' })).toBe(true)
  })

  it('rejects a page served from another site', () => {
    expect(isAllowedOrigin({ ...base, origin: 'http://evil.com' })).toBe(false)
    expect(isAllowedOrigin({ ...base, origin: 'https://evil.com:3000' })).toBe(false)
  })

  it('rejects the opaque null origin sent by a sandboxed iframe', () => {
    expect(isAllowedOrigin({ ...base, origin: 'null' })).toBe(false)
  })

  it('accepts a LAN origin only when network access is enabled', () => {
    const lanHostnames = ['192.168.1.20']
    expect(isAllowedOrigin({ enabled: false, lanHostnames, origin: 'http://192.168.1.20:3000' })).toBe(false)
    expect(isAllowedOrigin({ enabled: true, lanHostnames, origin: 'http://192.168.1.20:3000' })).toBe(true)
  })

  it('accepts any origin behind a reverse proxy, where the token gate owns the boundary', () => {
    expect(isAllowedOrigin({ ...base, origin: 'https://kobo.example.com', behindProxy: true })).toBe(true)
  })

  it('accepts a LAN IPv6 origin, not just IPv4', () => {
    const lanHostnames = ['fd00::1']
    expect(isAllowedOrigin({ enabled: true, lanHostnames, origin: 'http://[fd00::1]:3000' })).toBe(true)
  })

  it('trusts a local page only on a port we actually serve', () => {
    // Kōbō starts dev servers of its own on loopback ports, serving code an
    // agent wrote. Being on localhost cannot be enough to reach the terminal.
    const ports = { ...base, allowedPorts: [3000] }
    expect(isAllowedOrigin({ ...ports, origin: 'http://localhost:3000' })).toBe(true)
    expect(isAllowedOrigin({ ...ports, origin: 'http://127.0.0.1:3000' })).toBe(true)
    expect(isAllowedOrigin({ ...ports, origin: 'http://localhost:5173' })).toBe(false)
    expect(isAllowedOrigin({ ...ports, origin: 'http://localhost:8080' })).toBe(false)
  })

  it('reads the implicit port of a scheme when the origin carries none', () => {
    expect(isAllowedOrigin({ ...base, allowedPorts: [80], origin: 'http://localhost' })).toBe(true)
    expect(isAllowedOrigin({ ...base, allowedPorts: [443], origin: 'https://localhost' })).toBe(true)
    expect(isAllowedOrigin({ ...base, allowedPorts: [3000], origin: 'http://localhost' })).toBe(false)
  })

  it('applies the port rule to LAN origins too', () => {
    const lanHostnames = ['192.168.1.20']
    expect(
      isAllowedOrigin({ enabled: true, lanHostnames, allowedPorts: [3000], origin: 'http://192.168.1.20:3000' }),
    ).toBe(true)
    expect(
      isAllowedOrigin({ enabled: true, lanHostnames, allowedPorts: [3000], origin: 'http://192.168.1.20:5173' }),
    ).toBe(false)
  })

  it('keeps accepting every port when no list is given', () => {
    expect(isAllowedOrigin({ ...base, origin: 'http://localhost:5173' })).toBe(true)
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

describe('trustedLocalOriginPorts', () => {
  const previous = process.env.KOBO_ENFORCE_LOCAL_HOME

  afterEach(() => {
    if (previous === undefined) delete process.env.KOBO_ENFORCE_LOCAL_HOME
    else process.env.KOBO_ENFORCE_LOCAL_HOME = previous
  })

  it('trusts only our own port in production', () => {
    delete process.env.KOBO_ENFORCE_LOCAL_HOME
    expect(trustedLocalOriginPorts(3000)).toEqual([3000])
  })

  it('also trusts the Quasar dev server when running npm run dev', () => {
    // In dev the browser sits on the Quasar port and proxies through to us, so
    // that is the origin we see.
    process.env.KOBO_ENFORCE_LOCAL_HOME = '1'
    expect(trustedLocalOriginPorts(3300)).toContain(3300)
    expect(trustedLocalOriginPorts(3300)).toContain(8080)
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
