import { type FormEvent, useState } from 'react'

import { endpoints } from '../../shared/api/endpoints'
import { userMessage } from '../../shared/api/errors'
import { httpPut } from '../../shared/api/httpClient'
import { openVault, publicKeyBase64, rewrapAccountKey } from '../../shared/crypto/e2e'
import { log } from '../../shared/log'
import { useAccountKey } from '../auth/AccountKey'
import { useAuthContext } from '../auth/AuthContext'
import { putVault } from '../auth/vaultBootstrap'

type Status = 'idle' | 'loading' | 'success' | 'error'

export function ChangePasswordForm() {
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const accountKeyCtx = useAccountKey()
  const { user } = useAuthContext()

  const canSubmit =
    status !== 'loading' &&
    oldPassword.length > 0 &&
    newPassword.length >= 8 &&
    newPassword === confirmPassword

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSubmit) return

    setStatus('loading')
    setErrorMessage('')

    try {
      await httpPut(endpoints.auth.changePassword, {
        old_password: oldPassword,
        new_password: newPassword,
      })

      // E2E: re-wrap the in-memory account_key under the new password and push the
      // new vault material to the server. The account_key itself doesn't rotate —
      // that would orphan every existing scheme=2 message — only the password-derived
      // wrapper around it. Failure here is non-fatal (password is changed, user just
      // needs to be aware their vault still points at the old password; we surface
      // it so they can retry).
      if (accountKeyCtx.state.status === 'ready') {
        try {
          // Re-open the vault with the old password: on the web the in-memory
          // key is a non-extractable X25519 half, so the raw account_key is
          // only reachable through the password (the server just verified it).
          if (!user?.vault_salt || !user.encrypted_account_key) {
            throw new Error('vault material missing from profile')
          }
          const accountKey = await openVault(oldPassword, {
            vaultSalt: user.vault_salt,
            encryptedAccountKey: user.encrypted_account_key,
          })
          const newVault = await rewrapAccountKey(accountKey, newPassword)
          // public_key is deterministic from account_key, which doesn't rotate on
          // password change — but the API contract requires all three fields on
          // every vault write, so we recompute and include it.
          const pub = await publicKeyBase64(accountKeyCtx.state.key)
          await putVault({ ...newVault, publicKey: pub })
        } catch (vaultErr) {
          log.error('vault rewrap failed:', vaultErr)
          setStatus('error')
          setErrorMessage(
            'Пароль изменён, но не удалось обновить ключ шифрования. Войдите заново.',
          )
          return
        }
      }

      setStatus('success')
      setOldPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setTimeout(() => setStatus('idle'), 3000)
    } catch (err) {
      setStatus('error')
      setErrorMessage(userMessage(err, 'Не удалось сменить пароль'))
    }
  }

  return (
    <form className="change-password-form" onSubmit={handleSubmit}>
      <div className="change-password-form__field">
        <label htmlFor="old-password">Текущий пароль</label>
        <input
          id="old-password"
          type="password"
          className="form-control"
          value={oldPassword}
          onChange={(e) => setOldPassword(e.target.value)}
          autoComplete="current-password"
          disabled={status === 'loading'}
        />
      </div>

      <div className="change-password-form__field">
        <label htmlFor="new-password">Новый пароль</label>
        <input
          id="new-password"
          type="password"
          className="form-control"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          minLength={8}
          autoComplete="new-password"
          disabled={status === 'loading'}
        />
      </div>

      <div className="change-password-form__field">
        <label htmlFor="confirm-password">Подтвердите пароль</label>
        <input
          id="confirm-password"
          type="password"
          className="form-control"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          minLength={8}
          autoComplete="new-password"
          disabled={status === 'loading'}
        />
        {confirmPassword.length > 0 && newPassword !== confirmPassword && (
          <span className="change-password-form__hint">Пароли не совпадают</span>
        )}
      </div>

      {status === 'error' && (
        <div className="change-password-form__error">{errorMessage}</div>
      )}
      {status === 'success' && (
        <div className="change-password-form__success">Пароль успешно изменён</div>
      )}

      <button
        type="submit"
        className="btn btn-sm btn-primary change-password-form__submit"
        disabled={!canSubmit}
      >
        {status === 'loading' ? 'Сохранение...' : 'Сменить пароль'}
      </button>
    </form>
  )
}
