import { register } from 'register-service-worker'

/**
 * Quasar imports this entry only in PWA mode. Workbox manages the application
 * shell; API and WebSocket traffic deliberately stay outside its cache.
 */
register(import.meta.env.QUASAR_SERVICE_WORKER_FILE)
