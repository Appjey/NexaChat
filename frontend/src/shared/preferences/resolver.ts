import {
  isSupportedSoundPreset,
  isSupportedThemePreset,
  isSupportedWallpaperPreset,
} from './catalog'
import type {
  AccountPreferenceDTO,
  AppearanceMode,
  ChatPreferenceDTO,
  DeviceSoundConstraints,
  EffectiveChatPreference,
  LastKnownGoodPrefs,
  PreferenceValueMode,
  ResolutionSource,
  ResolvedField,
  ResolvedThemeVariant,
} from './types'

export function defaultAccountPreferences(
  userId = 0,
  initialAppearance: AppearanceMode = 'dark',
): AccountPreferenceDTO {
  return {
    user_id: userId,
    version: 0,
    theme_mode: 'preset',
    theme_id: 'nexachat',
    theme_version: 1,
    appearance: initialAppearance,
    wallpaper_mode: 'none',
    wallpaper_id: '',
    wallpaper_version: 0,
    sound_mode: 'preset',
    sound_id: 'nexa',
    sound_version: 1,
    notifications_enabled: true,
  }
}

export function defaultChatPreferences(userId: number, chatId: number): ChatPreferenceDTO {
  return {
    user_id: userId,
    chat_id: chatId,
    version: 0,
    theme_mode: 'inherit',
    theme_id: '',
    theme_version: 0,
    appearance: '',
    wallpaper_mode: 'inherit',
    wallpaper_id: '',
    wallpaper_version: 0,
    sound_mode: 'inherit',
    sound_id: '',
    sound_version: 0,
    muted: false,
    shared_theme_mode: 'inherit',
    shared_theme_id: '',
    shared_theme_version: 0,
    shared_appearance: '',
    shared_wallpaper_mode: 'inherit',
    shared_wallpaper_id: '',
    shared_wallpaper_version: 0,
    shared_sound_mode: 'inherit',
    shared_sound_id: '',
    shared_sound_version: 0,
  }
}

function resolveAppearanceVariant(
  appearance: AppearanceMode,
  systemPrefersDark = true,
): ResolvedThemeVariant {
  if (appearance === 'light') return 'light'
  if (appearance === 'dark') return 'dark'
  return systemPrefersDark ? 'dark' : 'light'
}

export function resolveEffectiveChatPreference(
  chatId: number,
  account: AccountPreferenceDTO | null | undefined,
  chatPref?: ChatPreferenceDTO | null,
  lastKnownGood?: LastKnownGoodPrefs | null,
  systemPrefersDark = true,
): EffectiveChatPreference {
  const theme = resolveThemeField(account, chatPref, lastKnownGood)
  const { appearance, source: appearanceSource } = resolveAppearanceField(
    account,
    chatPref,
    lastKnownGood,
  )
  const wallpaper = resolveWallpaperField(account, chatPref, lastKnownGood)
  const sound = resolveSoundField(account, chatPref, lastKnownGood)

  return {
    chat_id: chatId,
    theme,
    appearance,
    resolved_variant: resolveAppearanceVariant(appearance, systemPrefersDark),
    appearance_source: appearanceSource,
    wallpaper,
    sound,
    notifications_enabled: account ? account.notifications_enabled : true,
    muted: chatPref ? chatPref.muted : false,
  }
}

function resolveThemeField(
  account: AccountPreferenceDTO | null | undefined,
  chatPref?: ChatPreferenceDTO | null,
  lkg?: LastKnownGoodPrefs | null,
): ResolvedField {
  let raw: ResolvedField
  if (chatPref && isExplicitThemeMode(chatPref.theme_mode)) {
    raw = {
      mode: chatPref.theme_mode,
      id: chatPref.theme_id,
      version: chatPref.theme_version,
      source: 'personal_override',
      fallback_applied: false,
    }
  } else if (chatPref && isExplicitThemeMode(chatPref.shared_theme_mode)) {
    raw = {
      mode: chatPref.shared_theme_mode,
      id: chatPref.shared_theme_id,
      version: chatPref.shared_theme_version,
      source: 'accepted_shared',
      fallback_applied: false,
    }
  } else if (account && isExplicitThemeMode(account.theme_mode)) {
    raw = {
      mode: account.theme_mode,
      id: account.theme_id,
      version: account.theme_version,
      source: 'account_global',
      fallback_applied: false,
    }
  } else {
    return {
      mode: 'preset',
      id: 'nexachat',
      version: 1,
      source: 'builtin_default',
      fallback_applied: false,
    }
  }

  if (raw.mode === 'preset' && isSupportedThemePreset(raw.id)) {
    return raw
  }
  if (raw.mode === 'custom' && raw.id.trim() !== '' && raw.version > 0) {
    return raw
  }

  const fallbackId = lkg && isSupportedThemePreset(lkg.theme_id) ? lkg.theme_id : 'nexachat'
  return {
    mode: 'preset',
    id: fallbackId,
    version: 1,
    source: raw.source,
    fallback_applied: true,
  }
}

function resolveAppearanceField(
  account: AccountPreferenceDTO | null | undefined,
  _chatPref?: ChatPreferenceDTO | null,
  lkg?: LastKnownGoodPrefs | null,
): { appearance: AppearanceMode; source: ResolutionSource } {
  if (account && isValidAppearance(account.appearance)) {
    return { appearance: account.appearance, source: 'account_global' }
  }
  if (lkg && isValidAppearance(lkg.appearance)) {
    return { appearance: lkg.appearance, source: 'builtin_default' }
  }
  return { appearance: 'dark', source: 'builtin_default' }
}

function resolveWallpaperField(
  account: AccountPreferenceDTO | null | undefined,
  chatPref?: ChatPreferenceDTO | null,
  lkg?: LastKnownGoodPrefs | null,
): ResolvedField {
  let raw: ResolvedField
  if (chatPref && isExplicitWallpaperMode(chatPref.wallpaper_mode)) {
    raw = {
      mode: chatPref.wallpaper_mode,
      id: chatPref.wallpaper_id,
      version: chatPref.wallpaper_version,
      source: 'personal_override',
      fallback_applied: false,
    }
  } else if (chatPref && isExplicitWallpaperMode(chatPref.shared_wallpaper_mode)) {
    raw = {
      mode: chatPref.shared_wallpaper_mode,
      id: chatPref.shared_wallpaper_id,
      version: chatPref.shared_wallpaper_version,
      source: 'accepted_shared',
      fallback_applied: false,
    }
  } else if (account && isExplicitWallpaperMode(account.wallpaper_mode)) {
    raw = {
      mode: account.wallpaper_mode,
      id: account.wallpaper_id,
      version: account.wallpaper_version,
      source: 'account_global',
      fallback_applied: false,
    }
  } else {
    return {
      mode: 'none',
      id: '',
      version: 0,
      source: 'builtin_default',
      fallback_applied: false,
    }
  }

  if (raw.mode === 'none') {
    return { ...raw, id: '' }
  }
  if (raw.mode === 'preset' && isSupportedWallpaperPreset(raw.id)) {
    return raw
  }
  if (raw.mode === 'custom' && raw.id.trim() !== '' && raw.version > 0) {
    return raw
  }

  if (lkg) {
    if (lkg.wallpaper_mode === 'none') {
      return {
        mode: 'none',
        id: '',
        version: 0,
        source: raw.source,
        fallback_applied: true,
      }
    }
    if (lkg.wallpaper_mode === 'preset' && isSupportedWallpaperPreset(lkg.wallpaper_id)) {
      return {
        mode: 'preset',
        id: lkg.wallpaper_id,
        version: 1,
        source: raw.source,
        fallback_applied: true,
      }
    }
  }

  return {
    mode: 'none',
    id: '',
    version: 0,
    source: raw.source,
    fallback_applied: true,
  }
}

function resolveSoundField(
  account: AccountPreferenceDTO | null | undefined,
  chatPref?: ChatPreferenceDTO | null,
  lkg?: LastKnownGoodPrefs | null,
): ResolvedField {
  let raw: ResolvedField
  if (chatPref && isExplicitSoundMode(chatPref.sound_mode)) {
    raw = {
      mode: chatPref.sound_mode,
      id: chatPref.sound_id,
      version: chatPref.sound_version,
      source: 'personal_override',
      fallback_applied: false,
    }
  } else if (chatPref && isExplicitSoundMode(chatPref.shared_sound_mode)) {
    raw = {
      mode: chatPref.shared_sound_mode,
      id: chatPref.shared_sound_id,
      version: chatPref.shared_sound_version,
      source: 'accepted_shared',
      fallback_applied: false,
    }
  } else if (account && isExplicitSoundMode(account.sound_mode)) {
    raw = {
      mode: account.sound_mode,
      id: account.sound_id,
      version: account.sound_version,
      source: 'account_global',
      fallback_applied: false,
    }
  } else {
    return {
      mode: 'preset',
      id: 'nexa',
      version: 1,
      source: 'builtin_default',
      fallback_applied: false,
    }
  }

  if (raw.mode === 'none' || raw.mode === 'system') {
    return { ...raw, id: '' }
  }
  if (raw.mode === 'preset' && isSupportedSoundPreset(raw.id)) {
    return raw
  }
  if (raw.mode === 'custom' && raw.id.trim() !== '' && raw.version > 0) {
    return raw
  }

  if (lkg) {
    if (lkg.sound_mode === 'none' || lkg.sound_mode === 'system') {
      return {
        mode: lkg.sound_mode,
        id: '',
        version: 0,
        source: raw.source,
        fallback_applied: true,
      }
    }
    if (lkg.sound_mode === 'preset' && isSupportedSoundPreset(lkg.sound_id)) {
      return {
        mode: 'preset',
        id: lkg.sound_id,
        version: 1,
        source: raw.source,
        fallback_applied: true,
      }
    }
  }

  return {
    mode: 'preset',
    id: 'nexa',
    version: 1,
    source: raw.source,
    fallback_applied: true,
  }
}

type SoundDecision = {
  play: boolean
  reason:
    | 'own_message'
    | 'replayed_history'
    | 'active_call'
    | 'os_permission_denied'
    | 'device_dnd_or_silent'
    | 'account_notifications_disabled'
    | 'chat_muted'
    | 'sound_silent'
    | 'allowed'
  mode?: PreferenceValueMode
  soundId?: string
}

/**
 * Evaluates whether an incoming message should trigger a notification sound.
 * OS permissions, device DND/mute, active call, and chat/account mute always
 * take priority over sound presets.
 */
export function shouldPlayIncomingNotificationSound(
  effective: EffectiveChatPreference,
  constraints: DeviceSoundConstraints = {},
): SoundDecision {
  if (constraints.isOwnMessage) {
    return { play: false, reason: 'own_message' }
  }
  if (constraints.isReplayed) {
    return { play: false, reason: 'replayed_history' }
  }
  if (constraints.inActiveCall) {
    return { play: false, reason: 'active_call' }
  }
  if (constraints.osPermissionDenied) {
    return { play: false, reason: 'os_permission_denied' }
  }
  if (constraints.deviceSilentOrDnd) {
    return { play: false, reason: 'device_dnd_or_silent' }
  }
  if (!effective.notifications_enabled) {
    return { play: false, reason: 'account_notifications_disabled' }
  }
  if (effective.muted) {
    return { play: false, reason: 'chat_muted' }
  }
  if (effective.sound.mode === 'none') {
    return { play: false, reason: 'sound_silent' }
  }
  return {
    play: true,
    reason: 'allowed',
    mode: effective.sound.mode,
    soundId: effective.sound.id || 'nexa',
  }
}

export function hasPersonalChatOverrides(chatPref?: ChatPreferenceDTO | null): boolean {
  if (!chatPref) return false
  return (
    chatPref.theme_mode !== 'inherit' ||
    chatPref.wallpaper_mode !== 'inherit' ||
    chatPref.sound_mode !== 'inherit' ||
    chatPref.muted
  )
}

function isExplicitThemeMode(m: PreferenceValueMode): boolean {
  return m === 'preset' || m === 'custom'
}

function isExplicitWallpaperMode(m: PreferenceValueMode): boolean {
  return m === 'none' || m === 'preset' || m === 'custom'
}

function isExplicitSoundMode(m: PreferenceValueMode): boolean {
  return m === 'none' || m === 'system' || m === 'preset' || m === 'custom'
}

function isValidAppearance(a?: AppearanceMode | '' | null): a is AppearanceMode {
  return a === 'system' || a === 'light' || a === 'dark'
}
