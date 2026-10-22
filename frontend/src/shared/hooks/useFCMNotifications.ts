import { useEffect } from 'react'

import { registerFCMToken, unregisterFCMToken } from '../api/pushApi'
import { log } from '../log'
import { getPlatform, isNative } from '../platform'

const STORED_TOKEN_KEY = 'fcm_token'

/**
 * Registers the device with FCM on native platforms and posts the token to the backend.
 * Permission is requested on mount if not yet granted.
 *
 * Tap-handling lives in `earlyPush.ts` (module-load time) so a cold-start tap isn't lost
 * while this hook waits for React + auth hydration. This hook owns only registration.
 *
 * Noop on web — Web Push via VAPID handles that case.
 */
export function useFCMNotifications(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !isNative()) return

    let mounted = true
    let registrationListener: { remove: () => void } | undefined
    let errorListener: { remove: () => void } | undefined

    async function setup() {
      const { PushNotifications } = await import('@capacitor/push-notifications')

      const permStatus = await PushNotifications.checkPermissions()
      let receive = permStatus.receive
      if (receive === 'prompt' || receive === 'prompt-with-rationale') {
        const req = await PushNotifications.requestPermissions()
        receive = req.receive
      }
      if (receive !== 'granted') {
        log.warn('FCM: notification permission not granted')
        return
      }

      if (!mounted) return

      registrationListener = await PushNotifications.addListener('registration', async (token) => {
        try {
          const previous = localStorage.getItem(STORED_TOKEN_KEY)
          if (previous === token.value) return
          await registerFCMToken(token.value, getPlatform() as 'android' | 'ios')
          localStorage.setItem(STORED_TOKEN_KEY, token.value)
        } catch (err) {
          log.error('FCM: failed to register token with backend', err)
        }
      })

      errorListener = await PushNotifications.addListener('registrationError', (err) => {
        log.error('FCM registration error', err)
      })

      await PushNotifications.register()
    }

    void setup()

    return () => {
      mounted = false
      registrationListener?.remove()
      errorListener?.remove()
    }
  }, [enabled])
}

/** Unregister the current device token (called on logout). */
export async function unregisterFCMDevice() {
  if (!isNative()) return
  const token = localStorage.getItem(STORED_TOKEN_KEY)
  if (!token) return
  try {
    await unregisterFCMToken(token)
  } catch (err) {
    log.warn('FCM: backend unregister failed', err)
  }
  localStorage.removeItem(STORED_TOKEN_KEY)
}
