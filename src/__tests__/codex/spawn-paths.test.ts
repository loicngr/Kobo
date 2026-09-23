import { expect, it, vi } from 'vitest'

vi.mock('node:module', () => ({
  createRequire: () =>
    Object.assign(() => ({ bin: { codex: 'bin/codex.js' } }), {
      resolve: () => '/tmp/Kōbō project #1/node_modules/@openai/codex/package.json',
    }),
}))

import { resolveCodexBinary } from '../../server/services/agent/engines/codex/spawn.js'

it('resolves the executable as a filesystem path including spaces, Unicode and hashes', () => {
  expect(resolveCodexBinary()).toBe('/tmp/Kōbō project #1/node_modules/@openai/codex/bin/codex.js')
})
