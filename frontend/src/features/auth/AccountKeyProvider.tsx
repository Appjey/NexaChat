import { type ReactNode,useCallback, useEffect, useState } from 'react'

import {
  clearStoredAccountKey,
  hydrateAccountKey,
  loadStoredAccountKey,
} from '../../shared/crypto/e2e'
import { log } from '../../shared/log'
import {
  AccountKeyContext,
  type AccountKeyState,
} from './AccountKey'

/**
 * Hydrates the E2E account_key on app boot (Capacitor Preferences → localStorage,
 * then importKey) and exposes it to descendants via AccountKeyContext.
 *
 * Sits above AuthProvider in main.tsx so the login flow can call `setKey()` as soon
 * as it has the password + vault material.
 */
export function AccountKeyProvider({ children }: { children: ReactNode }) {
  // Initial state is 'loading' — the boot-time hydrate kicks off in the effect below.
  // Initializing here (rather than setState'ing inside the effect) keeps lint happy
  // and avoids an extra render between mount and the async work starting.
  const [state, setState] = useState<AccountKeyState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await hydrateAccountKey()
        const key = await loadStoredAccountKey()
        if (cancelled) return
        setState(key ? { status: 'ready', key } : { status: 'missing' })
      } catch (err) {
        log.error('Failed to load account_key:', err)
        if (!cancelled) setState({ status: 'missing' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const setKey = useCallback((key: CryptoKey | null) => {
    setState(key ? { status: 'ready', key } : { status: 'missing' })
  }, [])

  const clear = useCallback(async () => {
    await clearStoredAccountKey()
    setState({ status: 'missing' })
  }, [])

  return (
    <AccountKeyContext.Provider value={{ state, setKey, clear }}>
      {children}
    </AccountKeyContext.Provider>
  )
}
