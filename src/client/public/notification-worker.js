/* global clients, self */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data
  const target = data?.target
  if (!target || typeof target !== 'object' || Object.keys(target).some((key) => key !== 'workspaceId' && key !== 'sessionId') ||
      typeof target.workspaceId !== 'string' || !target.workspaceId || target.workspaceId.length > 256 ||
      (target.sessionId !== undefined && (typeof target.sessionId !== 'string' || !target.sessionId || target.sessionId.length > 256))) return
  const url = new URL(self.registration.scope)
  url.hash = `/workspace/${encodeURIComponent(target.workspaceId)}${target.sessionId ? `?session=${encodeURIComponent(target.sessionId)}` : ''}`
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    const applications = windows.filter((client) => {
      const current = new URL(client.url)
      return current.origin === url.origin && current.pathname === url.pathname && !current.searchParams.has('pane')
    })
    if (applications.length) {
      const id = crypto.randomUUID()
      const channels = []
      const acknowledged = await new Promise((resolve) => {
        let settled = false
        const timer = setTimeout(() => { settled = true; resolve(false) }, 1500)
        for (const application of applications) {
          if (settled) break
          const channel = new MessageChannel()
          channels.push(channel)
          channel.port1.onmessage = (message) => {
            if (settled || message.data?.type !== 'kobo-notification-received' || message.data.id !== id) return
            settled = true
            clearTimeout(timer)
            channel.port1.postMessage({ type: 'kobo-notification-deliver', id })
            void application.focus().catch(() => {})
            resolve(true)
          }
          try { application.postMessage({ type: 'kobo-notification-click', id, target }, [channel.port2]) }
          catch { /* try other windows */ }
        }
      })
      for (const channel of channels) channel.port1.close()
      if (acknowledged) return
    }
    await clients.openWindow(url.href)
  })())
})
