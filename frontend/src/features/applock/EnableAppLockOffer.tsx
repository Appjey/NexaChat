import { useEffect, useState } from 'react'

import { markOffered, wasOffered } from '../../shared/appLock'
import { useAuthContext } from '../auth/AuthContext'
import { useAppLock } from './AppLockContext'

/**
 * One-time post-login offer to turn the biometric app-lock on (spec: спросить
 * сразу после первого входа). Also shown once to accounts that were already
 * logged in before the feature shipped — for them "после входа" is the first
 * launch of the updated build. Declining (or cancelling the system prompt)
 * marks the offer as seen; the switch stays available in Настройки →
 * Конфиденциальность.
 */
export function EnableAppLockOffer() {
  const { user, loading } = useAuthContext()
  const { enabled, biometricsAvailable, enable } = useAppLock()
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (loading || !user || enabled || !biometricsAvailable || wasOffered()) return
    setVisible(true)
  }, [loading, user, enabled, biometricsAvailable])

  if (!visible) return null

  const dismiss = () => {
    markOffered()
    setVisible(false)
  }

  const handleEnable = async () => {
    setBusy(true)
    try {
      await enable() // user cancelled the prompt == declined the offer
    } finally {
      dismiss()
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--bg-scrim, rgba(13, 16, 23, 0.72))',
        backdropFilter: 'blur(4px)',
        zIndex: 9998,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-color)',
          color: 'var(--text-primary)',
          borderRadius: 16,
          padding: '24px 28px',
          maxWidth: 420,
          width: '100%',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <h3 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-display)' }}>Быстрый вход</h3>
        <p style={{ margin: '0 0 16px', fontSize: 14, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
          Включить вход по биометрии? Приложение будет автоматически блокироваться в фоне,
          а для входа достаточно отпечатка или лица. Настроить можно в «Конфиденциальность».
        </p>
        <button
          type="button"
          className="btn btn-primary w-100"
          disabled={busy}
          onClick={() => void handleEnable()}
          style={{ marginBottom: 8 }}
        >
          {busy ? 'Подтверждение…' : 'Включить'}
        </button>
        <button type="button" className="btn btn-outline-secondary w-100" disabled={busy} onClick={dismiss}>
          Не сейчас
        </button>
      </div>
    </div>
  )
}
