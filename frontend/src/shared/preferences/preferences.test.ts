import { beforeEach, describe, expect, it } from 'vitest'

import {
  defaultAccountPreferences,
  defaultChatPreferences,
  hasPersonalChatOverrides,
  resolveEffectiveChatPreference,
  shouldPlayIncomingNotificationSound,
} from './resolver'
import {
  clearPreferencesCacheOnLogout,
  isLegacyThemeMigrated,
  LEGACY_THEME_KEY,
  markLegacyThemeMigrated,
  readCachedPreferences,
  readLastKnownGood,
  updateLastKnownGoodFromAccount,
  writeCachedPreferences,
} from './storage'

function installLocalStorage() {
  const store = new Map<string, string>()
  const ls = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
}

describe('Personalization Priority Resolution & Semantics', () => {
  beforeEach(() => {
    installLocalStorage()
  })

  it('resolves built-in defaults when account and chat preferences are absent', () => {
    const eff = resolveEffectiveChatPreference(10, null, null, null, true)
    expect(eff.theme.id).toBe('nexachat')
    expect(eff.theme.source).toBe('builtin_default')
    expect(eff.resolved_variant).toBe('dark')
    expect(eff.wallpaper.mode).toBe('none')
    expect(eff.wallpaper.source).toBe('builtin_default')
    expect(eff.sound.id).toBe('nexa')
    expect(eff.sound.source).toBe('builtin_default')
  })

  it('enforces priority: personal override -> accepted shared -> account global -> built-in default independently per field', () => {
    const acc = defaultAccountPreferences(1, 'light')
    acc.theme_mode = 'preset'
    acc.theme_id = 'ocean'
    acc.wallpaper_mode = 'preset'
    acc.wallpaper_id = 'grad-aurora'
    acc.sound_mode = 'preset'
    acc.sound_id = 'bell'

    const chatPref = defaultChatPreferences(1, 42)
    // Shared chat styling sets theme="lavender" and wallpaper="pat-dots"
    chatPref.shared_theme_mode = 'preset'
    chatPref.shared_theme_id = 'lavender'
    chatPref.shared_wallpaper_mode = 'preset'
    chatPref.shared_wallpaper_id = 'pat-dots'

    // Personal override ONLY on wallpaper ("solid-midnight"); theme and sound stay 'inherit'
    chatPref.wallpaper_mode = 'preset'
    chatPref.wallpaper_id = 'solid-midnight'

    const effChat42 = resolveEffectiveChatPreference(42, acc, chatPref, null, false)
    // Theme comes from accepted shared ("lavender")
    expect(effChat42.theme.id).toBe('lavender')
    expect(effChat42.theme.source).toBe('accepted_shared')
    // Wallpaper comes from personal override ("solid-midnight")
    expect(effChat42.wallpaper.id).toBe('solid-midnight')
    expect(effChat42.wallpaper.source).toBe('personal_override')
    // Sound comes from account global ("bell")
    expect(effChat42.sound.id).toBe('bell')
    expect(effChat42.sound.source).toBe('account_global')

    // Another chat (chat 99) is unaffected by chat 42's shared or personal settings
    const effChat99 = resolveEffectiveChatPreference(99, acc, null, null, false)
    expect(effChat99.theme.id).toBe('ocean')
    expect(effChat99.wallpaper.id).toBe('grad-aurora')
    expect(effChat99.sound.id).toBe('bell')
  })

  it('distinguishes explicit "none" (no wallpaper / silent sound) from "inherit" and restores inheritance on reset', () => {
    const acc = defaultAccountPreferences(1, 'dark')
    acc.wallpaper_mode = 'preset'
    acc.wallpaper_id = 'grad-ocean'
    acc.sound_mode = 'preset'
    acc.sound_id = 'pulse'

    const chatPref = defaultChatPreferences(1, 15)
    chatPref.wallpaper_mode = 'none'
    chatPref.sound_mode = 'none'

    const effExplicitNone = resolveEffectiveChatPreference(15, acc, chatPref, null, true)
    expect(effExplicitNone.wallpaper.mode).toBe('none')
    expect(effExplicitNone.wallpaper.source).toBe('personal_override')
    expect(effExplicitNone.sound.mode).toBe('none')
    expect(effExplicitNone.sound.source).toBe('personal_override')
    expect(hasPersonalChatOverrides(chatPref)).toBe(true)

    // Resetting wallpaper and sound back to 'inherit' restores global inheritance
    chatPref.wallpaper_mode = 'inherit'
    chatPref.sound_mode = 'inherit'
    const effAfterReset = resolveEffectiveChatPreference(15, acc, chatPref, null, true)
    expect(effAfterReset.wallpaper.mode).toBe('preset')
    expect(effAfterReset.wallpaper.id).toBe('grad-ocean')
    expect(effAfterReset.wallpaper.source).toBe('account_global')
    expect(effAfterReset.sound.mode).toBe('preset')
    expect(effAfterReset.sound.id).toBe('pulse')
    expect(effAfterReset.sound.source).toBe('account_global')
    expect(hasPersonalChatOverrides(chatPref)).toBe(false)
  })

  it('falls back safely to lastKnownGood or built-in default on unsupported preset or unavailable asset without mutating stored data', () => {
    const acc = defaultAccountPreferences(1, 'dark')
    acc.theme_mode = 'preset'
    acc.theme_id = 'unsupported-neon-2030'
    acc.wallpaper_mode = 'custom'
    acc.wallpaper_id = 'missing-asset'
    acc.wallpaper_version = 0 // invalid/unavailable custom asset
    acc.sound_mode = 'preset'
    acc.sound_id = 'unsupported-horn'
    acc.extra_fields = { future_feature_flag: true }

    const lkg = {
      theme_id: 'forest',
      appearance: 'dark' as const,
      wallpaper_mode: 'preset' as const,
      wallpaper_id: 'solid-sage',
      sound_mode: 'preset' as const,
      sound_id: 'soft',
    }

    const effWithLkg = resolveEffectiveChatPreference(10, acc, null, lkg, true)
    expect(effWithLkg.theme.fallback_applied).toBe(true)
    expect(effWithLkg.theme.id).toBe('forest')
    expect(effWithLkg.wallpaper.fallback_applied).toBe(true)
    expect(effWithLkg.wallpaper.id).toBe('solid-sage')
    expect(effWithLkg.sound.fallback_applied).toBe(true)
    expect(effWithLkg.sound.id).toBe('soft')

    // Stored object and extra_fields remain completely untouched
    expect(acc.theme_id).toBe('unsupported-neon-2030')
    expect(acc.extra_fields).toEqual({ future_feature_flag: true })
  })

  it('enforces OS permissions, DND, active call, replay, and mute priority over notification sound presets', () => {
    const acc = defaultAccountPreferences(1, 'dark')
    const chatPref = defaultChatPreferences(1, 20)
    const eff = resolveEffectiveChatPreference(20, acc, chatPref, null, true)

    expect(shouldPlayIncomingNotificationSound(eff, {}).play).toBe(true)
    expect(shouldPlayIncomingNotificationSound(eff, { isOwnMessage: true }).reason).toBe(
      'own_message',
    )
    expect(shouldPlayIncomingNotificationSound(eff, { isReplayed: true }).reason).toBe(
      'replayed_history',
    )
    expect(shouldPlayIncomingNotificationSound(eff, { inActiveCall: true }).reason).toBe(
      'active_call',
    )
    expect(shouldPlayIncomingNotificationSound(eff, { osPermissionDenied: true }).reason).toBe(
      'os_permission_denied',
    )
    expect(shouldPlayIncomingNotificationSound(eff, { deviceSilentOrDnd: true }).reason).toBe(
      'device_dnd_or_silent',
    )

    chatPref.muted = true
    const effMuted = resolveEffectiveChatPreference(20, acc, chatPref, null, true)
    expect(shouldPlayIncomingNotificationSound(effMuted, {}).reason).toBe('chat_muted')
  })

  it('migrates legacy localStorage theme, persists cache & lastKnownGood, and clears cache on logout', () => {
    localStorage.setItem(LEGACY_THEME_KEY, 'light')
    const initial = readCachedPreferences()
    expect(initial.account.appearance).toBe('light')

    expect(isLegacyThemeMigrated(7)).toBe(false)
    markLegacyThemeMigrated(7)
    expect(isLegacyThemeMigrated(7)).toBe(true)

    const customAcc = defaultAccountPreferences(7, 'light')
    customAcc.theme_id = 'classic-blue'
    writeCachedPreferences(customAcc, {})
    updateLastKnownGoodFromAccount(customAcc)

    expect(readLastKnownGood()?.theme_id).toBe('classic-blue')

    clearPreferencesCacheOnLogout()
    expect(readLastKnownGood()).toBeNull()
  })
})
