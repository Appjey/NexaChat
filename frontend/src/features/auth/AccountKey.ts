import { createContext, useContext } from 'react'

/**
 * Live E2E account_key state shared across the app.
 *
 *   - 'loading' : initial — the provider is still trying to hydrate the key from
 *                 Capacitor Preferences / localStorage. Render nothing E2E-related yet.
 *   - 'ready'   : accountKey is in memory; encrypt/decrypt can proceed.
 *   - 'missing' : no key found on disk. Either the user has never logged in or they
 *                 cleared storage. Sending is blocked (composer disabled) until the
 *                 next login refills the key; incoming scheme=2 messages render
 *                 as a placeholder.
 */
export type AccountKeyState =
  | { status: 'loading' }
  | { status: 'ready'; key: CryptoKey }
  | { status: 'missing' }

export type AccountKeyContextValue = {
  state: AccountKeyState
  /** Replace the in-memory key. Called by useAuth after a successful login. */
  setKey: (key: CryptoKey | null) => void
  /** Wipe the key from memory and on-disk storage (called on logout). */
  clear: () => Promise<void>
}

export const AccountKeyContext = createContext<AccountKeyContextValue | null>(null)

export function useAccountKey(): AccountKeyContextValue {
  const ctx = useContext(AccountKeyContext)
  if (!ctx) throw new Error('useAccountKey must be used inside AccountKeyProvider')
  return ctx
}
