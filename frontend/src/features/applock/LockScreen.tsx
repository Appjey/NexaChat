import { useCallback, useEffect, useRef, useState } from 'react'

import { endpoints } from '../../shared/api/endpoints'
import { isApiStatus, userMessage } from '../../shared/api/errors'
import { httpPost, setAuthToken } from '../../shared/api/httpClient'
import type { AuthLoginResponse } from '../../shared/api/types'
import { openVault, saveAccountKey } from '../../shared/crypto/e2e'
import { biometricAuthenticate } from '../../shared/nativeBiometric'
import { useAccountKey } from '../auth/AccountKey'
import { useAuthContext } from '../auth/AuthContext'
import { bootstrapVaultOnLogin } from '../auth/vaultBootstrap'
import { useAppLock } from './AppLockContext'

/**
 * Opaque full-screen gate shown while the app is locked. The biometric
 * prompt fires automatically on mount (the default unlock path); the
 * password form is the fallback.
 *
 * Password verification is offline-first: the cached /me profile carries
 * vault_salt + encrypted_account_key, so openVault() both proves the
 * password and re-derives the account_key without a network round trip.
 * Sessions predating the E2E vault fall back to an online re-login, same
 * as LazyVaultModal.
 */
export function LockScreen() {
  const { unlock, enabled } = useAppLock()
  const { user, logout } = useAuthContext()
  const accountKeyCtx = useAccountKey()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const promptedRef = useRef(false)

  const tryBiometric = useCallback(async () => {
    setError(null)
    const verified = await biometricAuthenticate('NexaChat заблокирован', 'Подтвердите личность для входа')
    if (verified) unlock()
  }, [unlock])

  // Spec: запрашивать биометрию сразу при показе экрана. Ref-guarded so dev
  // StrictMode's double effect doesn't stack two system prompts.
  useEffect(() => {
    if (!enabled || promptedRef.current) return
    promptedRef.current = true
    void tryBiometric()
  }, [enabled, tryBiometric])

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user || !password || busy) return
    setBusy(true)
    setError(null)
    try {
      if (user.vault_salt && user.encrypted_account_key) {
        // Throws on a wrong password — the vault won't unwrap.
        const key = await openVault(password, {
          vaultSalt: user.vault_salt,
          encryptedAccountKey: user.encrypted_account_key,
        })
        accountKeyCtx.setKey(await saveAccountKey(key))
      } else {
        const res = await httpPost<AuthLoginResponse>(endpoints.auth.login, {
          username: user.username,
          password,
        })
        setAuthToken(res.token)
        const key = await bootstrapVaultOnLogin(password, res)
        if (key) accountKeyCtx.setKey(key)
      }
      setPassword('')
      unlock()
    } catch (err) {
      const msg = userMessage(err, err instanceof Error ? err.message : String(err))
      if (isApiStatus(err, 401)) {
        setError('Неверный пароль.')
      } else if (user.vault_salt && user.encrypted_account_key) {
        // openVault has exactly one failure mode for a healthy vault.
        setError('Неверный пароль.')
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  const handleLogout = async () => {
    if (busy) return
    setBusy(true)
    try {
      await logout()
    } finally {
      // logout cleared the app-lock prefs (useAuth); drop the gate so the
      // login page underneath becomes reachable.
      unlock()
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        // Opaque on purpose: the app stays mounted underneath and must not
        // shine through.
        background: 'var(--bg-primary, #0D1017)',
        color: 'var(--text-primary, #F2F4FA)',
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          maxWidth: 380,
          width: '100%',
          textAlign: 'center',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-color)',
          borderRadius: 16,
          padding: '28px 24px',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <h1 style={{ fontSize: 28, fontWeight: 700, fontFamily: 'var(--font-display)', marginBottom: 8 }}>NexaChat</h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 24 }}>
          Приложение заблокировано
        </p>

        <button
          type="button"
          onClick={() => void tryBiometric()}
          disabled={busy}
          className="btn btn-primary w-100"
          style={{ marginBottom: 20 }}
        >
          Войти по биометрии
        </button>

        <form onSubmit={handlePasswordSubmit}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Пароль"
            disabled={busy}
            className="form-control"
            style={{ marginBottom: 12 }}
          />
          {error && <div style={{ color: 'var(--color-danger)', fontSize: 13, marginBottom: 12 }}>{error}</div>}
          <button type="submit" disabled={busy || !password} className="btn btn-outline-secondary w-100">
            {busy ? 'Проверка…' : 'Войти по паролю'}
          </button>
        </form>

        <button
          type="button"
          onClick={() => void handleLogout()}
          disabled={busy}
          className="btn btn-link btn-sm"
          style={{ marginTop: 24, color: 'var(--text-secondary)' }}
        >
          Выйти из аккаунта
        </button>
      </div>
    </div>
  )
}
