/**
 * Quasar imports this entry only in PWA mode. Workbox manages the application
 * shell; API and WebSocket traffic deliberately stays outside its cache.
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const serviceWorkerFile = process.env.SERVICE_WORKER_FILE
    if (serviceWorkerFile) void navigator.serviceWorker.register(serviceWorkerFile)
  })
}
