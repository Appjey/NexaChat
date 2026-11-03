import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ApiError, TIMEOUT_CODE, userMessage } from '../api/errors'
import { hasAuthSession, UNAUTHORIZED_EVENT } from '../api/httpClient'
import {
  bulkApplyPreferences,
  fetchAllPreferences,
  resetChatPreference,
  updateAccountPreferences,
  updateChatPreference,
} from '../api/preferencesApi'
import type { WSEventPrefsUpdated } from '../api/types'
import { log } from '../log'
import { getThemePreset, getWallpaperPreset } from '../preferences/catalog'
import {
  defaultAccountPreferences,
  resolveEffectiveChatPreference,
} from '../preferences/resolver'
import {
  isLegacyThemeMigrated,
  LEGACY_THEME_KEY,
  markLegacyThemeMigrated,
  readCachedPreferences,
  readLastKnownGood,
  readLegacyAppearance,
  updateLastKnownGoodFromAccount,
  writeCachedPreferences,
} from '../preferences/storage'
import type {
  AccountPreferenceDTO,
  AccountPreferencePatch,
  BulkApplyRequest,
  BulkApplyResponse,
  ChatPreferenceDTO,
  ChatPreferencePatch,
  EffectiveChatPreference,
  LastKnownGoodPrefs,
} from '../preferences/types'
import { type Theme, ThemeContext } from './themeTypes'

function makeIdempotencyKey(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function getSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const initialCache = useMemo(() => readCachedPreferences(), [])
  const [accountPrefs, setAccountPrefs] = useState<AccountPreferenceDTO>(initialCache.account)
  const [chatOverrides, setChatOverrides] = useState<Record<number, ChatPreferenceDTO>>(
    initialCache.chat_overrides,
  )
  const [lastKnownGood, setLastKnownGood] = useState<LastKnownGoodPrefs | null>(() =>
    readLastKnownGood(),
  )
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => getSystemPrefersDark())
  const [syncing, setSyncing] = useState(false)
  const [lastSyncError, setLastSyncError] = useState<string | null>(null)

  const accountRef = useRef(accountPrefs)
  accountRef.current = accountPrefs
  const overridesRef = useRef(chatOverrides)
  overridesRef.current = chatOverrides

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const globalEffective = useMemo(
    () =>
      resolveEffectiveChatPreference(0, accountPrefs, null, lastKnownGood, systemPrefersDark),
    [accountPrefs, lastKnownGood, systemPrefersDark],
  )

  const theme: Theme = globalEffective.resolved_variant

  // Apply global theme attributes and preset CSS custom properties to documentElement
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', theme)
    root.setAttribute('data-theme-preset', globalEffective.theme.id)
    try {
      localStorage.setItem(LEGACY_THEME_KEY, theme)
    } catch {
      // ignore storage errors
    }

    const preset = getThemePreset(globalEffective.theme.id)
    if (preset) {
      const tokens = preset.tokens[theme]
      Object.entries(tokens).forEach(([key, val]) => {
        root.style.setProperty(key, val)
      })
    }

    if (globalEffective.wallpaper.mode === 'preset') {
      const wp = getWallpaperPreset(globalEffective.wallpaper.id)
      if (wp) {
        root.style.setProperty('--chat-wallpaper-bg', wp.background[theme])
        root.style.setProperty('--chat-wallpaper-size', wp.backgroundSize || 'auto')
      } else {
        root.style.removeProperty('--chat-wallpaper-bg')
        root.style.removeProperty('--chat-wallpaper-size')
      }
    } else {
      root.style.removeProperty('--chat-wallpaper-bg')
      root.style.removeProperty('--chat-wallpaper-size')
    }
  }, [theme, globalEffective.theme.id, globalEffective.wallpaper.mode, globalEffective.wallpaper.id])

  // Persist cache and update lastKnownGood whenever preferences change
  useEffect(() => {
    writeCachedPreferences(accountPrefs, chatOverrides)
    setLastKnownGood((prev) => updateLastKnownGoodFromAccount(accountPrefs, prev))
  }, [accountPrefs, chatOverrides])

  const syncPreferences = useCallback(async () => {
    if (!hasAuthSession()) return
    setSyncing(true)
    setLastSyncError(null)
    try {
      const res = await fetchAllPreferences()
      let nextAccount = res.account
      const map: Record<number, ChatPreferenceDTO> = {}
      for (const item of res.chat_overrides ?? []) {
        map[item.chat_id] = item
      }

      // One-time migration from legacy localStorage 'theme' if server account prefs were never saved
      if (
        nextAccount.version === 0 &&
        nextAccount.user_id > 0 &&
        !isLegacyThemeMigrated(nextAccount.user_id)
      ) {
        const legacyApp = readLegacyAppearance()
        markLegacyThemeMigrated(nextAccount.user_id)
        if (legacyApp !== nextAccount.appearance) {
          try {
            const migrated = await updateAccountPreferences({
              appearance: legacyApp,
              expected_version: 0,
              idempotency_key: makeIdempotencyKey('migrate-theme'),
            })
            nextAccount = migrated.account
          } catch (migErr) {
            log.warn('Failed to migrate legacy theme preference:', migErr)
          }
        }
      }

      setAccountPrefs(nextAccount)
      setChatOverrides(map)
    } catch (err) {
      log.warn('Failed to sync preferences from server:', err)
      setLastSyncError(userMessage(err, 'Не удалось синхронизировать настройки'))
    } finally {
      setSyncing(false)
    }
  }, [])

  // Hydrate from server on initial mount when authenticated, and reset on unauthorized event
  useEffect(() => {
    if (hasAuthSession()) {
      void syncPreferences()
    }
    const onUnauthorized = () => {
      setAccountPrefs(defaultAccountPreferences(0, readLegacyAppearance()))
      setChatOverrides({})
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [syncPreferences])

  const saveAccountPrefs = useCallback(
    async (patch: AccountPreferencePatch): Promise<AccountPreferenceDTO> => {
      const idemKey = patch.idempotency_key ?? makeIdempotencyKey('acc')
      const expectedVer = patch.expected_version ?? accountRef.current.version

      // Optimistic local update when unauthenticated (e.g. login page or offline unit tests)
      if (!hasAuthSession()) {
        const next: AccountPreferenceDTO = {
          ...accountRef.current,
          ...(patch.theme
            ? {
                theme_mode: patch.theme.mode,
                theme_id: patch.theme.id ?? accountRef.current.theme_id,
                theme_version: patch.theme.version ?? 1,
              }
            : {}),
          ...(patch.appearance ? { appearance: patch.appearance } : {}),
          ...(patch.wallpaper
            ? {
                wallpaper_mode: patch.wallpaper.mode,
                wallpaper_id: patch.wallpaper.mode === 'none' ? '' : (patch.wallpaper.id ?? ''),
                wallpaper_version: patch.wallpaper.mode === 'none' ? 0 : (patch.wallpaper.version ?? 1),
              }
            : {}),
          ...(patch.sound
            ? {
                sound_mode: patch.sound.mode,
                sound_id:
                  patch.sound.mode === 'none' || patch.sound.mode === 'system'
                    ? ''
                    : (patch.sound.id ?? ''),
                sound_version:
                  patch.sound.mode === 'none' || patch.sound.mode === 'system'
                    ? 0
                    : (patch.sound.version ?? 1),
              }
            : {}),
          ...(patch.notifications_enabled !== undefined
            ? { notifications_enabled: patch.notifications_enabled }
            : {}),
        }
        setAccountPrefs(next)
        return next
      }

      const payload: AccountPreferencePatch = {
        ...patch,
        expected_version: expectedVer,
        idempotency_key: idemKey,
      }

      const attempt = async () => {
        const res = await updateAccountPreferences(payload)
        setAccountPrefs(res.account)
        return res.account
      }

      try {
        return await attempt()
      } catch (err) {
        if (err instanceof ApiError && err.code === TIMEOUT_CODE) {
          return await attempt()
        }
        if (err instanceof ApiError && (err.status === 409 || err.code === 'version_conflict')) {
          const serverCurrent = err.data?.current as AccountPreferenceDTO | undefined
          if (serverCurrent && typeof serverCurrent.version === 'number') {
            setAccountPrefs(serverCurrent)
          } else {
            await syncPreferences()
          }
        }
        throw err
      }
    },
    [syncPreferences],
  )

  const saveChatPrefs = useCallback(
    async (chatId: number, patch: ChatPreferencePatch): Promise<ChatPreferenceDTO> => {
      const idemKey = patch.idempotency_key ?? makeIdempotencyKey(`chat-${chatId}`)
      const currentChat = overridesRef.current[chatId]
      const expectedVer = patch.expected_version ?? (currentChat ? currentChat.version : 0)

      const payload: ChatPreferencePatch = {
        ...patch,
        expected_version: expectedVer,
        idempotency_key: idemKey,
      }

      const attempt = async () => {
        const res = await updateChatPreference(chatId, payload)
        setChatOverrides((prev) => ({ ...prev, [chatId]: res.preference }))
        return res.preference
      }

      try {
        return await attempt()
      } catch (err) {
        if (err instanceof ApiError && err.code === TIMEOUT_CODE) {
          return await attempt()
        }
        if (err instanceof ApiError && (err.status === 409 || err.code === 'version_conflict')) {
          const serverCurrent = err.data?.current as ChatPreferenceDTO | undefined
          if (serverCurrent && typeof serverCurrent.version === 'number') {
            setChatOverrides((prev) => ({ ...prev, [chatId]: serverCurrent }))
          } else {
            await syncPreferences()
          }
        }
        throw err
      }
    },
    [syncPreferences],
  )

  const resetChatPrefs = useCallback(
    async (
      chatId: number,
      fields?: Array<'theme' | 'wallpaper' | 'sound' | 'muted'>,
    ): Promise<ChatPreferenceDTO> => {
      const res = await resetChatPreference(chatId, fields)
      setChatOverrides((prev) => ({ ...prev, [chatId]: res.preference }))
      return res.preference
    },
    [],
  )

  const bulkApplyPrefs = useCallback(
    async (req: BulkApplyRequest): Promise<BulkApplyResponse> => {
      const payload: BulkApplyRequest = {
        ...req,
        expected_account_version:
          req.scope === 'all'
            ? (req.expected_account_version ?? accountRef.current.version)
            : req.expected_account_version,
        idempotency_key: req.idempotency_key ?? makeIdempotencyKey('bulk'),
      }
      const res = await bulkApplyPreferences(payload)
      if (res.account) {
        setAccountPrefs(res.account)
      }
      if (res.results && res.results.length > 0) {
        setChatOverrides((prev) => {
          const next = { ...prev }
          for (const item of res.results) {
            if (item.preference && item.status !== 'error') {
              next[item.chat_id] = item.preference
            }
          }
          return next
        })
      }
      return res
    },
    [],
  )

  const handlePreferenceWSEvent = useCallback((event: WSEventPrefsUpdated) => {
    if (event.scope === 'account' && event.account) {
      const incoming = event.account as AccountPreferenceDTO
      setAccountPrefs((prev) => (incoming.version >= prev.version ? incoming : prev))
      return
    }
    if (event.scope === 'chat' && event.chat_id && event.preference) {
      const incoming = event.preference as ChatPreferenceDTO
      const cid = event.chat_id
      setChatOverrides((prev) => {
        const cur = prev[cid]
        if (cur && cur.version > incoming.version) return prev
        return { ...prev, [cid]: incoming }
      })
      return
    }
    if (event.scope === 'bulk' && event.result) {
      const bulk = event.result as BulkApplyResponse
      if (bulk.account) {
        const incomingAcc = bulk.account
        setAccountPrefs((prev) => (incomingAcc.version >= prev.version ? incomingAcc : prev))
      }
      if (bulk.results && bulk.results.length > 0) {
        setChatOverrides((prev) => {
          const next = { ...prev }
          for (const item of bulk.results) {
            if (item.preference) {
              const cur = next[item.chat_id]
              if (!cur || item.preference.version >= cur.version) {
                next[item.chat_id] = item.preference
              }
            }
          }
          return next
        })
      }
    }
  }, [])

  const getEffectiveChatPrefs = useCallback(
    (chatId: number): EffectiveChatPreference => {
      const chatPref = chatOverrides[chatId] ?? null
      return resolveEffectiveChatPreference(
        chatId,
        accountPrefs,
        chatPref,
        lastKnownGood,
        systemPrefersDark,
      )
    },
    [accountPrefs, chatOverrides, lastKnownGood, systemPrefersDark],
  )

  const toggleTheme = useCallback(() => {
    const nextVariant: Theme = theme === 'dark' ? 'light' : 'dark'
    setAccountPrefs((prev) => ({ ...prev, appearance: nextVariant }))
    if (hasAuthSession()) {
      void saveAccountPrefs({ appearance: nextVariant }).catch((err) => {
        log.warn('Failed to persist toggled theme:', err)
      })
    }
  }, [theme, saveAccountPrefs])

  const contextValue = useMemo(
    () => ({
      theme,
      toggleTheme,
      accountPrefs,
      chatOverrides,
      syncing,
      lastSyncError,
      getEffectiveChatPrefs,
      syncPreferences,
      saveAccountPrefs,
      saveChatPrefs,
      resetChatPrefs,
      bulkApplyPrefs,
      handlePreferenceWSEvent,
    }),
    [
      theme,
      toggleTheme,
      accountPrefs,
      chatOverrides,
      syncing,
      lastSyncError,
      getEffectiveChatPrefs,
      syncPreferences,
      saveAccountPrefs,
      saveChatPrefs,
      resetChatPrefs,
      bulkApplyPrefs,
      handlePreferenceWSEvent,
    ],
  )

  return <ThemeContext.Provider value={contextValue}>{children}</ThemeContext.Provider>
}
