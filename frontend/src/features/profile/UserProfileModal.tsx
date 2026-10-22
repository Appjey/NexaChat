import { useCallback,useEffect, useState } from 'react'

import { removeContact } from '../../shared/api/contactsApi'
import { endpoints } from '../../shared/api/endpoints'
import { userMessage } from '../../shared/api/errors'
import { httpGet, httpPost, resolveApiUrl } from '../../shared/api/httpClient'
import type { UserProfile } from '../../shared/api/types'
import { CloseIcon } from '../../shared/components/Icons'
import { useToast } from '../../shared/components/ToastContext'
import { publicKeyBase64 } from '../../shared/crypto/e2e'
import { getPin, keyFingerprint, type KeyPin, safetyNumber, setVerified } from '../../shared/crypto/keyPins'
import { acceptChangedKey, getChangedKey, getPeerPublicKey, KEY_CHANGED_EVENT } from '../../shared/crypto/peerKeys'
import { useAndroidBack } from '../../shared/hooks/useAndroidBack'
import { useConfirmAction } from '../../shared/hooks/useConfirmAction'
import { useModalBehavior } from '../../shared/hooks/useModalBehavior'
import { log } from '../../shared/log'
import { useAccountKey } from '../auth/AccountKey'
import { useAuthContext } from '../auth/AuthContext'

type Props = {
  isOpen: boolean
  onClose: () => void
  userId: number
  username?: string
  avatarUrl?: string | null
  isOnline?: boolean
  // Fired after the user accepts a changed key from this dialog (ChatWindow
  // uses it to refresh the thread).
  onKeyAccepted?: (userId: number) => void
}

// Everything the "Шифрование" section needs, resolved once per open.
type EncryptionInfo =
  | { kind: 'self'; fingerprint: string }
  | { kind: 'no-key' } // we or they have no E2E yet
  | {
      kind: 'peer'
      pin: KeyPin
      safety: string
      pinnedFingerprint: string
      // Set when the server currently serves a different key than the pin.
      changed: { key: string; fingerprint: string } | null
    }

export function UserProfileModal({ isOpen, onClose, userId, username, avatarUrl, isOnline, onKeyAccepted }: Props) {
  const { showToast } = useToast()
  const { handleBackdropClick } = useModalBehavior({ isOpen, onClose })
  useAndroidBack(() => { onClose(); return true }, isOpen)
  const { user } = useAuthContext()
  const accountKeyCtx = useAccountKey()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(false)
  const [addingContact, setAddingContact] = useState(false)
  const [encryption, setEncryption] = useState<EncryptionInfo | null>(null)
  const [keyEpoch, setKeyEpoch] = useState(0)
  const { confirming: confirmingRemove, startConfirm, cancelConfirm } = useConfirmAction()

  useEffect(() => {
    if (!isOpen || !userId) return

    async function loadProfile() {
      setLoading(true)
      try {
        const data = await httpGet<UserProfile>(endpoints.profile(userId))
        setProfile(data)
      } catch (err) {
        log.error('Failed to load profile:', err)
        showToast('Не удалось загрузить профиль', 'error')
      } finally {
        setLoading(false)
      }
    }

    loadProfile()
  }, [isOpen, userId, showToast])

  // Reset confirmation state when modal closes
  useEffect(() => {
    if (!isOpen) cancelConfirm()
  }, [isOpen, cancelConfirm])

  useEffect(() => {
    const bump = () => setKeyEpoch((e) => e + 1)
    window.addEventListener(KEY_CHANGED_EVENT, bump)
    return () => window.removeEventListener(KEY_CHANGED_EVENT, bump)
  }, [])

  // Resolve the encryption status: runs the peer's key through the pin store
  // (getPeerPublicKey pins on first sight / flags a change), then builds the
  // safety number from OUR pinned view of their key — never from whatever the
  // server is serving right now.
  useEffect(() => {
    if (!isOpen || !userId || !user?.id) {
      setEncryption(null)
      return
    }
    if (accountKeyCtx.state.status !== 'ready') {
      setEncryption({ kind: 'no-key' })
      return
    }
    const ownKey = accountKeyCtx.state.key
    const ownId = user.id
    let cancelled = false
    ;(async () => {
      const ownPub = await publicKeyBase64(ownKey)
      if (userId === ownId) {
        const fingerprint = await keyFingerprint(ownPub)
        if (!cancelled) setEncryption({ kind: 'self', fingerprint })
        return
      }
      await getPeerPublicKey(userId)
      const pin = getPin(userId)
      if (!pin) {
        if (!cancelled) setEncryption({ kind: 'no-key' })
        return
      }
      const changedKey = getChangedKey(userId)
      const [safety, pinnedFingerprint, changedFingerprint] = await Promise.all([
        safetyNumber({ userId: ownId, publicKey: ownPub }, { userId, publicKey: pin.publicKey }),
        keyFingerprint(pin.publicKey),
        changedKey ? keyFingerprint(changedKey) : Promise.resolve(''),
      ])
      if (cancelled) return
      setEncryption({
        kind: 'peer',
        pin,
        safety,
        pinnedFingerprint,
        changed: changedKey ? { key: changedKey, fingerprint: changedFingerprint } : null,
      })
    })().catch((err) => {
      log.warn('encryption status failed:', err)
      if (!cancelled) setEncryption({ kind: 'no-key' })
    })
    return () => { cancelled = true }
  }, [isOpen, userId, user?.id, accountKeyCtx.state, keyEpoch])

  const handleToggleVerified = () => {
    if (encryption?.kind !== 'peer') return
    const next = setVerified(userId, !encryption.pin.verified)
    if (next) setEncryption({ ...encryption, pin: next })
  }

  const handleAcceptKey = () => {
    if (encryption?.kind !== 'peer' || !encryption.changed) return
    if (acceptChangedKey(userId)) {
      showToast('Новый ключ принят. Код безопасности изменился — сверьте его заново.', 'success')
      onKeyAccepted?.(userId)
      setKeyEpoch((e) => e + 1)
    }
  }

  const handleRemoveContact = useCallback(async () => {
    if (!profile?.id) return

    try {
      await removeContact(profile.id)
      setProfile((prev) => (prev ? { ...prev, is_contact: false } : prev))
      cancelConfirm()
      showToast('Удалено из контактов', 'success')
    } catch (err) {
      showToast('Ошибка: ' + (userMessage(err, 'Не удалось удалить контакт')), 'error')
    }
  }, [profile?.id, showToast, cancelConfirm])

  const handleAddContact = async () => {
    if (!profile?.id) return

    setAddingContact(true)
    try {
      await httpPost(endpoints.contacts.add(profile.id), {})
      setProfile((prev) => (prev ? { ...prev, is_contact: true } : prev))
      showToast('Добавлено в контакты', 'success')
    } catch {
      showToast('Не удалось добавить в контакты', 'error')
    } finally {
      setAddingContact(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="profile-modal-backdrop" onClick={handleBackdropClick}>
      <div className="profile-modal user-profile-modal" role="dialog" aria-modal="true">
        <div className="profile-modal__header-actions">
          <button className="profile-modal__action-btn" onClick={onClose} aria-label="Закрыть">
            <CloseIcon />
          </button>
        </div>

        {loading ? (
          <div className="profile-modal__loading">
            <span className="text-muted">Загрузка...</span>
          </div>
        ) : (
          <>
            <div className="profile-modal__avatar-wrapper user-profile-modal__avatar-wrapper">
              <img
                src={resolveApiUrl(profile?.avatar_url || avatarUrl) || '/img/default-avatar.svg'}
                alt="avatar"
                className="profile-modal__avatar"
              />
            </div>

            <div className="profile-modal__info">
              <h2 className="profile-modal__name">{profile?.name || username}</h2>
              <span className="profile-modal__username">@{profile?.username || username}</span>
              {isOnline !== undefined && (
                <div className="user-profile-modal__status">
                  <span className={`dot ${isOnline ? 'online' : 'offline'}`} />
                  <span>{isOnline ? 'В сети' : 'Не в сети'}</span>
                </div>
              )}
            </div>

            {profile && !profile.is_contact && (
              <div className="profile-modal__actions">
                <button
                  className="btn btn-primary"
                  onClick={handleAddContact}
                  disabled={addingContact}
                >
                  {addingContact ? 'Добавление...' : 'Добавить в контакты'}
                </button>
              </div>
            )}

            {profile?.is_contact && (
              confirmingRemove ? (
                <div className="user-profile-modal__confirm-remove">
                  <span className="user-profile-modal__confirm-text">Удалить из контактов?</span>
                  <div className="user-profile-modal__confirm-actions">
                    <button
                      onClick={handleRemoveContact}
                      className="contact-card__confirm-btn contact-card__confirm-btn--delete"
                    >
                      Удалить
                    </button>
                    <button
                      onClick={cancelConfirm}
                      className="contact-card__confirm-btn contact-card__confirm-btn--cancel"
                    >
                      Отмена
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  className="user-profile-modal__contact-badge user-profile-modal__contact-badge--clickable"
                  onClick={startConfirm}
                  role="button"
                  tabIndex={0}
                  title="Нажмите, чтобы удалить из контактов"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                  <span>В контактах</span>
                </div>
              )
            )}

            {encryption?.kind === 'self' && (
              <div className="e2e-section">
                <div className="e2e-section__title">🔐 Шифрование</div>
                <div>Отпечаток вашего ключа:</div>
                <div className="e2e-section__fp">{encryption.fingerprint}</div>
              </div>
            )}

            {encryption?.kind === 'no-key' && (
              <div className="e2e-section">
                <div className="e2e-section__title">🔐 Шифрование</div>
                <div className="e2e-section__hint">Ключ собеседника пока не получен — код безопасности появится после первого обмена сообщениями.</div>
              </div>
            )}

            {encryption?.kind === 'peer' && (
              <div className="e2e-section">
                <div className="e2e-section__title">🔐 Шифрование</div>
                {encryption.changed ? (
                  <div className="e2e-section__status e2e-section__status--danger">
                    ⚠️ Сервер прислал другой ключ для этого пользователя. Сверьте код безопасности
                    лично, прежде чем принимать его.
                    <div className="e2e-section__hint">
                      Был: <span className="e2e-section__fp">{encryption.pinnedFingerprint}</span>
                      <br />
                      Новый: <span className="e2e-section__fp">{encryption.changed.fingerprint}</span>
                    </div>
                  </div>
                ) : encryption.pin.verified ? (
                  <div className="e2e-section__status e2e-section__status--ok">✓ Код безопасности сверен</div>
                ) : (
                  <div className="e2e-section__status">Ключ запомнен при первом контакте, не сверен</div>
                )}
                <div>Код безопасности:</div>
                <div className="e2e-section__number">{encryption.safety}</div>
                <div className="e2e-section__hint">
                  Откройте этот экран у собеседника: код должен совпадать до последней цифры.
                  Если нет, кто-то подменил ключ.
                </div>
                <div className="e2e-section__actions">
                  {encryption.changed ? (
                    <button type="button" className="btn btn-sm btn-danger" onClick={handleAcceptKey}>
                      Принять новый ключ
                    </button>
                  ) : (
                    <button type="button" className="btn btn-sm btn-outline-secondary" onClick={handleToggleVerified}>
                      {encryption.pin.verified ? 'Снять отметку «сверен»' : 'Отметить как сверенный'}
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
