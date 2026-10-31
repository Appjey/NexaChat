// Service Worker for Push Notifications

// Activate immediately without waiting for old SW to finish
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker')
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker')
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  console.log('[SW] Push event received:', event)

  if (!event.data) {
    console.warn('[SW] Push event has no data')
    return
  }

  let payload
  try {
    payload = event.data.json()
    console.log('[SW] Push payload:', JSON.stringify(payload))
  } catch (e) {
    console.warn('[SW] Failed to parse push data as JSON:', e)
    payload = {
      title: 'New message',
      body: event.data.text(),
    }
  }

  // Dismiss-type push: backend tells us "this chat is now read on some
  // other device, clear any tray entries for it here too". Close every
  // notification whose tag matches chat-<chatId> and stop — don't show
  // anything new. Backend fires this on mark_read / delete_message /
  // clear_chat / delete_chat / chat_opened.
  if (payload.type === 'dismiss' && (payload.chat_id !== undefined || payload.tag)) {
    const tag = payload.tag || `chat-${payload.chat_id}`
    event.waitUntil(
      self.registration.getNotifications({ tag }).then((notifs) => {
        console.log(`[SW] dismiss for ${tag}: closing ${notifs.length} notif(s)`)
        notifs.forEach((n) => n.close())
      }),
    )
    return
  }

  // Call doorbell (web fallback, Tier A): show a high-priority notification
  // tagged call-<call_id> (never chat-<id>, so the dismiss sweep can't close
  // it). Clicking opens the chat. No live ring on web — this is the wake-up.
  if (payload.type === 'call' && payload.call_id) {
    const tag = payload.tag || `call-${payload.call_id}`
    event.waitUntil(
      self.registration.showNotification(payload.title || 'Входящий звонок', {
        body: payload.body || '',
        icon: '/favicon.svg',
        badge: '/favicon.svg',
        tag,
        renotify: true,
        requireInteraction: true,
        data: { chat_id: payload.chat_id, call_id: payload.call_id, type: 'call' },
      }),
    )
    return
  }

  const options = {
    body: payload.body || '',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: payload.tag || 'default',
    renotify: true,
    data: {
      chat_id: payload.chat_id,
      user_id: payload.user_id,
    },
  }

  // Only show notification if no app tab is currently focused/visible.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: false }).then((windowClients) => {
      const hasVisibleTab = windowClients.some((client) => client.visibilityState === 'visible')
      if (hasVisibleTab) {
        console.log('[SW] App tab is visible, suppressing notification')
        return
      }
      console.log('[SW] No visible app tab, showing notification')
      return self.registration.showNotification(payload.title || 'NexaChat', options)
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked:', event.notification.data)
  event.notification.close()

  const chatId = event.notification.data?.chat_id
  const targetUrl = chatId ? `/?chat=${chatId}` : '/'

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin)) {
          client.focus()
          client.postMessage({
            type: 'NOTIFICATION_CLICK',
            chat_id: chatId,
          })
          return
        }
      }
      return clients.openWindow(targetUrl)
    }),
  )
})
