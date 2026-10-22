import type { Message } from './api/types'
import { isWebBrowser } from './platform'

// Offline message cache. Mirrors the in-memory per-chat message cache to
// localStorage so previously-loaded messages render on a cold start with no
// network connection.
//
// We store the *decrypted* messages on purpose: re-decrypting offline is
// impossible because peer public keys are never persisted (only the account_key
// is). The account_key already lives in this same app-private localStorage, so
// caching plaintext stays within the app's existing trust boundary — anyone who
// can read this cache can already read the account_key and decrypt everything.
//
// Capped at the last MAX_CACHED_MESSAGES_PER_CHAT messages per chat to stay well
// under the ~5 MB localStorage budget even across many chats.
//
// Browser builds do not cache at all: the website is the one runtime where the
// origin's storage is readable from DevTools and by any other script on the
// origin, and a browser tab is rarely offline anyway.

const KEY_PREFIX = 'cached_msgs_'
const MAX_CACHED_MESSAGES_PER_CHAT = 50

function keyFor(chatId: number): string {
  return `${KEY_PREFIX}${chatId}`
}

/** Persist the last N messages for a chat (best-effort; ignores quota errors). */
export function saveCachedMessages(chatId: number, messages: Message[]): void {
  if (isWebBrowser()) return
  try {
    const tail =
      messages.length > MAX_CACHED_MESSAGES_PER_CHAT
        ? messages.slice(-MAX_CACHED_MESSAGES_PER_CHAT)
        : messages
    localStorage.setItem(keyFor(chatId), JSON.stringify(tail))
  } catch {
    // Quota exceeded / serialization issue — caching is best-effort.
  }
}

/** Read cached messages for a chat, or undefined if absent/corrupt. */
export function loadCachedMessages(chatId: number): Message[] | undefined {
  if (isWebBrowser()) return undefined
  try {
    const raw = localStorage.getItem(keyFor(chatId))
    if (!raw) return undefined
    const data = JSON.parse(raw) as Message[]
    return Array.isArray(data) ? data : undefined
  } catch {
    return undefined
  }
}

/** Drop one chat's cached messages (on clear / delete / leave). */
export function removeCachedMessages(chatId: number): void {
  try {
    localStorage.removeItem(keyFor(chatId))
  } catch {
    // ignore
  }
}

/** Wipe every chat's cached messages (on logout). */
export function clearAllCachedMessages(): void {
  try {
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(KEY_PREFIX)) toRemove.push(k)
    }
    toRemove.forEach((k) => localStorage.removeItem(k))
  } catch {
    // ignore
  }
}
