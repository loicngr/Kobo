import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    globals: true,
    // Many tests drive real git repositories; a slow macOS CI runner has taken 6 s on one
    // that needs under 1 s elsewhere, which the 5 s default turns into a false failure.
    testTimeout: 15_000,
    // Runs ONCE per test process, before any test module is loaded.
    // Pins KOBO_HOME to a tmp dir so no test can ever accidentally write
    // to the developer's real ~/.config/kobo/ database.
    setupFiles: ['src/__tests__/vitest.setup.ts'],
  },
})
