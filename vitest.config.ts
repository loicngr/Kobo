import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    globals: true,
    // Runs ONCE per test process, before any test module is loaded.
    // Pins KOBO_HOME to a tmp dir so no test can ever accidentally write
    // to the developer's real ~/.config/kobo/ database.
    setupFiles: ['src/__tests__/vitest.setup.ts'],
  },
})
