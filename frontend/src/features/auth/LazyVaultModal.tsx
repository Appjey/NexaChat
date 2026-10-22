import { useState } from 'react'

import { endpoints } from '../../shared/api/endpoints'
import { isApiStatus, userMessage } from '../../shared/api/errors'
import { httpPost, setAuthToken } from '../../shared/api/httpClient'
import type { AuthLoginResponse } from '../../shared/api/types'
import { isWebBrowser } from '../../shared/platform'
import { useAccountKey } from './AccountKey'
import { useAuthContext } from './AuthContext'
import { bootstrapVaultOnLogin } from './vaultBootstrap'

/**
 * Non-dismissable modal shown when a logged-in user has no E2E account_key
 * on this device. Reasons this can happen:
 *
 *   - User logged in *before* the E2E rollout (their JWT is still valid;
 *     bootstrapVaultOnLogin never ran for them).
 *   - User cleared site data on this device but their JWT survived in a
 *     mirrored Capacitor Preferences token.
 *   - Bootstrap failed previously (network glitch, WebCrypto error).
 *
 * In every case the fix is the same: ask for the password (the only secret
 * we don't have), run the same login flow that new users go through, which
 * either unwraps an existing vault or mints a fresh one. The new JWT
 * replaces the old (harmless, they're both for the same user).
 *
 * Once the bootstrap succeeds the AccountKey state flips to 'ready' and the
 * modal unmounts.
 */
export function LazyVaultModal() {
  const { user, refreshProfile } = useAuthContext()
  const accountKeyCtx = useAccountKey()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user || !password) return
    setBusy(true)
    setError(null)
    try {
      const res = await httpPost<AuthLoginResponse>(endpoints.auth.login, {
        username: user.username,
        password,
      })
      setAuthToken(res.token)
      const key = await bootstrapVaultOnLogin(password, res)
      if (!key) {
        throw new Error('Не удалось активировать шифрование на этом устройстве.')
      }
      accountKeyCtx.setKey(key)
      // Refresh profile so the rest of the app sees the now-populated public_key.
      await refreshProfile()
    } catch (err) {
      const msg = userMessage(err, err instanceof Error ? err.message : String(err))
      // The login endpoint returns 401 for wrong password — surface that
      // specifically so the user doesn't think the whole system is broken.
      if (isApiStatus(err, 401)) {
        setError('Неверный пароль.')
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  if (!user) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.7)',
        backdropFilter: 'blur(4px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          background: '#1e1e1e',
          borderRadius: 12,
          padding: '24px 28px',
          maxWidth: 420,
          width: '100%',
          color: '#fff',
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.5)',
        }}
      >
        <h3 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 600 }}>
          🔒 Активация шифрования
        </h3>
        <p style={{ margin: '0 0 16px', fontSize: 14, lineHeight: 1.5, color: '#bbb' }}>
          Для безопасной переписки нужно активировать сквозное шифрование на этом
          устройстве. Введите ваш пароль ещё раз —{' '}
          {isWebBrowser()
            ? 'в браузере ключ хранится только до закрытия окна, в приложении его просить не будут.'
            : 'это нужно сделать только один раз.'}
        </p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Пароль"
          autoFocus
          disabled={busy}
          style={{
            width: '100%',
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid #444',
            background: '#2a2a2a',
            color: '#fff',
            fontSize: 14,
            boxSizing: 'border-box',
            marginBottom: 12,
          }}
        />
        {error && (
          <div style={{ color: '#f66', fontSize: 13, marginBottom: 12 }}>{error}</div>
        )}
        <button
          type="submit"
          disabled={busy || !password}
          style={{
            width: '100%',
            padding: '10px 16px',
            borderRadius: 8,
            border: 'none',
            background: busy || !password ? '#444' : '#3b82f6',
            color: '#fff',
            fontSize: 14,
            fontWeight: 500,
            cursor: busy || !password ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? 'Активация…' : 'Активировать'}
        </button>
      </form>
    </div>
  )
}
