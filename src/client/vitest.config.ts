import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue({ template: { transformAssetUrls: {} } })],
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      src: fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
