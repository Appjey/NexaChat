import { userMessage } from '../../shared/api/errors'
import { CloseIcon } from '../../shared/components/Icons'
import { useToast } from '../../shared/components/ToastContext'
import { useAndroidBack } from '../../shared/hooks/useAndroidBack'
import { useModalBehavior } from '../../shared/hooks/useModalBehavior'
import { useTheme } from '../../shared/hooks/useTheme'
import {
  getThemePreset,
  getWallpaperPreset,
  playSoundTone,
  SOUND_PRESETS,
  THEME_PRESETS,
  WALLPAPER_PRESETS,
} from '../../shared/preferences/catalog'
import {
  defaultChatPreferences,
  hasPersonalChatOverrides,
} from '../../shared/preferences/resolver'
import type {
  FieldPatch,
  PreferenceValueMode,
} from '../../shared/preferences/types'

type Props = {
  isOpen: boolean
  chatId: number
  chatTitle: string
  onClose: () => void
}

export function ChatPersonalizationModal({ isOpen, chatId, chatTitle, onClose }: Props) {
  const {
    theme,
    chatOverrides,
    getEffectiveChatPrefs,
    saveChatPrefs,
    resetChatPrefs,
  } = useTheme()
  const { showToast } = useToast()

  const rawOverride = chatOverrides[chatId] ?? defaultChatPreferences(0, chatId)
  const effective = getEffectiveChatPrefs(chatId)
  const hasOverrides = hasPersonalChatOverrides(rawOverride)

  const { handleBackdropClick } = useModalBehavior({ isOpen, onClose })
  useAndroidBack(() => {
    onClose()
    return true
  }, isOpen)

  if (!isOpen) return null

  const activeThemePreset = getThemePreset(effective.theme.id) ?? THEME_PRESETS[0]
  const activeTokens = activeThemePreset.tokens[theme]
  const activeWallpaper =
    effective.wallpaper.mode === 'preset'
      ? getWallpaperPreset(effective.wallpaper.id)
      : undefined

  const previewBackground = activeWallpaper
    ? activeWallpaper.background[theme]
    : activeTokens['--bg-primary']

  const chatNotificationsOn = !effective.muted && effective.sound.mode !== 'none'

  const handleThemeSelect = (nextThemeId: string) => {
    void saveChatPrefs(chatId, {
      theme: { mode: 'preset', id: nextThemeId },
    }).catch((err) => {
      showToast(userMessage(err, 'Не удалось сохранить тему чата'), 'error')
    })
  }

  const handleWallpaperSelect = (nextMode: PreferenceValueMode, nextId: string) => {
    const wpPatch: FieldPatch =
      nextMode === 'none' ? { mode: 'none' } : { mode: 'preset', id: nextId }
    void saveChatPrefs(chatId, {
      wallpaper: wpPatch,
    }).catch((err) => {
      showToast(userMessage(err, 'Не удалось сохранить обои чата'), 'error')
    })
  }

  const handleToggleChatNotifications = () => {
    if (chatNotificationsOn) {
      void saveChatPrefs(chatId, { muted: true }).catch((err) => {
        showToast(userMessage(err, 'Не удалось обновить уведомления чата'), 'error')
      })
    } else {
      const nextSoundPatch: FieldPatch | undefined =
        effective.sound.mode === 'none'
          ? { mode: 'preset', id: effective.sound.id || 'nexa' }
          : undefined
      void saveChatPrefs(chatId, {
        muted: false,
        ...(nextSoundPatch ? { sound: nextSoundPatch } : {}),
      }).catch((err) => {
        showToast(userMessage(err, 'Не удалось обновить уведомления чата'), 'error')
      })
    }
  }

  const handleSoundSelect = (nextMode: PreferenceValueMode, nextId: string) => {
    const sndPatch: FieldPatch =
      nextMode === 'system' ? { mode: 'system' } : { mode: 'preset', id: nextId }
    void saveChatPrefs(chatId, {
      muted: false,
      sound: sndPatch,
    }).catch((err) => {
      showToast(userMessage(err, 'Не удалось сохранить звук чата'), 'error')
    })
  }

  const handleResetAll = async () => {
    try {
      await resetChatPrefs(chatId)
      showToast('Возвращены общие настройки оформления', 'success')
    } catch (err) {
      showToast(userMessage(err, 'Не удалось сбросить настройки чата'), 'error')
    }
  }

  return (
    <div className="settings-modal-backdrop" onClick={handleBackdropClick}>
      <div
        className="settings-modal settings-modal--wide"
        role="dialog"
        aria-modal="true"
        aria-label="Оформление чата"
        style={
          {
            '--pz-active-accent': activeThemePreset.previewAccent,
          } as React.CSSProperties
        }
      >
        <div className="settings-modal__header">
          <div className="pz-modal-head-titles">
            <h2 className="settings-modal__title">Оформление чата</h2>
            <span className="pz-modal-head-subtitle">
              {chatTitle} · Применяется только для вас
            </span>
          </div>
          <button className="settings-modal__close" onClick={onClose} aria-label="Закрыть">
            <CloseIcon />
          </button>
        </div>

        <div className="settings-modal__content">
          <div className="pz-container">
            {/* Live Chat Preview */}
            <div
              className="pz-preview"
              style={{
                background: previewBackground,
                ...(activeWallpaper?.backgroundSize
                  ? { backgroundSize: activeWallpaper.backgroundSize }
                  : {}),
              }}
            >
              <div className="pz-preview__row pz-preview__row--in">
                <div
                  className="pz-preview__bubble pz-preview__bubble--in"
                  style={{
                    background: activeTokens['--bubble-incoming'],
                    color: activeTokens['--bubble-incoming-text'],
                    borderColor: activeTokens['--bubble-incoming-border'],
                  }}
                >
                  <span>Для этого чата выбрана тема {activeThemePreset.name}</span>
                  <span className="pz-preview__time">13:24</span>
                </div>
              </div>
              <div className="pz-preview__row pz-preview__row--out">
                <div
                  className="pz-preview__bubble pz-preview__bubble--out"
                  style={{
                    background: activeTokens['--bubble-outgoing'],
                    color: activeTokens['--bubble-outgoing-text'],
                    borderColor: activeTokens['--bubble-outgoing-border'],
                  }}
                >
                  <span>Отлично, сразу видно какой это чат!</span>
                  <span
                    className="pz-preview__time"
                    style={{ color: activeTokens['--bubble-outgoing-meta'] }}
                  >
                    13:25
                  </span>
                </div>
              </div>
            </div>

            {/* Color Theme Presets */}
            <div className="pz-section">
              <div className="pz-section__header">
                <span className="pz-section__title">Цветовая тема чата</span>
              </div>
              <div className="pz-theme-grid">
                {THEME_PRESETS.map((preset) => {
                  const active = effective.theme.id === preset.id
                  const swatchBg = preset.tokens[theme]['--bg-secondary']
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      className={`pz-theme-card${active ? ' pz-theme-card--active' : ''}`}
                      style={
                        active
                          ? ({ '--pz-card-accent': preset.previewAccent } as React.CSSProperties)
                          : undefined
                      }
                      onClick={() => handleThemeSelect(preset.id)}
                      aria-pressed={active}
                    >
                      <span
                        className="pz-theme-card__ring"
                        style={{
                          background: swatchBg,
                          borderColor: preset.previewAccent,
                        }}
                      >
                        <span
                          className="pz-theme-card__dot"
                          style={{ background: preset.previewAccent }}
                        />
                      </span>
                      <span className="pz-theme-card__name">{preset.name}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Chat Wallpapers */}
            <div className="pz-section">
              <div className="pz-section__header">
                <span className="pz-section__title">Обои чата</span>
              </div>
              <div className="pz-wp-grid">
                <button
                  type="button"
                  className={`pz-wp-card${effective.wallpaper.mode === 'none' ? ' pz-wp-card--active' : ''}`}
                  style={
                    effective.wallpaper.mode === 'none'
                      ? ({ '--pz-card-accent': activeThemePreset.previewAccent } as React.CSSProperties)
                      : undefined
                  }
                  onClick={() => handleWallpaperSelect('none', '')}
                  aria-pressed={effective.wallpaper.mode === 'none'}
                >
                  <span
                    className="pz-wp-card__thumb"
                    style={{ background: activeTokens['--bg-primary'] }}
                  />
                  <span className="pz-wp-card__name">Без фона</span>
                </button>
                {WALLPAPER_PRESETS.map((wp) => {
                  const active =
                    effective.wallpaper.mode === 'preset' && effective.wallpaper.id === wp.id
                  return (
                    <button
                      key={wp.id}
                      type="button"
                      className={`pz-wp-card${active ? ' pz-wp-card--active' : ''}`}
                      style={
                        active
                          ? ({ '--pz-card-accent': activeThemePreset.previewAccent } as React.CSSProperties)
                          : undefined
                      }
                      onClick={() => handleWallpaperSelect('preset', wp.id)}
                      aria-pressed={active}
                    >
                      <span
                        className="pz-wp-card__thumb"
                        style={{
                          background: wp.background[theme],
                          ...(wp.backgroundSize ? { backgroundSize: wp.backgroundSize } : {}),
                        }}
                      />
                      <span className="pz-wp-card__name">{wp.name}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Notification Sounds in Chat */}
            <div className="pz-section">
              <div className="pz-section__header">
                <span className="pz-section__title">Уведомления и звук в чате</span>
              </div>
              <div className="pz-group">
                <div className="pz-group__toggle-row">
                  <div className="pz-group__labels">
                    <span className="pz-group__title">Уведомления от этого чата</span>
                    <span className="pz-group__desc">
                      Звуковые оповещения о новых сообщениях
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={chatNotificationsOn}
                    aria-label="Уведомления от этого чата"
                    className={`pz-switch${chatNotificationsOn ? ' pz-switch--on' : ''}`}
                    style={
                      chatNotificationsOn
                        ? ({ '--pz-switch-color': activeThemePreset.previewAccent } as React.CSSProperties)
                        : undefined
                    }
                    onClick={handleToggleChatNotifications}
                  >
                    <span className="pz-switch__thumb" />
                  </button>
                </div>

                {SOUND_PRESETS.map((snd) => {
                  const active =
                    chatNotificationsOn &&
                    effective.sound.mode === 'preset' &&
                    effective.sound.id === snd.id
                  return (
                    <div
                      key={snd.id}
                      className={`pz-sound-row${active ? ' pz-sound-row--active' : ''}`}
                    >
                      <button
                        type="button"
                        className="pz-sound-row__select"
                        onClick={() => handleSoundSelect('preset', snd.id)}
                        aria-pressed={active}
                      >
                        <span
                          className={`pz-radio${active ? ' pz-radio--active' : ''}`}
                          style={
                            active
                              ? ({ '--pz-radio-color': activeThemePreset.previewAccent } as React.CSSProperties)
                              : undefined
                          }
                          aria-hidden="true"
                        >
                          {active && <span className="pz-radio__dot" />}
                        </span>
                        <span className="pz-group__labels">
                          <span className="pz-group__title">{snd.name}</span>
                          <span className="pz-group__desc">{snd.description}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="pz-sound-row__play"
                        onClick={() => playSoundTone(snd.id)}
                        aria-label={`Прослушать ${snd.name}`}
                        title={`Прослушать ${snd.name}`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                        </svg>
                      </button>
                    </div>
                  )
                })}

                <div
                  className={`pz-sound-row${chatNotificationsOn && effective.sound.mode === 'system' ? ' pz-sound-row--active' : ''}`}
                >
                  <button
                    type="button"
                    className="pz-sound-row__select"
                    onClick={() => handleSoundSelect('system', '')}
                    aria-pressed={chatNotificationsOn && effective.sound.mode === 'system'}
                  >
                    <span
                      className={`pz-radio${chatNotificationsOn && effective.sound.mode === 'system' ? ' pz-radio--active' : ''}`}
                      style={
                        chatNotificationsOn && effective.sound.mode === 'system'
                          ? ({ '--pz-radio-color': activeThemePreset.previewAccent } as React.CSSProperties)
                          : undefined
                      }
                      aria-hidden="true"
                    >
                      {chatNotificationsOn && effective.sound.mode === 'system' && (
                        <span className="pz-radio__dot" />
                      )}
                    </span>
                    <span className="pz-group__labels">
                      <span className="pz-group__title">Системный</span>
                      <span className="pz-group__desc">Стандартный сигнал устройства</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="pz-sound-row__play"
                    onClick={() => playSoundTone('classic')}
                    aria-label="Прослушать Системный"
                    title="Прослушать Системный"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            {hasOverrides && (
              <button
                type="button"
                className="pz-reset-btn"
                onClick={handleResetAll}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
                <span>Сбросить к общим настройкам</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
