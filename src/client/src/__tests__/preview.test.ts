import { describe, expect, it } from 'vitest'
import { isWorkspacePreviewNavigation, previewBrowserUrl, readPreviewPercent } from '../utils/preview'

describe('preview browser address', () => {
  it('supports native local servers and Docker-published localhost ports', () => {
    expect(previewBrowserUrl('http://localhost:8720/', 'http://localhost:9997/', false)).toBe(
      'http://kobo-preview.localhost:8720/',
    )
    expect(previewBrowserUrl('http://127.0.0.1:5173', 'http://localhost:9997/', false)).toBe(
      'http://kobo-preview.localhost:5173/',
    )
  })
  it('isolates cookies in both directions while preserving paths and ports', () => {
    expect(previewBrowserUrl('http://127.0.0.1:8720/app/?tab=1#form', 'http://127.0.0.1:9997', false)).toBe(
      'http://kobo-preview.localhost:8720/app/?tab=1#form',
    )
    expect(previewBrowserUrl('http://[::1]:5173/app/', 'http://[::1]:9997', false)).toBe(
      'http://kobo-preview.localhost:5173/app/',
    )
    expect(() => previewBrowserUrl('https://kobo.example.com:8443', 'https://kobo.example.com', true)).toThrow(
      'different hosts',
    )
  })
  it('refuses unreachable Docker hosts, remote loopback and mixed content', () => {
    expect(() => previewBrowserUrl('http://host.docker.internal:8720', 'http://localhost:9997', false)).toThrow()
    expect(() => previewBrowserUrl('http://localhost:8720', 'https://kobo.example.com', false)).toThrow()
    expect(() => previewBrowserUrl('http://localhost:8720', 'https://localhost:9997', false)).toThrow()
    expect(() => previewBrowserUrl('javascript:alert(1)', 'http://localhost:9997', false)).toThrow()
    expect(() => previewBrowserUrl('http://localhost:9997/api', 'http://localhost:9997', false)).toThrow()
  })
  it('accepts a distinct HTTPS origin from the authenticated preview endpoint', () => {
    expect(previewBrowserUrl('https://abc.preview.example.com/', 'https://kobo.example.com', true)).toBe(
      'https://abc.preview.example.com/',
    )
  })
  it('bounds persisted split widths, including corrupt values', () => {
    expect(readPreviewPercent(null)).toBe(45)
    expect(readPreviewPercent('NaN')).toBe(45)
    expect(readPreviewPercent('500')).toBe(80)
    expect(readPreviewPercent('0')).toBe(20)
    expect(readPreviewPercent('65')).toBe(65)
  })
})

describe('layout navigation and unsaved work', () => {
  const from = { name: 'workspace', params: { id: 'w' }, query: { session: 's' }, hash: '' }
  const to = { ...from, params: { id: 'w', view: 'preview' }, query: { ...from.query, preview: 'split' } }
  it('allows only layout changes in the same workspace and session', () => {
    expect(isWorkspacePreviewNavigation(to, from)).toBe(true)
    expect(isWorkspacePreviewNavigation(from, to)).toBe(true)
    expect(isWorkspacePreviewNavigation({ ...to, params: { id: 'another', view: 'preview' } }, from)).toBe(false)
    expect(isWorkspacePreviewNavigation({ ...to, query: { session: 'another', preview: 'split' } }, from)).toBe(false)
    expect(isWorkspacePreviewNavigation({ ...to, name: 'settings' }, from)).toBe(false)
    expect(isWorkspacePreviewNavigation({ ...to, query: { ...to.query, panel: 'other' } }, from)).toBe(false)
    expect(isWorkspacePreviewNavigation({ ...to, hash: '#other' }, from)).toBe(false)
  })
})
