// Decrypting what the server hands back for a chat: message threads, pinned
// messages and WebSocket broadcasts. Pure functions over the peerKeys /
// decryptIncoming primitives so ChatsPage only orchestrates state.

import type { ChatItem, Message, PinnedMessage, WSEnvelope } from '../../shared/api/types'
import { decryptIncomingText } from '../../shared/crypto/decryptIncoming'
import { getChatKey } from '../../shared/crypto/peerKeys'

type ChatShape = Pick<ChatItem, 'is_group' | 'other_user_id'> | undefined

/**
 * Pick (ciphertext, iv) out of a scheme=2 WS broadcast. For 1-on-1 it is the
 * top-level text/iv. For group pairwise (envelopes set) it is the envelope
 * addressed to the current user — if none is present the current user wasn't
 * a recipient (e.g. joined the group after the message was sent) and we
 * return null so the UI shows the placeholder.
 */
export function selectScheme2Payload(
  envelopes: WSEnvelope[] | undefined,
  topText: string,
  topIv: string | undefined,
  currentUserId: number | undefined,
): { text: string; iv: string | undefined } | null {
  if (!envelopes || envelopes.length === 0) {
    return { text: topText, iv: topIv }
  }
  if (!currentUserId) return null
  const own = envelopes.find((e) => e.recipient_id === currentUserId)
  if (!own) return null
  return { text: own.ciphertext, iv: own.iv }
}

/**
 * One chat_key per distinct sender. For a 1-on-1 chat that is a single key
 * derived from the peer's public key (both directions share it by ECDH
 * symmetry). For a group, the server already resolved each row's per-user
 * envelope into text/iv, but every message may have a different sender, so
 * the key is derived per sender — the peerKeys cache makes repeat lookups free.
 */
async function senderKeys(
  chat: ChatShape,
  senderIds: Iterable<number>,
  accountKey: CryptoKey | null,
): Promise<(senderId: number) => Promise<CryptoKey | null>> {
  if (!chat?.is_group) {
    const key = await getChatKey(accountKey, chat?.other_user_id ?? null)
    return async () => key
  }
  const keys = new Map<number, CryptoKey | null>()
  await Promise.all(
    Array.from(new Set(senderIds)).map(async (id) => keys.set(id, await getChatKey(accountKey, id))),
  )
  return async (id) => keys.get(id) ?? null
}

/** Decrypt a thread as returned by GET /api/chats/:id/messages. */
export async function decryptMessages(raw: Message[], chat: ChatShape, accountKey: CryptoKey | null): Promise<Message[]> {
  const keyFor = await senderKeys(chat, raw.filter((m) => m.scheme === 2).map((m) => m.user_id), accountKey)
  return Promise.all(raw.map(async (m) => decryptIncomingText(m, m.scheme === 2 ? await keyFor(m.user_id) : null)))
}

/** Decrypt the inner messages of GET /api/chats/:id/pins. */
export async function decryptPins(pins: PinnedMessage[], chat: ChatShape, accountKey: CryptoKey | null): Promise<PinnedMessage[]> {
  const keyFor = await senderKeys(
    chat,
    pins.filter((p) => p.message.scheme === 2).map((p) => p.message.user_id),
    accountKey,
  )
  return Promise.all(
    pins.map(async (p) => ({
      ...p,
      message: await decryptIncomingText(p.message, p.message.scheme === 2 ? await keyFor(p.message.user_id) : null),
    })),
  )
}
