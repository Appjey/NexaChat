import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'

import { useAccountKey } from '../features/auth/AccountKey'
import { useAuthContext } from '../features/auth/AuthContext'
import { bootstrapVaultOnLogin } from '../features/auth/vaultBootstrap'
import { endpoints } from '../shared/api/endpoints'
import { userMessage } from '../shared/api/errors'
import { httpPost, setAuthToken } from '../shared/api/httpClient'
import type { AuthRegisterResponse } from '../shared/api/types'
import { log } from '../shared/log'

export default function RegisterPage() {
  const [username, setUsername] = useState('')
  const [name, setName] = useState('')
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

    const trimmedName = name.trim()
    if (trimmedName.length < 2) {
      setError('Имя должно содержать минимум 2 символа (без учёта пробелов)')
      setSubmitting(false)
      return
    }
    if (password.trim().length === 0) {
      setError('Пароль не может состоять только из пробелов')
      setSubmitting(false)
      return
    }

    try {
      const res = await httpPost<AuthRegisterResponse>(endpoints.auth.register, {
        username,
        name: trimmedName,
        password,
      })
      setAuthToken(res.token)

      // First login of this account — server has no vault material yet, so this
      // path always generates a fresh account_key, encrypts it under the new
      // password, and uploads. Failures are non-fatal: registration succeeded,
      // LazyVaultModal prompts for the password again until the key exists.
      try {
        const key = await bootstrapVaultOnLogin(password, res)
        if (key) accountKeyCtx.setKey(key)
      } catch (e2eErr) {
        log.error('E2E vault setup failed during registration:', e2eErr)
      }

      await refreshProfile()
      navigate('/')
    } catch (err) {
      setError(userMessage(err, 'Ошибка регистрации'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-centered">
      <div className="auth-card">
        <div className="auth-card__header">
          <span className="brand-text-lg">NexaChat</span>
          <p className="auth-card__subtitle">Создайте аккаунт</p>
        </div>

        {error && (
          <div className="auth-error">
            {error}
          </div>
        )}

        <form className="auth-card__form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="username"
              required
              minLength={3}
              maxLength={20}
              autoFocus
              autoComplete="username"
            />
          </div>

          <div className="form-group">
            <label htmlFor="name">Имя</label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Как вас зовут"
              required
              minLength={2}
              maxLength={50}
              autoComplete="name"
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Пароль</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Минимум 8 символов"
              required
              minLength={8}
              autoComplete="new-password"
            />
          </div>

          <button type="submit" className="auth-card__submit" disabled={submitting}>
            {submitting ? 'Создаём...' : 'Создать аккаунт'}
          </button>
        </form>

        <div className="auth-card__footer">
          <span>Уже есть аккаунт?</span>
          <Link to="/login">Войти</Link>
        </div>
      </div>
    </div>
  )
}
