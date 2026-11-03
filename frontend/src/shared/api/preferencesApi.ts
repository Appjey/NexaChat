import type {
  AccountPreferenceDTO,
  AccountPreferencePatch,
  AllPreferencesResponse,
  BulkApplyRequest,
  BulkApplyResponse,
  ChatPreferenceDTO,
  ChatPreferencePatch,
  EffectiveChatPreference,
} from '../preferences/types'
import { endpoints } from './endpoints'
import { httpDelete, httpGet, httpPost, httpPut } from './httpClient'

export async function fetchAllPreferences(): Promise<AllPreferencesResponse> {
  return httpGet<AllPreferencesResponse>(endpoints.preferences.all)
}

export async function updateAccountPreferences(
  patch: AccountPreferencePatch,
): Promise<{ account: AccountPreferenceDTO }> {
  return httpPut<{ account: AccountPreferenceDTO }>(endpoints.preferences.account, patch)
}

export async function updateChatPreference(
  chatId: number,
  patch: ChatPreferencePatch,
): Promise<{ preference: ChatPreferenceDTO; effective: EffectiveChatPreference }> {
  return httpPut<{ preference: ChatPreferenceDTO; effective: EffectiveChatPreference }>(
    endpoints.preferences.chat(chatId),
    patch,
  )
}

export async function resetChatPreference(
  chatId: number,
  fields?: Array<'theme' | 'wallpaper' | 'sound' | 'muted'>,
): Promise<{ preference: ChatPreferenceDTO; effective: EffectiveChatPreference }> {
  const query = fields && fields.length > 0 ? `?fields=${encodeURIComponent(fields.join(','))}` : ''
  return httpDelete<{ preference: ChatPreferenceDTO; effective: EffectiveChatPreference }>(
    `${endpoints.preferences.chat(chatId)}${query}`,
  )
}

export async function bulkApplyPreferences(req: BulkApplyRequest): Promise<BulkApplyResponse> {
  return httpPost<BulkApplyResponse>(endpoints.preferences.bulkApply, req)
}
