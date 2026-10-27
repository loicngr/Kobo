import { beforeEach } from 'vitest'

// NOTE: We intentionally do NOT register the Quasar plugin globally via
// @vue/test-utils `config.global.plugins` because the full plugin install
// chokes on happy-dom's missing DOM APIs in some versions. Instead, each
// test that needs Quasar components should pass `global.plugins` to mount(),
// or use simple stubs. For most of our component tests we just need Pinia.

// Use happy-dom storage without invoking Node's experimental localStorage getter.
if (typeof window !== 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: window.localStorage,
  })
}

beforeEach(() => {
  if (typeof window !== 'undefined') window.localStorage.clear()
})
