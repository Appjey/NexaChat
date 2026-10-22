import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext, useSearchParams } from 'react-router-dom'

import type { OutletContextType } from '../App'
import { useAccountKey } from '../features/auth/AccountKey'
import { useAuthContext } from '../features/auth/AuthContext'
import { useCallContext } from '../features/calls/CallContext'
import { ChatList } from '../features/chats/ChatList'
import { readCachedChats, writeCachedChats } from '../features/chats/chatListCache'
import { ChatWindow } from '../features/chats/ChatWindow'
import { ForwardModal } from '../features/chats/ForwardModal'
import { decryptMessages, decryptPins, selectScheme2Payload } from '../features/chats/threadCrypto'
import { HamburgerButton } from '../features/menu/HamburgerButton'
import { UpdateBanner } from '../features/updates/UpdateBanner'
import { clearChat, deleteChat, getChatMessages, getCurrentUserChats, getPinnedMessages, pinMessage, unpinMessage } from '../shared/api/chatsApi'
import { userMessage } from '../shared/api/errors'
import { getGroupInfo } from '../shared/api/groupsApi'
import { getUserPresence } from '../shared/api/presenceApi'
import type { ChatItem, GroupInfoResponse, Message, PinnedMessage, WSEvent, WSMessageAction } from '../shared/api/types'
import { decryptIncomingText } from '../shared/crypto/decryptIncoming'
import { publicKeyBase64 } from '../shared/crypto/e2e'
import { getChatKey, seedPeerPublicKey } from '../shared/crypto/peerKeys'
import { dismissChatNotifications } from '../shared/dismissChatNotifications'
import { useAndroidBack } from '../shared/hooks/useAndroidBack'
import { useGlobalWebSocket } from '../shared/hooks/useGlobalWebSocket'
import { useShareTarget } from '../shared/hooks/useShareTarget'
import { log } from '../shared/log'
import { loadCachedMessages, removeCachedMessages, saveCachedMessages } from '../shared/messageCache'
import { subscribePendingChat } from '../shared/pendingChat'
import { subscribePendingShare } from '../shared/pendingShare'

export default function ChatsPage() {
  const { setMenuOpen, onChatSelectedRef } = useOutletContext<OutletContextType>()
  const { user } = useAuthContext()
  const callContext = useCallContext()
  const accountKeyCtx = useAccountKey()
  // Snapshot the current account_key in a ref so the WS event handler (which captures
  // closures with stale `accountKeyCtx`) always sees the latest value. The handler
  // re-renders on `accountKeyCtx.state` would otherwise unsubscribe/resubscribe the
  // WS pipe each time the key changes.
  const accountKeyRef = useRef<CryptoKey | null>(null)
  useEffect(() => {
    accountKeyRef.current =
      accountKeyCtx.state.status === 'ready' ? accountKeyCtx.state.key : null
  }, [accountKeyCtx.state])

  // Seed the peer-key cache with the current user's own public_key, derived
  // locally from accountKey. Without this, opening the Saved Messages
  // self-chat triggers a /api/profile/<myId> round-trip just to look up our
  // own public_key — on a flaky network that fetch fails and the composer
  // renders "Избранное не настроил(а) шифрование" against ourselves. Seeded
  // value lets `getPeerPublicKey(myId)` return synchronously, so self-chat
  // E2E works fully offline.
  useEffect(() => {
    if (!user?.id) return
    if (accountKeyCtx.state.status !== 'ready') return
    const key = accountKeyCtx.state.key
    let cancelled = false
    void (async () => {
      try {
        const pub = await publicKeyBase64(key)
        if (!cancelled) seedPeerPublicKey(user.id, pub)
      } catch (err) {
        log.warn('failed to seed self pubkey into peer cache:', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user?.id, accountKeyCtx.state])
  const [searchParams, setSearchParams] = useSearchParams()
  const [chats, setChats] = useState<ChatItem[]>(() => readCachedChats())
  const [messages, setMessages] = useState<Message[]>([])
  const [activeChatId, setActiveChatId] = useState<number | null>(null)
  // Text shared in via the Android share-sheet; non-null opens the picker.
  const [shareText, setShareText] = useState<string | null>(null)
  // Bumped to make ChatWindow re-read a draft when sharing into the open chat.
  const [draftReloadKey, setDraftReloadKey] = useState(0)
  const [loadingChats, setLoadingChats] = useState(() => readCachedChats().length === 0)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [chatsError, setChatsError] = useState<string | null>(null)
  const [messagesError, setMessagesError] = useState<string | null>(null)
  const [isMobile, setIsMobile] = useState(false)
  const [onlineUsers, setOnlineUsers] = useState<Set<number>>(new Set())
  // Last-seen timestamps (RFC3339) keyed by user id, populated from presence
  // events and the per-chat presence fetch. Shown in the 1-on-1 header when the
  // peer is offline.
  const [lastSeen, setLastSeen] = useState<Map<number, string>>(new Map())
  // Read-receipt pointers per chat: the highest message id the peer has been
  // delivered / has read. Drives ✓ (sent) → ✓✓ grey (delivered) → ✓✓ blue (read)
  // on our own sent bubbles. 1-on-1 only. Updated by message_status events and
  // seeded from the per-chat fetch on open.
  const [messageReceipts, setMessageReceipts] = useState<Map<number, { delivered: number; read: number }>>(new Map())
  const [searchQuery, setSearchQuery] = useState('')
  const [groupInfo, setGroupInfo] = useState<GroupInfoResponse | null>(null)
  const [pinnedMessages, setPinnedMessages] = useState<PinnedMessage[]>([])
  const chatsRef = useRef<ChatItem[]>([])
  const messagesRef = useRef<Message[]>([])
  const loadChatsRef = useRef<() => void>(() => {})
  const loadMessagesRef = useRef<(chatId: number) => void>(() => {})
  const loadPinnedRef = useRef<(chatId: number) => void>(() => {})
  const messageCacheRef = useRef<Map<number, Message[]>>(new Map())
  const handleCallEventRef = useRef(callContext.handleCallEvent)
  // Stable handle to the WS send fn for callers defined before `send` exists
  // (the WS message handler) — assigned just after useGlobalWebSocket below.
  const sendRef = useRef<(data: WSMessageAction) => boolean>(() => false)
  // Debounced delivery acks: highest pending message id per background chat +
  // its flush timer. Coalesces a burst of incoming messages into one ack.
  const pendingDeliveredRef = useRef<Map<number, number>>(new Map())
  const deliveredTimerRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  // Keep refs in sync for use in WS handler
  useEffect(() => {
    chatsRef.current = chats
  }, [chats])
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    handleCallEventRef.current = callContext.handleCallEvent
  }, [callContext.handleCallEvent])

  useEffect(() => {
    const computeIsMobile = () => {
      const byWidth = window.matchMedia('(max-width: 768px)').matches
      const byUA = /Mobi|Android|iPhone|iPad/i.test(window.navigator.userAgent)
      setIsMobile(byWidth || byUA)
    }

    computeIsMobile()
    window.addEventListener('resize', computeIsMobile)
    return () => window.removeEventListener('resize', computeIsMobile)
  }, [])

  // Debounced delivery ack for messages arriving in a non-active chat. Tracks
  // the highest id per chat and flushes a single `delivered` after 400ms of
  // quiet, so a burst of replayed offline messages costs one WS frame.
  const scheduleDeliveredAck = useCallback((chatId: number, messageId: number) => {
    const cur = pendingDeliveredRef.current.get(chatId) ?? 0
    if (messageId <= cur) return
    pendingDeliveredRef.current.set(chatId, messageId)
    const existing = deliveredTimerRef.current.get(chatId)
    if (existing) clearTimeout(existing)
    deliveredTimerRef.current.set(
      chatId,
      setTimeout(() => {
        const maxId = pendingDeliveredRef.current.get(chatId) ?? 0
        pendingDeliveredRef.current.delete(chatId)
        deliveredTimerRef.current.delete(chatId)
        if (maxId > 0) sendRef.current({ action: 'delivered', chat_id: chatId, message_id: maxId })
      }, 400),
    )
  }, [])

  // Flush all pending delivery-ack timers on unmount.
  useEffect(() => {
    const timers = deliveredTimerRef.current
    return () => { timers.forEach((t) => clearTimeout(t)) }
  }, [])

  // Handle WebSocket messages globally
  const handleWebSocketMessage = useCallback(
    (event: WSEvent) => {
      if ('error' in event) {
        log.error('WebSocket error:', event.error)
        return
      }

      // Route call signaling events to CallContext
      if ('action' in event && event.action.startsWith('call_')) {
        if (event.action === 'call_offer') {
          const chat = chatsRef.current.find((c) => c.id === event.chat_id)
          handleCallEventRef.current(event, chat ? { username: chat.other_user_name || '', avatar: chat.avatar_url } : undefined)
        } else {
          handleCallEventRef.current(event)
        }
        return
      }

      // Handle presence changes
      if (event.action === 'presence_changed') {
        setOnlineUsers((prev) => {
          const next = new Set(prev)
          if (event.is_online) {
            next.add(event.user_id)
          } else {
            next.delete(event.user_id)
          }
          return next
        })
        if (!event.is_online && event.last_seen) {
          setLastSeen((prev) => new Map(prev).set(event.user_id, event.last_seen as string))
        }
        return
      }

      // Read-receipt update: the peer delivered/read our messages up to N.
      if (event.action === 'message_status') {
        setMessageReceipts((prev) => {
          const cur = prev.get(event.chat_id) ?? { delivered: 0, read: 0 }
          const next = { ...cur }
          // Read implies delivered, so a read event bumps both pointers.
          next.delivered = Math.max(next.delivered, event.up_to_message_id)
          if (event.status === 'read') {
            next.read = Math.max(next.read, event.up_to_message_id)
          }
          if (next.delivered === cur.delivered && next.read === cur.read) return prev
          return new Map(prev).set(event.chat_id, next)
        })
        return
      }

      // Handle group events
      if (
        event.action === 'member_added' ||
        event.action === 'member_removed' ||
        event.action === 'member_left' ||
        event.action === 'group_updated' ||
        event.action === 'role_changed'
      ) {
        // Refresh group info and messages if viewing this group
        if (event.chat_id === activeChatId) {
          getGroupInfo(event.chat_id).then(setGroupInfo).catch(log.error)
          loadMessagesRef.current(event.chat_id)
        }
        // Reload chat list to reflect name/member changes
        loadChatsRef.current()
        return
      }

      if (event.action === 'group_deleted') {
        messageCacheRef.current.delete(event.chat_id)
        removeCachedMessages(event.chat_id)
        setChats((prev) => prev.filter((c) => c.id !== event.chat_id))
        if (event.chat_id === activeChatId) {
          setActiveChatId(null)
          setMessages([])
          setGroupInfo(null)
          setPinnedMessages([])
        }
        return
      }

      // Handle pin/unpin events
      if (event.action === 'message_pinned' || event.action === 'message_unpinned') {
        if (event.chat_id === activeChatId) {
          loadPinnedRef.current(event.chat_id)
          loadMessagesRef.current(event.chat_id)
        }
        return
      }

      const chatId = 'chat_id' in event ? event.chat_id : undefined
      if (!chatId) return

      if (event.action === 'new') {
        // Decrypt scheme=2 payloads before they touch either the chat-list preview
        // or the message thread.
        //   - 1-on-1: chat_key = ECDH(self, peer.public_key) — both sides derive
        //     the same key by symmetry, so the same key encrypts and decrypts.
        //   - Group pairwise: the broadcast carries one envelope per recipient.
        //     Pick the envelope addressed to us, then chat_key = ECDH(self,
        //     sender.public_key). For my own outgoing message in a group this
        //     resolves to ECDH(self, self.public) via the self-envelope — same
        //     derivation rule, no special case in the receive path.
        const accountKey = accountKeyRef.current
        const chat = chatsRef.current.find((c) => c.id === chatId)
        const isGroup = chat?.is_group ?? false
        const ecdhPeerUserId = isGroup
          ? event.user_id
          : (chat?.other_user_id ?? null)

        // Read receipts (1-on-1): ack an incoming peer message. If we're viewing
        // the chat, mark it read (the server treats read as delivered too);
        // otherwise debounce a delivery ack so the sender's bubble shows ✓✓.
        // System messages (e.g. missed-call) carry no receipt.
        if (!isGroup && event.user_id !== user?.id && event.type !== 'system') {
          if (chatId === activeChatId) {
            sendRef.current({ action: 'mark_read', chat_id: chatId, up_to_message_id: event.id })
          } else {
            scheduleDeliveredAck(chatId, event.id)
          }
        }

        const payload = event.scheme === 2
          ? selectScheme2Payload(event.envelopes, event.text, event.iv, user?.id)
          : { text: event.text, iv: event.iv }

        const decryptPromise = payload === null
          ? Promise.resolve({ text: '[зашифрованное сообщение]', scheme: event.scheme, iv: undefined })
          : getChatKey(accountKey, ecdhPeerUserId).then((chatKey) => decryptIncomingText(
              { text: payload.text, scheme: event.scheme, iv: payload.iv },
              chatKey,
            ))

        decryptPromise.then((decrypted) => {
          const text = decrypted.text

          // Update chat list reactively
          setChats((prevChats) => {
            const chatIndex = prevChats.findIndex((c) => c.id === chatId)
            if (chatIndex === -1) {
              // New chat — reload
              loadChatsRef.current()
              return prevChats
            }

            const updatedChats = [...prevChats]
            const chat = { ...updatedChats[chatIndex] }
            chat.last_message = text.trim() || '📎 Вложение'
            chat.updated_at = event.created_at

            // Don't bump unread for system messages (e.g. missed-call): the
            // caller would otherwise get a red badge on their own unanswered
            // outgoing call. The offline callee still gets the server-queued
            // unread, which surfaces via GetUnreadCounts on their next load.
            // Skip offline-replay too — loadChats already counted those via the
            // server's unread_count, so bumping here would double the badge.
            if (chatId !== activeChatId && event.user_id !== user?.id && event.type !== 'system' && !event.replayed) {
              chat.unread_count = (chat.unread_count || 0) + 1
            }

            updatedChats[chatIndex] = chat
            return updatedChats.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          })

          // Add message to active chat
          if (chatId === activeChatId) {
            const newMessage: Message = {
              id: event.id,
              chat_id: event.chat_id,
              user_id: event.user_id,
              text,
              // System messages (missed-call) render via SystemMessage, not a bubble.
              type: event.type,
              // Preserve scheme so EditMessage knows whether to re-encrypt or not.
              scheme: event.scheme,
              reply_to_id: event.reply_to_id ?? null,
              // The WS wire uses 0 (not null) for "not forwarded"; normalize it
              // so the bubble doesn't render a spurious "Переслано от …" label
              // and re-forwarding keeps the original author.
              forwarded_from_user_id: event.forwarded_from_user_id || null,
              edited_at: event.edited_at ?? null,
              is_deleted: event.is_deleted,
              created_at: event.created_at,
              attachments: event.attachments ?? [],
            }
            setMessages((prev) => {
              // Deduplicate: after a WebSocket reconnect the server replays unread messages,
              // which may already be in prev from the HTTP fetch we triggered on reconnect.
              // Blindly appending would show the same message two or three times until the
              // user re-enters the chat and the list is freshly loaded.
              if (prev.some((m) => m.id === newMessage.id)) return prev
              const next = [...prev, newMessage]
              messageCacheRef.current.set(chatId, next)
              saveCachedMessages(chatId, next)
              return next
            })
          }
        }).catch((err) => log.error('decrypt new message failed:', err))
        return
      }

      if (event.action === 'attachments_added' && chatId === activeChatId) {
        // The broadcast carries the *full* envelope set per attachment (one
        // entry per chat recipient), so every connected client filters to the
        // entry addressed to its own user_id and lifts the wrapped key + iv
        // onto the top-level Attachment shape — that's what AttachmentView's
        // isEncrypted check looks at. Without this transform a freshly-sent
        // file silently falls back to the legacy plaintext branch and the
        // <img> / <video> tries to render ciphertext bytes (broken-image
        // icon, black video player).
        const myId = user?.id
        const projected = (event.attachments ?? []).map((att) => {
          const wire = att as unknown as { envelopes?: Array<{ recipient_id: number; encrypted_file_key: string; iv: string }> }
          const env = wire.envelopes?.find((e) => e.recipient_id === myId)
          if (!env) return att
          return {
            ...att,
            encrypted_file_key: env.encrypted_file_key,
            envelope_iv: env.iv,
          }
        })
        setMessages((prev) => {
          const next = prev.map((msg) =>
            msg.id === event.message_id ? { ...msg, attachments: projected } : msg
          )
          messageCacheRef.current.set(chatId, next)
          saveCachedMessages(chatId, next)
          return next
        })
        return
      }

      if (event.action === 'edit' && chatId === activeChatId) {
        // Same envelope/sender resolution rules as the 'new' path above. For
        // group scheme=2 edits the broadcast carries a fresh envelope set;
        // for 1-on-1 it carries text+iv directly.
        const accountKey = accountKeyRef.current
        const chat = chatsRef.current.find((c) => c.id === chatId)
        const isGroup = chat?.is_group ?? false
        // Use the original sender's user_id for group; need to look it up.
        const existing = messagesRef.current.find((m) => m.id === event.id)
        const senderUserId = existing?.user_id ?? user?.id ?? 0
        const ecdhPeerUserId = isGroup
          ? senderUserId
          : (chat?.other_user_id ?? null)

        const payload = event.scheme === 2
          ? selectScheme2Payload(event.envelopes, event.text, event.iv, user?.id)
          : { text: event.text, iv: event.iv }

        const decryptPromise = payload === null
          ? Promise.resolve({ text: '[зашифрованное сообщение]', scheme: event.scheme, iv: undefined })
          : getChatKey(accountKey, ecdhPeerUserId).then((chatKey) => decryptIncomingText(
              { text: payload.text, scheme: event.scheme, iv: payload.iv },
              chatKey,
            ))

        decryptPromise.then((decrypted) => {
          setMessages((prev) => {
            const next = prev.map((msg) =>
              msg.id === event.id
                ? {
                    ...msg,
                    text: decrypted.text,
                    edited_at: event.edited_at ?? new Date().toISOString(),
                  }
                : msg,
            )
            messageCacheRef.current.set(chatId, next)
            saveCachedMessages(chatId, next)
            return next
          })
        }).catch((err) => log.error('decrypt edit failed:', err))
        return
      }

      if (event.action === 'delete') {
        if (chatId === activeChatId) {
          setMessages((prev) => {
            const next = prev.map((msg) => (msg.id === event.id ? { ...msg, is_deleted: event.is_deleted } : msg))
            messageCacheRef.current.set(chatId, next)
            saveCachedMessages(chatId, next)
            return next
          })
        }
        // Refresh chat list so the sidebar preview drops the deleted message's text
        // and falls back to the previous non-deleted message (or empty).
        loadChatsRef.current()
        return
      }

      if (event.action === 'chat_cleared') {
        messageCacheRef.current.delete(event.chat_id)
        removeCachedMessages(event.chat_id)
        if (event.chat_id === activeChatId) {
          setMessages([])
          setPinnedMessages([])
        }
        setChats((prev) =>
          prev.map((c) =>
            c.id === event.chat_id ? { ...c, last_message: '', unread_count: 0 } : c
          )
        )
        return
      }

      if (event.action === 'chat_deleted') {
        messageCacheRef.current.delete(event.chat_id)
        removeCachedMessages(event.chat_id)
        setChats((prev) => prev.filter((c) => c.id !== event.chat_id))
        if (event.chat_id === activeChatId) {
          setActiveChatId(null)
          setMessages([])
          setPinnedMessages([])
        }
        return
      }
    },
    [activeChatId, user?.id, scheduleDeliveredAck]
  )

  const { isConnected, send } = useGlobalWebSocket({
    onMessage: handleWebSocketMessage,
    enabled: Boolean(user),
  })
  sendRef.current = send

  // Register WS send function with CallContext so it can send signaling messages
  useEffect(() => {
    if (isConnected) {
      callContext.registerSend(send)
    }
    return () => callContext.registerSend(null)
  }, [isConnected, send, callContext])

  // On WebSocket reconnect (typically after the app was backgrounded and Android froze the
  // process), pull fresh state — the chat list preview + active-chat messages may be stale
  // because we missed events while offline. Skip the very first connect: that's just the
  // initial mount, and the other effects already cover it.
  const hasConnectedRef = useRef(false)
  useEffect(() => {
    if (!isConnected) return
    if (!hasConnectedRef.current) {
      hasConnectedRef.current = true
      return
    }
    loadChatsRef.current()
    if (activeChatId !== null) {
      messageCacheRef.current.delete(activeChatId)
      loadMessagesRef.current(activeChatId)
    }
  }, [isConnected, activeChatId])

  const loadChats = useCallback(async () => {
    // If we already have data (from cache or a previous load), keep showing it while
    // we refetch in the background — never flash a spinner on top of stale-but-useful data.
    const haveData = chatsRef.current.length > 0
    try {
      setChatsError(null)
      if (!haveData) setLoadingChats(true)
      const data = await getCurrentUserChats()
      // Decrypt the last-message preview for any scheme=2 chat where the server
      // attached the raw ciphertext + sender_id. 1-on-1: chat_key derived from
      // peer's public_key (sender is either us or peer, both → same key). Group:
      // chat_key derived from sender's public_key (per-user envelope already
      // resolved server-side).
      const accountKey = accountKeyRef.current
      await Promise.all(data.map(async (c) => {
        if (
          c.last_message_scheme === 2 &&
          c.last_message_ciphertext &&
          c.last_message_iv &&
          c.last_message_sender_id !== undefined
        ) {
          const ecdhPeerUserId = c.is_group
            ? c.last_message_sender_id
            : (c.other_user_id ?? null)
          const chatKey = await getChatKey(accountKey, ecdhPeerUserId)
          const decrypted = await decryptIncomingText(
            { text: c.last_message_ciphertext, scheme: 2, iv: c.last_message_iv },
            chatKey,
          )
          c.last_message = decrypted.text.trim() || c.last_message
        }
      }))
      const sortedData = data.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      chatsRef.current = sortedData
      setChats(sortedData)
      writeCachedChats(sortedData)
    } catch (err) {
      log.error('Ошибка загрузки чатов', err)
      // Only surface the error if we have no cached data — otherwise the user sees their
      // last-known chat list, which is more useful than an error message.
      if (!haveData) {
        setChatsError(userMessage(err, 'Не удалось загрузить чаты'))
      }
    } finally {
      setLoadingChats(false)
    }
  }, [])
  loadChatsRef.current = loadChats

  // Register chat-selected callback for SlideMenu (contacts + group creation)
  useEffect(() => {
    if (!onChatSelectedRef) return
    onChatSelectedRef.current = async (chatId) => {
      await loadChats()
      setActiveChatId(chatId)
    }
    return () => { onChatSelectedRef.current = null }
  }, [onChatSelectedRef, loadChats])

  const loadMessages = useCallback(async (chatId: number) => {
    // Serve from cache instantly if available
    let cached = messageCacheRef.current.get(chatId)
    if (!cached) {
      // Cold start / offline: fall back to the persisted cache so previously
      // loaded messages render without a network round-trip.
      const stored = loadCachedMessages(chatId)
      if (stored && stored.length > 0) {
        cached = stored
        messageCacheRef.current.set(chatId, stored)
      }
    }
    if (cached) {
      setMessages(cached)
      setLoadingMessages(false)
    } else {
      setLoadingMessages(true)
    }

    // Always fetch fresh data in background
    try {
      setMessagesError(null)
      const result = await getChatMessages(chatId)
      const raw = result.messages
      // For 1-on-1: derive one chat_key from the peer's public_key and decrypt
      // every scheme=2 message with it. For groups: server already resolved
      // each row's per-user envelope into text/iv, but each message may have a
      // different sender, so we derive a chat_key per unique sender_id. The
      // peerKeys cache makes the N lookups effectively free after the first.
      const data = await decryptMessages(raw, chatsRef.current.find((c) => c.id === chatId), accountKeyRef.current)
      messageCacheRef.current.set(chatId, data)
      saveCachedMessages(chatId, data)
      setMessages(data)

      // Seed the peer's read-receipt pointers from the server so our sent
      // bubbles show the right ticks on open, before any live event arrives.
      if (result.lastDelivered > 0 || result.lastRead > 0) {
        setMessageReceipts((prev) => {
          const cur = prev.get(chatId) ?? { delivered: 0, read: 0 }
          const next = {
            delivered: Math.max(cur.delivered, result.lastDelivered),
            read: Math.max(cur.read, result.lastRead),
          }
          if (next.delivered === cur.delivered && next.read === cur.read) return prev
          return new Map(prev).set(chatId, next)
        })
      }

      // Advance our own read pointer to the newest loaded message (chat-open
      // read receipt). The server ignores up_to for groups. Best-effort: if the
      // socket is down, send() no-ops and the next open re-sends.
      const newestId = data.reduce((max, m) => (m.id > max ? m.id : max), 0)
      if (newestId > 0) sendRef.current({ action: 'mark_read', chat_id: chatId, up_to_message_id: newestId })
    } catch (err) {
      log.error('Ошибка загрузки сообщений', err)
      if (!cached) {
        setMessages([])
        setMessagesError(userMessage(err, 'Не удалось загрузить сообщения'))
      }
    } finally {
      setLoadingMessages(false)
    }
  }, [])
  loadMessagesRef.current = loadMessages

  // Fetch + decrypt pinned messages. The pin endpoint returns each pin's inner
  // message as ciphertext (group envelopes already resolved server-side), so we
  // decrypt it the same way loadMessages does before showing it in the bar.
  const loadPinned = useCallback(async (chatId: number) => {
    try {
      const pins = await getPinnedMessages(chatId)
      setPinnedMessages(await decryptPins(pins, chatsRef.current.find((c) => c.id === chatId), accountKeyRef.current))
    } catch (err) {
      log.error('Ошибка загрузки закреплённых', err)
    }
  }, [])
  loadPinnedRef.current = loadPinned

  // Handle notification click (from service worker)
  useEffect(() => {
    const handleSWMessage = (event: MessageEvent) => {
      if (event.data?.type === 'NOTIFICATION_CLICK' && event.data.chat_id) {
        setActiveChatId(event.data.chat_id)
      }
    }

    navigator.serviceWorker?.addEventListener('message', handleSWMessage)
    return () => {
      navigator.serviceWorker?.removeEventListener('message', handleSWMessage)
    }
  }, [])

  // Android back: if a chat is open, deselect it (return to list); otherwise let system handle (exit app).
  useAndroidBack(() => {
    if (activeChatId !== null) {
      setActiveChatId(null)
      return true
    }
    return false
  }, true)

  // Open a chat on push notification tap. Uses a router-free pub/sub (pendingChat) because
  // HashRouter on native doesn't reliably expose search params from navigate('/?chat=X').
  // Cold-start taps are covered too — subscribePendingChat replays a value that was set
  // before ChatsPage mounted. We drop the cached messages for that chat so the subsequent
  // useEffect → loadMessages fetches fresh from the server (otherwise we'd flash stale
  // cached messages and the message that triggered the push wouldn't appear until the
  // background fetch completed).
  useEffect(() => subscribePendingChat((id) => {
    messageCacheRef.current.delete(id)
    setActiveChatId(id)
    loadChatsRef.current()
  }), [])

  // "Share to Messenger": the native hook feeds pendingShare, we open the picker.
  useShareTarget()
  useEffect(() => subscribePendingShare((text) => setShareText(text)), [])

  // Pre-fill the picked chat's draft so the user can add a comment before
  // sending (ChatWindow restores chat_draft_<id> on enter), then open it.
  const handleShareToChat = useCallback((chat: ChatItem) => {
    if (shareText === null) return
    try {
      const key = `chat_draft_${chat.id}`
      const existing = localStorage.getItem(key)
      localStorage.setItem(key, existing ? `${existing}\n${shareText}` : shareText)
    } catch { /* quota / private mode — proceed without a draft */ }
    setShareText(null)
    if (chat.id === activeChatId) {
      // Same chat already open: activeChatId won't change, so nudge ChatWindow
      // to re-read the freshly written draft instead of relying on a chat switch.
      setDraftReloadKey((k) => k + 1)
    } else {
      setActiveChatId(chat.id)
    }
  }, [shareText, activeChatId])

  // Web browser path: ?chat= in the actual URL (BrowserRouter)
  useEffect(() => {
    const chatId = searchParams.get('chat')
    if (chatId) {
      setActiveChatId(Number(chatId))
      searchParams.delete('chat')
      setSearchParams(searchParams, { replace: true })
    }
  }, [searchParams, setSearchParams])

  useEffect(() => {
    loadChats()
  }, [loadChats])

  // Load messages, pins, and group info when active chat changes
  useEffect(() => {
    if (activeChatId) {
      loadMessages(activeChatId)
      loadPinned(activeChatId)

      // Load group info if it's a group chat
      const chat = chatsRef.current.find((c) => c.id === activeChatId)
      if (chat?.is_group) {
        getGroupInfo(activeChatId).then(setGroupInfo).catch(log.error)
      } else {
        setGroupInfo(null)
      }

      // Clear unread count locally
      setChats((prevChats) =>
        prevChats.map((c) =>
          c.id === activeChatId ? { ...c, unread_count: 0 } : c
        )
      )
    } else {
      setGroupInfo(null)
      setPinnedMessages([])
    }
  }, [activeChatId, loadMessages, loadPinned])

  // Clear local tray notifications for the chat the user just opened. The
  // server-side mark_read (which also dispatches dismiss-pushes to OTHER
  // devices and advances the read-receipt pointer) is sent by loadMessages once
  // the message list is loaded, so it can carry an accurate up_to_message_id.
  // Doing the local dismiss here avoids the user staring at their own tray entry
  // for a moment after opening the chat.
  useEffect(() => {
    if (!activeChatId) return
    void dismissChatNotifications(activeChatId)
  }, [activeChatId])

  const handleClearChat = useCallback(async (chatId: number) => {
    try {
      await clearChat(chatId)
      messageCacheRef.current.delete(chatId)
      removeCachedMessages(chatId)
      if (activeChatId === chatId) {
        setMessages([])
      }
      setChats((prev) =>
        prev.map((c) => c.id === chatId ? { ...c, last_message: '' } : c)
      )
    } catch (err) {
      log.error('Failed to clear chat:', err)
    }
  }, [activeChatId])

  const handleDeleteChat = useCallback(async (chatId: number) => {
    try {
      await deleteChat(chatId)
      messageCacheRef.current.delete(chatId)
      removeCachedMessages(chatId)
      setChats((prev) => prev.filter((c) => c.id !== chatId))
      if (activeChatId === chatId) {
        setActiveChatId(null)
        setMessages([])
      }
    } catch (err) {
      log.error('Failed to delete chat:', err)
    }
  }, [activeChatId])

  const handleGroupUpdated = useCallback(() => {
    if (activeChatId) {
      getGroupInfo(activeChatId).then(setGroupInfo).catch(log.error)
      loadMessages(activeChatId)
    }
    loadChats()
  }, [activeChatId, loadChats, loadMessages])

  const handleGroupDeleted = useCallback(() => {
    if (activeChatId) {
      messageCacheRef.current.delete(activeChatId)
      removeCachedMessages(activeChatId)
      setChats((prev) => prev.filter((c) => c.id !== activeChatId))
      setActiveChatId(null)
      setMessages([])
      setGroupInfo(null)
      setPinnedMessages([])
    }
  }, [activeChatId])

  const handleGroupLeft = useCallback(() => {
    if (activeChatId) {
      messageCacheRef.current.delete(activeChatId)
      removeCachedMessages(activeChatId)
      setChats((prev) => prev.filter((c) => c.id !== activeChatId))
      setActiveChatId(null)
      setMessages([])
      setGroupInfo(null)
      setPinnedMessages([])
    }
  }, [activeChatId])

  const handlePinMessage = useCallback(async (chatId: number, messageId: number) => {
    try {
      await pinMessage(chatId, messageId)
    } catch (err) {
      log.error('Failed to pin message:', err)
    }
  }, [])

  const handleUnpinMessage = useCallback(async (chatId: number, messageId: number) => {
    try {
      await unpinMessage(chatId, messageId)
    } catch (err) {
      log.error('Failed to unpin message:', err)
    }
  }, [])

  // A peer's changed E2E key was accepted: messages received under the new
  // key rendered as placeholders until now — re-fetch the thread and previews.
  const handleE2EKeyAccepted = useCallback(() => {
    if (activeChatId) {
      loadMessages(activeChatId)
      loadPinned(activeChatId)
    }
    loadChats()
  }, [activeChatId, loadMessages, loadPinned, loadChats])

  const activeChat = useMemo(
    () => chats.find((chat) => chat.id === activeChatId),
    [activeChatId, chats]
  )

  // Load presence status when active chat changes (1-on-1 only)
  const activeChatOtherUserId = activeChat?.other_user_id
  const activeChatIsGroup = activeChat?.is_group
  useEffect(() => {
    if (activeChatOtherUserId && !activeChatIsGroup) {
      getUserPresence(activeChatOtherUserId)
        .then((presence) => {
          setOnlineUsers((prev) => {
            const next = new Set(prev)
            if (presence.is_online) {
              next.add(presence.user_id)
            } else {
              next.delete(presence.user_id)
            }
            return next
          })
          if (!presence.is_online && presence.last_seen) {
            setLastSeen((prev) => new Map(prev).set(presence.user_id, presence.last_seen))
          }
        })
        .catch((err) => {
          log.error('Failed to load user presence:', err)
        })
    }
  }, [activeChatOtherUserId, activeChatIsGroup])

  const isOtherUserOnline = useMemo(
    () => (activeChat && !activeChat.is_group && activeChat.other_user_id ? onlineUsers.has(activeChat.other_user_id) : false),
    [activeChat, onlineUsers]
  )

  const otherUserLastSeen = useMemo(
    () => (activeChat && !activeChat.is_group && activeChat.other_user_id ? lastSeen.get(activeChat.other_user_id) : undefined),
    [activeChat, lastSeen]
  )

  // Peer's read-receipt pointers for the open chat → ✓/✓✓ on our sent bubbles.
  const activeChatReceipt = useMemo(
    () => (activeChatId ? messageReceipts.get(activeChatId) : undefined),
    [activeChatId, messageReceipts]
  )

  const canPin = useMemo(() => {
    if (!activeChat || !user) return false
    if (!activeChat.is_group) return true
    const member = groupInfo?.members.find((m) => m.user_id === user.id)
    return member?.role === 'admin' || member?.role === 'creator'
  }, [activeChat, user, groupInfo])

  // Filter chats by search query
  const filteredChats = useMemo(() => {
    if (!searchQuery.trim()) return chats
    const query = searchQuery.toLowerCase()
    return chats.filter((chat) => {
      if (chat.is_group) {
        return (chat.group_name || '').toLowerCase().includes(query)
      }
      return (chat.other_user_name || '').toLowerCase().includes(query)
    })
  }, [chats, searchQuery])

  return (
    <div className="chats-page-shell">
      {/* Self-update banner — sits above the chat layout, doesn't affect
          the inner flex sizing. Renders null when no update is offered. */}
      <UpdateBanner />
      <div className={`telegram-layout${isMobile && activeChatId ? ' chat-active' : ''}`}>
      {/* Sidebar with chat list */}
      <div className="telegram-sidebar">
        <div className="telegram-sidebar__header">
          <HamburgerButton onClick={() => setMenuOpen(true)} />
          <div className="telegram-sidebar__search">
            <input
              type="search"
              className="form-control"
              placeholder="Поиск..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="telegram-sidebar__content">
          <ChatList
            chats={filteredChats}
            activeChatId={activeChatId ?? undefined}
            onSelect={(id) => setActiveChatId(id)}
            loading={loadingChats}
            error={chatsError}
          />
        </div>
      </div>

      {/* Main chat area */}
      <div className="telegram-chat-area">
        <ChatWindow
          chatId={activeChatId ?? undefined}
          onE2EKeyAccepted={handleE2EKeyAccepted}
          messages={messages}
          otherUserId={activeChat?.other_user_id}
          otherUsername={activeChat?.is_favorites ? 'Избранное' : activeChat?.other_user_name}
          otherAvatar={activeChat?.avatar_url}
          isFavorites={activeChat?.is_favorites}
          currentUserId={user?.id}
          loading={loadingMessages}
          error={messagesError}
          isConnected={isConnected}
          isOtherUserOnline={isOtherUserOnline}
          otherUserLastSeen={otherUserLastSeen}
          deliveredUpTo={activeChatReceipt?.delivered ?? 0}
          readUpTo={activeChatReceipt?.read ?? 0}
          send={send}
          isMobile={isMobile}
          onBackToList={() => setActiveChatId(null)}
          onClearChat={handleClearChat}
          onDeleteChat={handleDeleteChat}
          isGroup={activeChat?.is_group}
          groupName={activeChat?.is_group ? (groupInfo?.name || activeChat?.group_name) : undefined}
          groupMembers={groupInfo?.members}
          onGroupUpdated={handleGroupUpdated}
          onGroupDeleted={handleGroupDeleted}
          onGroupLeft={handleGroupLeft}
          pinnedMessages={pinnedMessages}
          canPin={canPin}
          onPinMessage={handlePinMessage}
          onUnpinMessage={handleUnpinMessage}
          draftReloadKey={draftReloadKey}
        />
      </div>
      </div>

      {/* Chat-picker for content shared in via the Android share-sheet. */}
      <ForwardModal
        isOpen={shareText !== null}
        onClose={() => setShareText(null)}
        onSelect={handleShareToChat}
        title="Поделиться в…"
        confirmLabel="Поделиться"
      />
    </div>
  )
}
