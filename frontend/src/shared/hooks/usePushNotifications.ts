import { useCallback,useEffect, useState } from 'react'

import { getPushStatus,getVAPIDKey, registerFCMToken, subscribePush, unregisterFCMToken, unsubscribePush } from '../api/pushApi'
import { log } from '../log'
import { getPlatform, isNative } from '../platform'

const STORED_FCM_TOKEN_KEY = 'fcm_token'

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from(rawData, (char) => char.charCodeAt(0))
}

export function usePushNotifications() {
  const [isSupported, setIsSupported] = useState(false)
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [permission, setPermission] = useState<NotificationPermission>('default')

  useEffect(() => {
    // Native (Capacitor): push is delivered via FCM, not Web Push. Web APIs like
    // serviceWorker/PushManager are not relevant — `useFCMNotifications` registers
    // the device automatically once permission is granted.
    if (isNative()) {
      setIsSupported(true)
      let cancelled = false
      ;(async () => {
        try {
          const { PushNotifications } = await import('@capacitor/push-notifications')
          const status = await PushNotifications.checkPermissions()
          if (cancelled) return
          const perm: NotificationPermission =
            status.receive === 'granted' ? 'granted' :
            status.receive === 'denied' ? 'denied' : 'default'
          setPermission(perm)
          setIsSubscribed(perm === 'granted' && Boolean(localStorage.getItem(STORED_FCM_TOKEN_KEY)))
        } catch (err) {
          log.error('Failed to check FCM permissions:', err)
        } finally {
          if (!cancelled) setIsLoading(false)
        }
      })()
      return () => { cancelled = true }
    }

    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
    setIsSupported(supported)

    if (!supported) {
      setIsLoading(false)
      return
    }

    setPermission(Notification.permission)

    getPushStatus()
      .then((status) => {
        setIsSubscribed(status.has_subscription)
      })
      .catch(() => {
        // Not authenticated or push not configured
      })
      .finally(() => setIsLoading(false))
  }, [])

  const subscribe = useCallback(async () => {
    if (!isSupported) return false

    try {
      setIsLoading(true)

      if (isNative()) {
        const { PushNotifications } = await import('@capacitor/push-notifications')

        const current = await PushNotifications.checkPermissions()
        let receive = current.receive
        if (receive === 'prompt' || receive === 'prompt-with-rationale') {
          const req = await PushNotifications.requestPermissions()
          receive = req.receive
        }
        const perm: NotificationPermission =
          receive === 'granted' ? 'granted' :
          receive === 'denied' ? 'denied' : 'default'
        setPermission(perm)
        if (receive !== 'granted') return false

        // Wait for FCM token from the registration listener attached by useFCMNotifications.
        // If that hook hasn't mounted yet, register here and capture the token directly.
        const token = await new Promise<string | null>((resolve) => {
          let resolved = false
          const timer = setTimeout(() => {
            if (!resolved) { resolved = true; resolve(null) }
          }, 10000)
          void PushNotifications.addListener('registration', (t) => {
            if (resolved) return
            resolved = true
            clearTimeout(timer)
            resolve(t.value)
          }).catch(() => {})
          void PushNotifications.register().catch(() => {
            if (!resolved) { resolved = true; clearTimeout(timer); resolve(null) }
          })
        })

        if (token) {
          try {
            await registerFCMToken(token, getPlatform() as 'android' | 'ios')
            localStorage.setItem(STORED_FCM_TOKEN_KEY, token)
          } catch (err) {
            log.error('Failed to register FCM token with backend:', err)
          }
        }

        setIsSubscribed(true)
        return true
      }

      const perm = await Notification.requestPermission()
      setPermission(perm)
      if (perm !== 'granted') return false

      const registration = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready

      const { vapid_public_key } = await getVAPIDKey()

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid_public_key).buffer as ArrayBuffer,
      })

      await subscribePush(subscription)
      setIsSubscribed(true)
      return true
    } catch (error) {
      log.error('Failed to subscribe to push notifications:', error)
      return false
    } finally {
      setIsLoading(false)
    }
  }, [isSupported])

  const unsubscribe = useCallback(async () => {
    try {
      setIsLoading(true)

      if (isNative()) {
        const token = localStorage.getItem(STORED_FCM_TOKEN_KEY)
        if (token) {
          try { await unregisterFCMToken(token) } catch (err) {
            log.warn('FCM backend unregister failed:', err)
          }
          localStorage.removeItem(STORED_FCM_TOKEN_KEY)
        }
        setIsSubscribed(false)
        return true
      }

      const registration = await navigator.serviceWorker.getRegistration()
      if (registration) {
        const subscription = await registration.pushManager.getSubscription()
        if (subscription) {
          await unsubscribePush(subscription.endpoint)
          await subscription.unsubscribe()
        }
      }

      setIsSubscribed(false)
      return true
    } catch (error) {
      log.error('Failed to unsubscribe from push notifications:', error)
      return false
    } finally {
      setIsLoading(false)
    }
  }, [])

  return {
    isSupported,
    isSubscribed,
    isLoading,
    permission,
    subscribe,
    unsubscribe,
  }
}
