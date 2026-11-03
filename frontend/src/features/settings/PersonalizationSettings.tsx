import { useEffect, useMemo, useState } from 'react'

import { getCurrentUserChats } from '../../shared/api/chatsApi'
import { userMessage } from '../../shared/api/errors'
import type { ChatItem } from '../../shared/api/types'
import { useToast } from '../../shared/components/ToastContext'
import { useTheme } from '../../shared/hooks/useTheme'
import {
  getThemePreset,
  getWallpaperPreset,
  playSoundTone,
  SOUND_PRESETS,
  THEME_PRESETS,
  WALLPAPER_PRESETS,
} from '../../shared/preferences/catalog'
import { hasPersonalChatOverrides } from '../../shared/preferences/resolver'
import type {
  AppearanceMode,
  FieldPatch,
  PreferenceValueMode,
} from '../../shared/preferences/types'
import { readCachedChats } from '../chats/chatListCache'

function formatChatTitle(chat: ChatItem): string {
  if (chat.is_favorites) return 'Избранное'
  if (chat.is_group) return chat.group_name || `Группа #${chat.id}`
  return chat.other_user_name || `Чат #${chat.id}`
}

const APPEARANCE_OPTIONS: ReadonlyArray<{
  value: AppearanceMode
  label: string
  icon: 'monitor' | 'sun' | 'moon'
}> = [
  { value: 'system', label: 'Как в системе', icon: 'monitor' },
  { value: 'light', label: 'Светлая', icon: 'sun' },
  { value: 'dark', label: 'Тёмная', icon: 'moon' },
]

function ModeIcon({ name }: { name: 'monitor' | 'sun' | 'moon' }) {
  if (name === 'monitor') {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    )
  }
  if (name === 'sun') {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </svg>
    )
  }
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

export function PersonalizationSettings() {
  const {
    theme,
    accountPrefs,
    chatOverrides,
    saveAccountPrefs,
    resetChatPrefs,
  } = useTheme()
  const { showToast } = useToast()

  const [availableChats, setAvailableChats] = useState<ChatItem[]>(() => readCachedChats())

  useEffect(() => {
    let active = true
    void getCurrentUserChats()
      .then((chats) => {
        if (active && Array.isArray(chats)) {
          setAvailableChats(chats)
        }
      })
      .catch(() => {
        // fallback to cached chats
      })
    return () => {
      active = false
    }
  }, [])

  const chatTitleMap = useMemo(() => {
    const map = new Map<number, string>()
    for (const c of availableChats) {
      map.set(c.id, formatChatTitle(c))
    }
    return map
  }, [availableChats])

  const activeOverridesList = useMemo(
    () => Object.values(chatOverrides).filter((pref) => hasPersonalChatOverrides(pref)),
    [chatOverrides],
  )

  const currentThemeId = accountPrefs.theme_id || 'nexachat'
  const currentAppearance: AppearanceMode = accountPrefs.appearance || 'dark'
  const currentWallpaperMode: PreferenceValueMode = accountPrefs.wallpaper_mode || 'none'
  const currentWallpaperId = accountPrefs.wallpaper_id || ''
  const currentSoundMode: PreferenceValueMode = accountPrefs.sound_mode || 'preset'
  const currentSoundId = accountPrefs.sound_id || 'nexa'
  const soundEnabled = accountPrefs.notifications_enabled && currentSoundMode !== 'none'

  const activeThemePreset = getThemePreset(currentThemeId) ?? THEME_PRESETS[0]
  const activeTokens = activeThemePreset.tokens[theme]
  const activeWallpaper =
    currentWallpaperMode === 'preset' ? getWallpaperPreset(currentWallpaperId) : undefined

  const previewBackground = activeWallpaper
    ? activeWallpaper.background[theme]
    : activeTokens['--bg-primary']

  const handleAppearanceSelect = (nextAppearance: AppearanceMode) => {
    void saveAccountPrefs({ appearance: nextAppearance }).catch((err) => {
      showToast(userMessage(err, 'Не удалось сохранить режим яркости'), 'error')
    })
  }

  const handleThemeSelect = (nextThemeId: string) => {
    void saveAccountPrefs({ theme: { mode: 'preset', id: nextThemeId } }).catch((err) => {
      showToast(userMessage(err, 'Не удалось сохранить тему'), 'error')
    })
  }

  const handleWallpaperSelect = (nextMode: PreferenceValueMode, nextId: string) => {
    const wpPatch: FieldPatch =
      nextMode === 'none' ? { mode: 'none' } : { mode: 'preset', id: nextId }
    void saveAccountPrefs({ wallpaper: wpPatch }).catch((err) => {
      showToast(userMessage(err, 'Не удалось сохранить обои'), 'error')
    })
  }

  const handleToggleSoundEnabled = () => {
    if (soundEnabled) {
      void saveAccountPrefs({
        notifications_enabled: false,
      }).catch((err) => {
        showToast(userMessage(err, 'Не удалось обновить настройки звука'), 'error')
      })
    } else {
      const nextSoundPatch: FieldPatch =
        currentSoundMode === 'none'
          ? { mode: 'preset', id: currentSoundId || 'nexa' }
          : currentSoundMode === 'system'
            ? { mode: 'system' }
            : { mode: 'preset', id: currentSoundId || 'nexa' }
      void saveAccountPrefs({
        notifications_enabled: true,
        sound: nextSoundPatch,
      }).catch((err) => {
        showToast(userMessage(err, 'Не удалось обновить настройки звука'), 'error')
      })
    }
  }

  const handleSoundSelect = (nextMode: PreferenceValueMode, nextId: string) => {
    const sndPatch: FieldPatch =
      nextMode === 'system' ? { mode: 'system' } : { mode: 'preset', id: nextId }
    void saveAccountPrefs({
      notifications_enabled: true,
      sound: sndPatch,
    }).catch((err) => {
      showToast(userMessage(err, 'Не удалось сохранить звук уведомлений'), 'error')
    })
  }

  const handleResetOverride = async (chatId: number) => {
    try {
      await resetChatPrefs(chatId)
      showToast('Оформление чата сброшено к общим настройкам', 'success')
    } catch (err) {
      showToast(userMessage(err, 'Не удалось сбросить настройки чата'), 'error')
    }
  }

  return (
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
            <span>Привет! Как тебе новое оформление?</span>
            <span className="pz-preview__time">13:20</span>
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
            <span>Выглядит супер, ничего лишнего!</span>
            <span
              className="pz-preview__time"
              style={{ color: activeTokens['--bubble-outgoing-meta'] }}
            >
              13:21
            </span>
          </div>
        </div>
      </div>

      {/* Brightness Mode (Global Only) */}
      <div className="pz-section">
        <div className="pz-section__header">
          <span className="pz-section__title">Режим яркости</span>
        </div>
        <div className="pz-segmented" role="radiogroup" aria-label="Режим яркости">
          {APPEARANCE_OPTIONS.map((opt) => {
            const active = currentAppearance === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                className={`pz-segmented__btn${active ? ' pz-segmented__btn--active' : ''}`}
                onClick={() => handleAppearanceSelect(opt.value)}
                aria-pressed={active}
              >
                <ModeIcon name={opt.icon} />
                <span>{opt.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Color Theme Presets */}
      <div className="pz-section">
        <div className="pz-section__header">
          <span className="pz-section__title">Цветовая тема по умолчанию</span>
          <span className="pz-section__hint">Для всех чатов без своей темы</span>
        </div>
        <div className="pz-theme-grid">
          {THEME_PRESETS.map((preset) => {
            const active = currentThemeId === preset.id
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
            className={`pz-wp-card${currentWallpaperMode === 'none' ? ' pz-wp-card--active' : ''}`}
            onClick={() => handleWallpaperSelect('none', '')}
            aria-pressed={currentWallpaperMode === 'none'}
          >
            <span
              className="pz-wp-card__thumb"
              style={{ background: activeTokens['--bg-primary'] }}
            />
            <span className="pz-wp-card__name">Без фона</span>
          </button>
          {WALLPAPER_PRESETS.map((wp) => {
            const active = currentWallpaperMode === 'preset' && currentWallpaperId === wp.id
            return (
              <button
                key={wp.id}
                type="button"
                className={`pz-wp-card${active ? ' pz-wp-card--active' : ''}`}
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

      {/* Notification Sounds */}
      <div className="pz-section">
        <div className="pz-section__header">
          <span className="pz-section__title">Звук уведомлений</span>
        </div>
        <div className="pz-group">
          <div className="pz-group__toggle-row">
            <div className="pz-group__labels">
              <span className="pz-group__title">Звук новых сообщений</span>
              <span className="pz-group__desc">
                Проигрывать сигнал при входящем сообщении
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={soundEnabled}
              aria-label="Звук новых сообщений"
              className={`pz-switch${soundEnabled ? ' pz-switch--on' : ''}`}
              onClick={handleToggleSoundEnabled}
            >
              <span className="pz-switch__thumb" />
            </button>
          </div>

          {SOUND_PRESETS.map((snd) => {
            const active =
              soundEnabled && currentSoundMode === 'preset' && currentSoundId === snd.id
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
            className={`pz-sound-row${soundEnabled && currentSoundMode === 'system' ? ' pz-sound-row--active' : ''}`}
          >
            <button
              type="button"
              className="pz-sound-row__select"
              onClick={() => handleSoundSelect('system', '')}
              aria-pressed={soundEnabled && currentSoundMode === 'system'}
            >
              <span
                className={`pz-radio${soundEnabled && currentSoundMode === 'system' ? ' pz-radio--active' : ''}`}
                aria-hidden="true"
              >
                {soundEnabled && currentSoundMode === 'system' && (
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

      {/* Custom Per-Chat Overrides List */}
      {activeOverridesList.length > 0 && (
        <div className="pz-section">
          <div className="pz-section__header">
            <span className="pz-section__title">
              Своё оформление в чатах ({activeOverridesList.length})
            </span>
          </div>
          <div className="pz-overrides">
            {activeOverridesList.map((ov) => {
              const ovTheme = getThemePreset(ov.theme_id || currentThemeId) ?? THEME_PRESETS[0]
              const ovWp =
                ov.wallpaper_mode === 'preset'
                  ? getWallpaperPreset(ov.wallpaper_id)?.name || ov.wallpaper_id
                  : ov.wallpaper_mode === 'none'
                    ? 'Без фона'
                    : null
              const ovSnd =
                ov.sound_mode === 'preset'
                  ? SOUND_PRESETS.find((s) => s.id === ov.sound_id)?.name || ov.sound_id
                  : ov.sound_mode === 'system'
                    ? 'Системный'
                    : ov.sound_mode === 'none'
                      ? 'Без звука'
                      : null

              const summaryParts = [
                ov.theme_mode !== 'inherit' ? ovTheme.name : null,
                ovWp,
                ovSnd,
                ov.muted ? 'Уведомления выкл.' : null,
              ].filter(Boolean)

              return (
                <div key={ov.chat_id} className="pz-override-card">
                  <div className="pz-override-card__left">
                    <span
                      className="pz-override-card__badge"
                      style={{
                        background: ovTheme.tokens[theme]['--bg-secondary'],
                        borderColor: ovTheme.previewAccent,
                      }}
                    >
                      <span
                        className="pz-override-card__badge-dot"
                        style={{ background: ovTheme.previewAccent }}
                      />
                    </span>
                    <div className="pz-group__labels">
                      <span className="pz-group__title">
                        {chatTitleMap.get(ov.chat_id) || `Чат #${ov.chat_id}`}
                      </span>
                      <span className="pz-group__desc">
                        {summaryParts.join(' · ') || 'Индивидуальные настройки'}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="pz-override-card__reset"
                    onClick={() => handleResetOverride(ov.chat_id)}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                      <path d="M3 3v5h5" />
                    </svg>
                    <span>Сбросить</span>
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
