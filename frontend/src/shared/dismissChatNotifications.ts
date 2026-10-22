// Local-device dismiss of any tray notifications for a given chat. Used on
// chat-open so the user doesn't have to wait for the round-trip via
// `mark_read` → backend → SendDismiss-push to see the tray clear on the
// device they just opened the chat on. Other devices are handled by the
// backend dispatch.
//
// Works on both web (via the service worker's getNotifications API) and
// native (via @capacitor/push-notifications removeDeliveredNotifications).
// Silent no-op on platforms without notification APIs.

import { log } from './log'
import { isNative } from './platform'

export async function dismissChatNotifications(chatId: number): Promise<void> {
  const tag = `chat-${chatId}`

  if (isNative()) {
    try {
      const { PushNotifications } = await import('@capacitor/push-notifications')
      const { notifications } = await PushNotifications.getDeliveredNotifications()
      const toRemove = notifications.filter((n) => n.tag === tag)
      if (toRemove.length > 0) {
        await PushNotifications.removeDeliveredNotifications({ notifications: toRemove })
      }
    } catch (err) {
      log.warn('dismissChatNotifications (native):', err)
    }
    return
  }

  // Web: ask the service worker to enumerate its notifications and close any
  // with our tag. Requires the SW to be registered (which it is on first
  // subscribe) — if not, this just silently no-ops.
  if (!('serviceWorker' in navigator)) return
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    if (!reg) return
    const notifs = await reg.getNotifications({ tag })
    notifs.forEach((n) => n.close())
  } catch (err) {
    log.warn('dismissChatNotifications (web):', err)
  }
}
