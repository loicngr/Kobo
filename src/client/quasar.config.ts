import { defineConfig } from '#q-app'

export default defineConfig((ctx) => {
  const backendPort = import.meta.env.KOBO_BACKEND_PORT || '3300'
  const apiTarget = `http://localhost:${backendPort}`
  const wsTarget = `ws://localhost:${backendPort}`

  return {
    boot: ['i18n', 'network-auth', 'notify-theme'],

    css: ['app.scss'],

    // The Roboto extra was removed: DESIGN.md forbids that typeface by name.
    // 'material-icons' stays — the whole UI uses Quasar's Material icon names.
    extras: ['material-icons'],

    build: {
      alias: {
        src: ctx.appPaths.srcDir,
      },
      target: {
        browser: ['es2022', 'firefox115', 'chrome115', 'safari14'],
        node: 'node24',
      },
      vueRouterMode: 'hash',
    },

    pwa: {
      workboxMode: 'GenerateSW',
      // Keep live workspace data network-only: Workbox only precaches the
      // versioned application shell and does not install API runtime caching.
      extendPWAGenerateSWOptions(config) {
        config.skipWaiting = false
        config.clientsClaim = true
      },
    },

    devServer: {
      port: 8080,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/ws': {
          target: wsTarget,
          ws: true,
          changeOrigin: true,
        },
      },
    },

    framework: {
      config: {
        dark: true,
        brand: {
          // Mirror of src/css/quasar.variables.scss — keep both in sync.
          primary: '#665fdd',
          secondary: '#34d399',
          accent: '#665fdd',
          dark: '#1a1a2e',
          'dark-page': '#1a1a2e',
          positive: '#34d399',
          negative: '#f87171',
          info: '#665fdd',
          warning: '#fbbf24',
        },
      },
      plugins: ['Notify', 'Dialog'],
    },

    animations: [],
  }
})
