import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'

import { useAccountKey } from '../features/auth/AccountKey'
import { useAuthContext } from '../features/auth/AuthContext'
import { bootstrapVaultOnLogin } from '../features/auth/vaultBootstrap'
import { endpoints } from '../shared/api/endpoints'
import { userMessage } from '../shared/api/errors'
import { httpPost, setAuthToken } from '../shared/api/httpClient'
import type { AuthLoginResponse } from '../shared/api/types'
import { log } from '../shared/log'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const navigate = useNavigate()
  const { user, loading, refreshProfile } = useAuthContext()
  const accountKeyCtx = useAccountKey()

  // Already authenticated — redirect to chats
  if (!loading && user) {
    return <Navigate to="/" replace />
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await httpPost<AuthLoginResponse>(endpoints.auth.login, { username, password })
      setAuthToken(res.token)

      // Establish the E2E account_key from the password the user just typed. This is
      // the only moment in the session we have access to the password, so it has to
      // happen here (not later in useAuth's refreshProfile path which has no password).
      // Failures here don't block login — LazyVaultModal asks for the password again.
      try {
        const key = await bootstrapVaultOnLogin(password, res)
        if (key) accountKeyCtx.setKey(key)
      } catch (e2eErr) {
        log.error('E2E vault bootstrap failed; the lazy vault modal will retry:', e2eErr)
      }

      await refreshProfile()
      navigate('/')
    } catch (err) {
      setError(userMessage(err, 'Ошибка входа'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-centered">
      <div className="auth-card">
        <div className="auth-card__header">
          <span className="brand-text-lg">Nothing</span>
          <p className="auth-card__subtitle">Войдите в аккаунт</p>
        </div>

        {error && (
          <div className="auth-error">
            {error}
          </div>
        )}

        <form className="auth-card__form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="username">Имя пользователя</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="username"
              required
              autoFocus
              autoComplete="username"
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Пароль</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              required
              autoComplete="current-password"
            />
          </div>

          <button type="submit" className="auth-card__submit" disabled={submitting}>
            {submitting ? 'Вход...' : 'Войти'}
          </button>
        </form>

        <div className="auth-card__footer">
          <span>Нет аккаунта?</span>
          <Link to="/register">Создать</Link>
        </div>
      </div>
    </div>
  )
}
