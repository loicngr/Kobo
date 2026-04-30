import { beforeEach } from 'vitest'

// NOTE: We intentionally do NOT register the Quasar plugin globally via
// @vue/test-utils `config.global.plugins` because the full plugin install
// chokes on happy-dom's missing DOM APIs in some versions. Instead, each
// test that needs Quasar components should pass `global.plugins` to mount(),
// or use simple stubs. For most of our component tests we just need Pinia.

// Stub localStorage for tests that read/write it at module init time
if (typeof localStorage === 'undefined') {
  const store: Record<string, string> = {}
  globalThis.localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v
    },
    removeItem: (k: string) => {
      delete store[k]
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k]
    },
    length: 0,
    key: () => null,
  }
}

beforeEach(() => {
  localStorage.clear()
})
