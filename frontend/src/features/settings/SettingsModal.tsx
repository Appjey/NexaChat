import { useCallback, useState } from 'react'

import { ArrowLeftIcon, BellIcon, CloseIcon, LockIcon, PaletteIcon } from '../../shared/components/Icons'
import { PushToggle } from '../../shared/components/PushToggle'
import { useAndroidBack } from '../../shared/hooks/useAndroidBack'
import { useModalBehavior } from '../../shared/hooks/useModalBehavior'
import { useTheme } from '../../shared/hooks/useTheme'
import { getPlatform } from '../../shared/platform'
import { AppLockSettings } from '../applock/AppLockSettings'
import { ChangePasswordForm } from './ChangePasswordForm'
import { PersonalizationSettings } from './PersonalizationSettings'

type SettingsView = 'main' | 'personalization' | 'notifications' | 'security'

const viewTitles: Record<SettingsView, string> = {
  main: 'Настройки',
  personalization: 'Оформление и звук',
  notifications: 'Уведомления',
  security: 'Конфиденциальность',
}

type Props = {
  isOpen: boolean
  onClose: () => void
}

export function SettingsModal({ isOpen, onClose }: Props) {
  const [activeView, setActiveView] = useState<SettingsView>('main')
  const { accountPrefs, saveAccountPrefs } = useTheme()

  const closeModal = useCallback(() => {
    setActiveView('main')
    onClose()
  }, [onClose])

  const handleEscape = useCallback(() => {
    if (activeView !== 'main') {
      setActiveView('main')
    } else {
      closeModal()
    }
  }, [activeView, closeModal])

  const { handleBackdropClick } = useModalBehavior({ isOpen, onClose: handleEscape })
  useAndroidBack(() => {
    handleEscape()
    return true
  }, isOpen)

  if (!isOpen) return null

  return (
    <div className="settings-modal-backdrop" onClick={handleBackdropClick}>
      <div
        className={`settings-modal${activeView === 'personalization' ? ' settings-modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
      >
        <div className="settings-modal__header">
          {activeView !== 'main' ? (
            <button
              className="settings-modal__close"
              onClick={() => setActiveView('main')}
              aria-label="Назад"
            >
              <ArrowLeftIcon size={20} />
            </button>
          ) : (
            <div />
          )}
          <h2 className="settings-modal__title">{viewTitles[activeView]}</h2>
          <button className="settings-modal__close" onClick={closeModal} aria-label="Закрыть">
            <CloseIcon />
          </button>
        </div>

        <div className="settings-modal__content">
          {activeView === 'main' && (
            <div className="settings-modal__list">
              <button
                className="settings-modal__list-item"
                onClick={() => setActiveView('personalization')}
              >
                <span className="settings-modal__list-icon">
                  <PaletteIcon size={20} />
                </span>
                <span>Персонализация</span>
              </button>

              <button
                className="settings-modal__list-item"
                onClick={() => setActiveView('notifications')}
              >
                <span className="settings-modal__list-icon">
                  <BellIcon size={20} />
                </span>
                <span>Уведомления</span>
              </button>

              <button
                className="settings-modal__list-item"
                onClick={() => setActiveView('security')}
              >
                <span className="settings-modal__list-icon">
                  <LockIcon size={20} />
                </span>
                <span>Конфиденциальность</span>
              </button>
            </div>
          )}

          {activeView === 'personalization' && <PersonalizationSettings />}

          {activeView === 'notifications' && (
            <div className="settings-modal__section">
              <div className="settings-modal__option">
                <span className="settings-modal__option-label">Push-уведомления</span>
                <PushToggle placeholderClass="settings-modal__placeholder" />
              </div>
              <div className="settings-modal__option">
                <span className="settings-modal__option-label">Звук уведомлений в чатах</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={accountPrefs.notifications_enabled}
                  aria-label="Звук уведомлений в чатах"
                  className={`pz-switch${accountPrefs.notifications_enabled ? ' pz-switch--on' : ''}`}
                  onClick={() => {
                    void saveAccountPrefs({
                      notifications_enabled: !accountPrefs.notifications_enabled,
                    })
                  }}
                >
                  <span className="pz-switch__thumb" />
                </button>
              </div>
            </div>
          )}

          {activeView === 'security' && (
            <div className="settings-modal__section">
              {getPlatform() === 'android' && (
                <>
                  <h3 className="settings-modal__group-title">Блокировка приложения</h3>
                  <AppLockSettings />
                  <div className="settings-modal__divider" />
                </>
              )}
              <h3 className="settings-modal__group-title">Смена пароля</h3>
              <ChangePasswordForm />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
