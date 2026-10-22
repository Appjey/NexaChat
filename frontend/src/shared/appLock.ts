// App-lock settings + timing logic (the biometric/password gate UI lives in
// features/applock/). Android-only feature; on other platforms every check
// below answers "not locked".
//
// What the lock is: a UI gate against casual access by someone holding the
// unlocked phone — the same promise Telegram's passcode lock makes. It is
// NOT a cryptographic boundary: the account_key stays in app storage either
// way (see the threat model note in shared/crypto/e2e.ts). The password
// fallback doubles as an honest check though — it re-unwraps the E2E vault.
//
// Storage mirrors the auth-token dance in httpClient.ts: localStorage is the
// synchronous source of truth for boot-time decisions, Capacitor Preferences
// is the durable mirror hydrated back in main.tsx before first render — so
// the "lock on cold start" decision never flashes unlocked content.

import { log } from './log'
import { getPlatform } from './platform'

const KEY_ENABLED = 'app_lock_enabled'
const KEY_TIMEOUT = 'app_lock_timeout_ms'
const KEY_LAST_ACTIVE = 'app_lock_last_active_at'
const KEY_OFFERED = 'app_lock_offered'

const MIRRORED_KEYS = [KEY_ENABLED, KEY_TIMEOUT, KEY_LAST_ACTIVE, KEY_OFFERED]

export const DEFAULT_TIMEOUT_MS = 5 * 60_000

export const TIMEOUT_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Сразу' },
  { value: 60_000, label: 'Через 1 минуту' },
  { value: 5 * 60_000, label: 'Через 5 минут' },
  { value: 15 * 60_000, label: 'Через 15 минут' },
  { value: 60 * 60_000, label: 'Через 1 час' },
]

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // localStorage unavailable — the Preferences mirror still works
  }
  void (async () => {
    try {
      const { Capacitor } = await import('@capacitor/core')
      if (!Capacitor.isNativePlatform()) return
      const { Preferences } = await import('@capacitor/preferences')
      if (value === null) await Preferences.remove({ key })
      else await Preferences.set({ key, value })
    } catch (err) {
      log.warn('appLock: failed to mirror to Preferences:', err)
    }
  })()
}

/** Preferences → localStorage at boot, before the first render. */
export async function hydrateAppLockPrefs(): Promise<void> {
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (!Capacitor.isNativePlatform()) return
    const { Preferences } = await import('@capacitor/preferences')
    for (const key of MIRRORED_KEYS) {
      const { value } = await Preferences.get({ key })
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    }
  } catch (err) {
    log.warn('appLock: hydrate failed:', err)
  }
}

export function isAppLockEnabled(): boolean {
  return getPlatform() === 'android' && read(KEY_ENABLED) === '1'
}

export function setAppLockEnabled(enabled: boolean) {
  write(KEY_ENABLED, enabled ? '1' : null)
  if (enabled && read(KEY_TIMEOUT) === null) {
    write(KEY_TIMEOUT, String(DEFAULT_TIMEOUT_MS))
  }
}

export function getAppLockTimeoutMs(): number {
  const raw = Number(read(KEY_TIMEOUT))
  return Number.isFinite(raw) && raw >= 0 && read(KEY_TIMEOUT) !== null ? raw : DEFAULT_TIMEOUT_MS
}

export function setAppLockTimeoutMs(ms: number) {
  write(KEY_TIMEOUT, String(ms))
}

/** Записывается при уходе в фон и при разблокировке. */
export function recordLastActive(now = Date.now()) {
  write(KEY_LAST_ACTIVE, String(now))
}

/**
 * Logout scrub. The lock is device-level state for the CURRENT account: a
 * new login must not be unlockable by whoever enrolled biometrics for the
 * previous one, and the new account should get the enable-offer again.
 */
export function clearAppLockOnLogout() {
  write(KEY_ENABLED, null)
  write(KEY_LAST_ACTIVE, null)
  write(KEY_OFFERED, null)
  write(KEY_TIMEOUT, null)
}

export function wasOffered(): boolean {
  return read(KEY_OFFERED) === '1'
}

export function markOffered() {
  write(KEY_OFFERED, '1')
}

/**
 * Pure decision: should the app present the lock screen?
 * No record of the last active moment (fresh enable, cleared storage) counts
 * as expired — failing locked is the safe direction for a lock.
 */
export function isLockExpired(lastActiveRaw: string | null, timeoutMs: number, now: number): boolean {
  const lastActive = Number(lastActiveRaw)
  if (lastActiveRaw === null || !Number.isFinite(lastActive)) return true
  return now - lastActive >= timeoutMs
}

/** Convenience used at cold start and on appStateChange→active. */
export function shouldLockNow(now = Date.now()): boolean {
  if (!isAppLockEnabled()) return false
  return isLockExpired(read(KEY_LAST_ACTIVE), getAppLockTimeoutMs(), now)
}
