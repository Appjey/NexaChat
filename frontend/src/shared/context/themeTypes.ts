import { createContext } from 'react'

import type { WSEventPrefsUpdated } from '../api/types'
import type {
  AccountPreferenceDTO,
  AccountPreferencePatch,
  BulkApplyRequest,
  BulkApplyResponse,
  ChatPreferenceDTO,
  ChatPreferencePatch,
  EffectiveChatPreference,
} from '../preferences/types'

export type Theme = 'light' | 'dark'

export type ThemeContextType = {
  theme: Theme
  toggleTheme: () => void
  accountPrefs: AccountPreferenceDTO
  chatOverrides: Record<number, ChatPreferenceDTO>
  syncing: boolean
  lastSyncError: string | null
  getEffectiveChatPrefs: (chatId: number) => EffectiveChatPreference
  syncPreferences: () => Promise<void>
  saveAccountPrefs: (patch: AccountPreferencePatch) => Promise<AccountPreferenceDTO>
  saveChatPrefs: (chatId: number, patch: ChatPreferencePatch) => Promise<ChatPreferenceDTO>
  resetChatPrefs: (
    chatId: number,
    fields?: Array<'theme' | 'wallpaper' | 'sound' | 'muted'>,
  ) => Promise<ChatPreferenceDTO>
  bulkApplyPrefs: (req: BulkApplyRequest) => Promise<BulkApplyResponse>
  handlePreferenceWSEvent: (event: WSEventPrefsUpdated) => void
}

export const ThemeContext = createContext<ThemeContextType | null>(null)
