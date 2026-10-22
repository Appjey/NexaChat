// Register the push-notification-tap listener at app bootstrap, before any other async work,
// so Capacitor's buffered event (fired when the app is cold-started by a notification tap)
// reaches us instead of being dropped.
//
// The @capacitor/push-notifications plugin is known to lose the tap event on cold start /
// long-background if the listener is registered lazily inside a React effect — by then the
// native side has already flushed and discarded the pending event.

import { log } from './log'
import { setPendingCall } from './pendingCall'
import { setPendingChat } from './pendingChat'
import { isNative } from './platform'

let initialized = false

export function initEarlyPushHandlers() {
  if (initialized || !isNative()) return
  initialized = true

  void (async () => {
    try {
      const { PushNotifications } = await import('@capacitor/push-notifications')

      await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        const data = action.notification.data ?? {}
        const chatIdRaw = data.chat_id
        if (!chatIdRaw) return
        const chatId = Number(chatIdRaw)
        if (!Number.isFinite(chatId)) return
        // Call doorbell tap: stash the pending call so CallProvider emits
        // call_ready once the WS connects (→ caller re-offers). Also open the
        // chat for context.
        if (data.type === 'call' && data.call_id) {
          const callerId = Number(data.caller_id)
          if (Number.isFinite(callerId)) {
            setPendingCall({ callId: String(data.call_id), chatId, callerId })
          }
        }
        setPendingChat(chatId)
      })

      // Dismiss-pushes are FCM data-only messages (no notification payload).
      // Capacitor fires `pushNotificationReceived` for them whether the app
      // is in foreground or warm-backgrounded — the listener branches on
      // data.type === 'dismiss' and removes any tray entries that match
      // the chat-<id> tag. Backend dispatches these on mark_read /
      // delete_message / clear_chat / delete_chat / chat_opened from any
      // of the user's devices, keeping all of them in sync.
      //
      // Force-stopped apps don't receive data-only messages — tray entry
      // persists until the user next opens the app, at which point the
      // chat-enter hook + WS reconnect catch up. Known Android FCM limit.
      await PushNotifications.addListener('pushNotificationReceived', async (notif) => {
        // Call doorbell received in foreground/warm-bg: ignore — if the app is
        // alive the WS relay drives the call directly. Return BEFORE the dismiss
        // branch so a call notification is never swept as a dismiss.
        if (notif.data?.type === 'call') return
        if (notif.data?.type !== 'dismiss') return
        const chatIdRaw = notif.data?.chat_id
        if (!chatIdRaw) return
        const tag = notif.data?.tag || `chat-${chatIdRaw}`
        try {
          const { notifications } = await PushNotifications.getDeliveredNotifications()
          const toRemove = notifications.filter((n) => n.tag === tag)
          if (toRemove.length === 0) return
          await PushNotifications.removeDeliveredNotifications({ notifications: toRemove })
        } catch (err) {
          log.warn('earlyPush: dismiss handling failed', err)
        }
      })
    } catch (err) {
      log.error('earlyPush: failed to register push listeners', err)
    }
  })()
}
