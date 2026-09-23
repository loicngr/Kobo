import { defineConfig } from 'vitest/config'

export default defineConfig({ test: {
  include: ['src/__tests__/live/**/*.live.ts'],
  setupFiles: ['src/__tests__/vitest.setup.ts'],
  testTimeout: 180_000,
  hookTimeout: 30_000,
  fileParallelism: false,
} })
