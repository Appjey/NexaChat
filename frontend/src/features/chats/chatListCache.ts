import type { ChatItem } from '../../shared/api/types'
import { isWebBrowser } from '../../shared/platform'

// Chat-list cache (names + decrypted last-message previews) for instant cold
// starts. Native/Electron only — the browser build keeps nothing on disk, see
// shared/messageCache.ts for why.

const CACHED_CHATS_KEY = 'cached_chats_list'

export function readCachedChats(): ChatItem[] {
  if (isWebBrowser()) return []
  try {
    const raw = localStorage.getItem(CACHED_CHATS_KEY)
    if (!raw) return []
    const data = JSON.parse(raw) as ChatItem[]
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

export function writeCachedChats(chats: ChatItem[]) {
  if (isWebBrowser()) return
  try {
    localStorage.setItem(CACHED_CHATS_KEY, JSON.stringify(chats))
  } catch {
    // ignore quota / serialization issues — caching is best-effort
  }
}
