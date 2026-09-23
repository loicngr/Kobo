import { createPinia, setActivePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { type DevServerStatus, useDevServerStore } from '../stores/dev-server'

afterEach(() => vi.unstubAllGlobals())

it('does not overwrite a live dev-server status with a late reconnect snapshot', async () => {
  setActivePinia(createPinia())
  const store = useDevServerStore()
  let respond!: (value: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve
        }),
    ),
  )
  const pending = store.fetchStatus('w')
  const live: DevServerStatus = {
    status: 'running',
    instanceName: 'w',
    projectName: 'p',
    httpPort: '8080',
    url: 'http://localhost:8080',
    containers: [],
  }
  store.updateFromWsEvent('w', live)
  respond(new Response(JSON.stringify({ ...live, status: 'stopped' })))
  await pending
  expect(store.getStatus('w')?.status).toBe('running')
})
