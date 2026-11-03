import {
  isSupportedSoundPreset,
  isSupportedThemePreset,
  isSupportedWallpaperPreset,
} from './catalog'
import { defaultAccountPreferences } from './resolver'
import type {
  AccountPreferenceDTO,
  AppearanceMode,
  ChatPreferenceDTO,
  LastKnownGoodPrefs,
} from './types'

const PREFS_CACHE_KEY = 'nexachat_prefs_cache_v1'
const PREFS_LKG_KEY = 'nexachat_prefs_lkg_v1'
export const LEGACY_THEME_KEY = 'theme'
const LEGACY_MIGRATED_KEY = 'nexachat_legacy_theme_migrated_v1'

type CachedPreferencesPayload = {
  account: AccountPreferenceDTO
  chat_overrides: Record<number, ChatPreferenceDTO>
}

export function readLegacyAppearance(): AppearanceMode {
  try {
    const saved = localStorage.getItem(LEGACY_THEME_KEY)
    if (saved === 'light' || saved === 'dark') {
      return saved
    }
  } catch {
    // ignore storage errors
  }
  return 'dark'
}

export function readCachedPreferences(): CachedPreferencesPayload {
  const initialAppearance = readLegacyAppearance()
  try {
    const raw = localStorage.getItem(PREFS_CACHE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CachedPreferencesPayload>
      if (parsed && parsed.account) {
        return {
          account: parsed.account,
          chat_overrides: parsed.chat_overrides ?? {},
        }
      }
    }
  } catch {
    // ignore corrupted cache
  }
  return {
    account: defaultAccountPreferences(0, initialAppearance),
    chat_overrides: {},
  }
}

export function writeCachedPreferences(
  account: AccountPreferenceDTO,
  chatOverrides: Record<number, ChatPreferenceDTO>,
): void {
  try {
    const payload: CachedPreferencesPayload = {
      account,
      chat_overrides: chatOverrides,
    }
    localStorage.setItem(PREFS_CACHE_KEY, JSON.stringify(payload))
  } catch {
    // ignore quota errors
  }
}

export function readLastKnownGood(): LastKnownGoodPrefs | null {
  try {
    const raw = localStorage.getItem(PREFS_LKG_KEY)
    if (!raw) return null
    return JSON.parse(raw) as LastKnownGoodPrefs
  } catch {
    return null
  }
}

export function updateLastKnownGoodFromAccount(
  account: AccountPreferenceDTO,
  existing?: LastKnownGoodPrefs | null,
): LastKnownGoodPrefs {
  const prev = existing ?? readLastKnownGood()
  const next: LastKnownGoodPrefs = {
    theme_id:
      account.theme_mode === 'preset' && isSupportedThemePreset(account.theme_id)
        ? account.theme_id
        : prev?.theme_id && isSupportedThemePreset(prev.theme_id)
          ? prev.theme_id
          : 'nexachat',
    appearance:
      account.appearance === 'light' ||
      account.appearance === 'dark' ||
      account.appearance === 'system'
        ? account.appearance
        : prev?.appearance ?? 'dark',
    wallpaper_mode:
      account.wallpaper_mode === 'none' ||
      (account.wallpaper_mode === 'preset' && isSupportedWallpaperPreset(account.wallpaper_id))
        ? account.wallpaper_mode
        : prev?.wallpaper_mode ?? 'none',
    wallpaper_id:
      account.wallpaper_mode === 'preset' && isSupportedWallpaperPreset(account.wallpaper_id)
        ? account.wallpaper_id
        : account.wallpaper_mode === 'none'
          ? ''
          : prev?.wallpaper_id ?? '',
    sound_mode:
      account.sound_mode === 'none' ||
      account.sound_mode === 'system' ||
      (account.sound_mode === 'preset' && isSupportedSoundPreset(account.sound_id))
        ? account.sound_mode
        : prev?.sound_mode ?? 'preset',
    sound_id:
      account.sound_mode === 'preset' && isSupportedSoundPreset(account.sound_id)
        ? account.sound_id
        : account.sound_mode === 'none' || account.sound_mode === 'system'
          ? ''
          : prev?.sound_id ?? 'nexa',
  }

  try {
    localStorage.setItem(PREFS_LKG_KEY, JSON.stringify(next))
  } catch {
    // ignore storage errors
  }
  return next
}

export function isLegacyThemeMigrated(userId: number): boolean {
  if (!userId) return true
  try {
    return localStorage.getItem(`${LEGACY_MIGRATED_KEY}:${userId}`) === '1'
  } catch {
    return true
  }
}

export function markLegacyThemeMigrated(userId: number): void {
  if (!userId) return
  try {
    localStorage.setItem(`${LEGACY_MIGRATED_KEY}:${userId}`, '1')
  } catch {
    // ignore
  }
}

export function clearPreferencesCacheOnLogout(): void {
  try {
    localStorage.removeItem(PREFS_CACHE_KEY)
    localStorage.removeItem(PREFS_LKG_KEY)
  } catch {
    // ignore
  }
}
