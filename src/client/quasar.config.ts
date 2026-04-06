import { defineConfig } from '#q-app/wrappers'

export default defineConfig(() => {
  return {
    boot: ['i18n'],

    css: ['app.scss'],

    extras: ['roboto-font', 'material-icons'],

    build: {
      target: {
        browser: ['es2022', 'firefox115', 'chrome115', 'safari14'],
        node: 'node20',
      },
      vueRouterMode: 'hash',
    },

    devServer: {
      port: 8080,
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
        '/ws': {
          target: 'ws://localhost:3000',
          ws: true,
          changeOrigin: true,
        },
      },
    },

    framework: {
      config: {
        dark: true,
        brand: {
          primary: '#6c63ff',
          secondary: '#26a69a',
          accent: '#9c27b0',
          dark: '#1a1a2e',
          'dark-page': '#1a1a2e',
          positive: '#21ba45',
          negative: '#c10015',
          info: '#31ccec',
          warning: '#f2c037',
        },
      },
      plugins: ['Notify'],
    },

    animations: [],
  }
})
