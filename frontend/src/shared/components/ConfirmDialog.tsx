import { useEffect, useRef } from 'react'

import { useAndroidBack } from '../hooks/useAndroidBack'
import { useModalBehavior } from '../hooks/useModalBehavior'

type Variant = 'danger' | 'default'

type Props = {
  isOpen: boolean
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: Variant
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Отмена',
  variant = 'default',
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const { handleBackdropClick } = useModalBehavior({
    isOpen,
    onClose: onCancel,
    containerRef: dialogRef,
    trapFocus: true,
  })
  useAndroidBack(() => { onCancel(); return true }, isOpen)

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !busy && !(e.target instanceof HTMLButtonElement)) {
        onConfirm()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, busy, onConfirm])

  if (!isOpen) return null

  return (
    <div className="confirm-dialog__backdrop" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <h3 id="confirm-dialog-title" className="confirm-dialog__title">{title}</h3>
        {message && <p className="confirm-dialog__message">{message}</p>}
        <div className="confirm-dialog__actions">
          <button
            type="button"
            className="confirm-dialog__btn confirm-dialog__btn--cancel"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`confirm-dialog__btn confirm-dialog__btn--confirm${variant === 'danger' ? ' confirm-dialog__btn--danger' : ''}`}
            onClick={onConfirm}
            disabled={busy}
            autoFocus
          >
            {busy ? '...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
