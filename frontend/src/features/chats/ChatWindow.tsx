import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { forwardMessage,type ForwardPayload } from '../../shared/api/chatsApi'
import { endpoints } from '../../shared/api/endpoints'
import { httpPost, resolveApiUrl } from '../../shared/api/httpClient'
import type { ChatItem, GroupMember, Message, PinnedMessage, WSMessageAction } from '../../shared/api/types'
import { ConfirmDialog } from '../../shared/components/ConfirmDialog'
import { BookmarkIcon, PhoneIcon } from '../../shared/components/Icons'
import { useToast } from '../../shared/components/ToastContext'
import { encryptMessage, type GroupRecipientKey } from '../../shared/crypto/e2e'
import {
  encryptGroupMessage,
  getChatKey,
  getGroupKeyStatus,
  prepareAttachmentForUpload,
  resolveAttachmentRecipients,
  rewrapAttachmentEnvelopes,
} from '../../shared/crypto/peerKeys'
import { log } from '../../shared/log'
import { formatLastSeen } from '../../shared/utils'
import { useAccountKey } from '../auth/AccountKey'
import { useCallContext } from '../calls/CallContext'
import { UserProfileModal } from '../profile/UserProfileModal'
import { ChatSearch } from './ChatSearch'
import { EmojiPicker } from './EmojiPicker'
import { ForwardModal } from './ForwardModal'
import { GroupInfoPanel } from './GroupInfoPanel'
import { MessageComposer } from './MessageComposer'
import { MessageList } from './MessageList'
import { PinnedMessagesBar } from './PinnedMessagesBar'
import { useChatDraft } from './useChatDraft'
import { useE2EStatus } from './useE2EStatus'

// Hoist the default empty members array to module scope so the destructured
// default below resolves to a stable reference. Otherwise every render of
// ChatWindow creates a new `[]`, which makes the e2eStatus useEffect refire
// on every render → setE2EStatus → render → refire forever, freezing the tab.
const NO_GROUP_MEMBERS: GroupMember[] = []

type Props = {
  chatId?: number
  messages: Message[]
  otherUserId?: number
  otherUsername?: string
  otherAvatar?: string | null
  currentUserId?: number
  loading?: boolean
  error?: string | null
  isConnected: boolean
  isOtherUserOnline?: boolean
  // RFC3339 timestamp of the peer's last offline transition (1-on-1 only).
  otherUserLastSeen?: string
  // Peer's read-receipt pointers (1-on-1): highest message id delivered / read.
  // Drive ✓/✓✓ on our own sent bubbles.
  deliveredUpTo?: number
  readUpTo?: number
  send: (data: WSMessageAction) => boolean
  isMobile?: boolean
  onBackToList?: () => void
  onClearChat?: (chatId: number) => void
  onDeleteChat?: (chatId: number) => void
  // True for the user's Saved Messages self-chat — hides delete-chat (clear still allowed)
  // and is used by the header/composer to render a localised title.
  isFavorites?: boolean
  // Group props
  isGroup?: boolean
  groupName?: string
  groupMembers?: GroupMember[]
  onGroupUpdated?: () => void
  onGroupDeleted?: () => void
  onGroupLeft?: () => void
  // Pin props
  pinnedMessages?: PinnedMessage[]
  canPin?: boolean
  onPinMessage?: (chatId: number, msgId: number) => void
  onUnpinMessage?: (chatId: number, msgId: number) => void
  // Bumped by the parent to make the composer re-read the persisted draft for
  // the current chat without a chat switch (used when sharing into the chat
  // that's already open).
  draftReloadKey?: number
  // Called after the user accepts a peer's changed E2E key so the parent can
  // re-fetch messages that were shown as placeholders under the old pin.
  onE2EKeyAccepted?: (peerUserId: number) => void
}

export function ChatWindow({
  chatId,
  messages,
  otherUserId,
  otherUsername,
  otherAvatar,
  currentUserId,
  loading,
  error,
  isConnected,
  isOtherUserOnline = false,
  otherUserLastSeen,
  deliveredUpTo = 0,
  readUpTo = 0,
  send,
  isMobile,
  onBackToList,
  onClearChat,
  onDeleteChat,
  isFavorites = false,
  isGroup = false,
  groupName = '',
  groupMembers = NO_GROUP_MEMBERS,
  onGroupUpdated,
  onGroupDeleted,
  onGroupLeft,
  pinnedMessages = [],
  canPin = false,
  onPinMessage,
  onUnpinMessage,
  draftReloadKey = 0,
  onE2EKeyAccepted,
}: Props) {
  const [messageText, setMessageText] = useState('')
  const [replyToId, setReplyToId] = useState<number | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [sending, setSending] = useState(false)
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false)
  const [isGroupInfoOpen, setIsGroupInfoOpen] = useState(false)
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [showEmojiPanel, setShowEmojiPanel] = useState(false)
  const [showPinnedBar, setShowPinnedBar] = useState(true)
  const [confirmAction, setConfirmAction] = useState<
    | { kind: 'clear' }
    | { kind: 'delete-chat' }
    | { kind: 'delete-message'; messageId: number }
    | null
  >(null)
  // The message currently being forwarded (snapshot taken at context-menu time),
  // and whether the encrypt+send is in flight. Drives the ForwardModal.
  const [forwardingMessage, setForwardingMessage] = useState<Message | null>(null)
  const [forwarding, setForwarding] = useState(false)
  const { e2eStatus, resetE2EStatus, handleAcceptKey, afterKeyAccepted } = useE2EStatus({
    chatId, isGroup, otherUserId, otherUsername, groupMembers, onKeyAccepted: onE2EKeyAccepted,
  })
  const { readDraft, clearDraft, persistDraft, currentText } = useChatDraft({
    chatId, draftReloadKey, messageText, setMessageText,
  })
  const menuRef = useRef<HTMLDivElement>(null)
  const pendingUploadRef = useRef<{ chatId: number; files: File[] } | null>(null)
  const prevMessagesLenRef = useRef(messages.length)

  // Latest messages snapshot for the forward action — lets handleForward stay
  // stable (empty deps) so the memoised MessageItem list isn't re-rendered on
  // every incoming message just because the forward callback changed identity.
  const messagesForwardRef = useRef(messages)
  useEffect(() => { messagesForwardRef.current = messages }, [messages])


  useEffect(() => {
    setMessageText(chatId ? readDraft(chatId) : '')
    setReplyToId(null)
    setEditingMessageId(null)
    setSelectedFiles([])
    setSending(false)
    setShowEmojiPanel(false)
    setShowPinnedBar(true)
    setIsSearchOpen(false)
    setIsMenuOpen(false)
    setIsGroupInfoOpen(false)
    setConfirmAction(null)
    setForwardingMessage(null)
    setForwarding(false)
    resetE2EStatus()
    pendingUploadRef.current = null

    // Safety net for the "switch chats" path: save the OLD chat's draft on
    // cleanup. The keystroke-debounced effect below handles the common cases.
    const leavingChatId = chatId
    return () => {
      if (!leavingChatId) return
      persistDraft(leavingChatId, currentText())
    }
  }, [chatId, readDraft, persistDraft, currentText, resetE2EStatus])





  // Close kebab menu on outside click
  useEffect(() => {
    if (!isMenuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isMenuOpen])

  const handleClearChat = useCallback(() => {
    if (!chatId) return
    setIsMenuOpen(false)
    setConfirmAction({ kind: 'clear' })
  }, [chatId])

  const handleDeleteChat = useCallback(() => {
    if (!chatId) return
    setIsMenuOpen(false)
    setConfirmAction({ kind: 'delete-chat' })
  }, [chatId])

  const handleConfirmAction = useCallback(() => {
    if (!chatId || !confirmAction) return
    const action = confirmAction
    setConfirmAction(null)
    if (action.kind === 'clear') {
      onClearChat?.(chatId)
    } else if (action.kind === 'delete-chat') {
      onDeleteChat?.(chatId)
    } else if (action.kind === 'delete-message') {
      send({ action: 'delete', chat_id: chatId, message_id: action.messageId })
    }
  }, [chatId, confirmAction, onClearChat, onDeleteChat, send])

  const { showToast } = useToast()
  const { callState, initiateCall } = useCallContext()
  const accountKeyCtx = useAccountKey()

  const handleStartCall = useCallback(() => {
    if (!chatId || !otherUserId || !otherUsername) return
    initiateCall(chatId, otherUserId, otherUsername, otherAvatar)
  }, [chatId, otherUserId, otherUsername, otherAvatar, initiateCall])

  // Upload files when the sender's new message arrives via WebSocket broadcast
  useEffect(() => {
    const prevLen = prevMessagesLenRef.current
    prevMessagesLenRef.current = messages.length

    // Clear sending state when a new message from current user arrives
    if (messages.length > prevLen) {
      const newMessage = messages[messages.length - 1]
      if (newMessage && newMessage.user_id === currentUserId) {
        setSending(false)
      }
    }

    if (!pendingUploadRef.current || messages.length <= prevLen) return

    // Find the newest message from the current user
    const newMessage = messages[messages.length - 1]
    if (!newMessage || newMessage.user_id !== currentUserId) return

    const { chatId: uploadChatId, files } = pendingUploadRef.current
    if (newMessage.chat_id !== uploadChatId || files.length === 0) return

    pendingUploadRef.current = null
    const messageId = newMessage.id

    const doUpload = async () => {
      setUploading(true)
      try {
        // E2E attachments: encrypt each file client-side, wrap the file_key
        // for every chat participant. Backend stores the opaque ciphertext
        // and the per-recipient envelopes; it can decrypt neither.
        const accountKey =
          accountKeyCtx.state.status === 'ready' ? accountKeyCtx.state.key : null
        if (!accountKey || !currentUserId || e2eStatus.kind !== 'ready') {
          throw new Error('E2E not ready — cannot upload attachments')
        }
        const recipients = await resolveAttachmentRecipients({
          isGroup,
          groupRecipients: e2eStatus.groupStatus?.recipients,
          peerUserId: otherUserId,
          senderUserId: currentUserId,
          senderAccountKey: accountKey,
        })
        if (!recipients) {
          throw new Error('failed to resolve recipient public_keys')
        }

        const formData = new FormData()
        type WireMeta = {
          file_iv: string
          encrypted_metadata: string
          metadata_iv: string
          envelopes: Array<{ recipient_id: number; encrypted_file_key: string; iv: string }>
        }
        const metas: WireMeta[] = []
        for (const file of files) {
          const prepared = await prepareAttachmentForUpload(file, recipients, accountKey)
          // Append the encrypted blob with an opaque filename so the multipart
          // Content-Disposition header doesn't leak the original name. The
          // real filename lives encrypted inside `encrypted_metadata` and is
          // recovered by the receiver post-decrypt. Server stores S3 objects
          // as `files/YYYY/MM/DD/{uuid}` (no extension either — backend
          // overrides multipart filename with "blob" for the storage key).
          formData.append('attachments', prepared.ciphertext, 'blob')
          metas.push({
            file_iv: prepared.fileIv,
            encrypted_metadata: prepared.encryptedMetadata,
            metadata_iv: prepared.metadataIv,
            envelopes: prepared.envelopes,
          })
        }
        formData.append('metadata', JSON.stringify(metas))

        await httpPost(endpoints.attachments.upload(uploadChatId, messageId), formData)
      } catch (err) {
        log.error('Ошибка загрузки вложений:', err)
        showToast('Не удалось загрузить вложения', 'error')
      } finally {
        setUploading(false)
      }
    }

    doUpload().catch(log.error)
  }, [messages, currentUserId, showToast, accountKeyCtx.state, e2eStatus, isGroup, otherUserId])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const text = messageText.trim()

    if (!chatId) {
      showToast('Выберите чат, чтобы отправлять сообщения', 'warning')
      return
    }

    if (!text && selectedFiles.length === 0) {
      showToast('Введите сообщение или прикрепите файлы', 'warning')
      return
    }

    if (!isConnected) {
      showToast('Соединение потеряно, ждём переподключения...', 'warning')
      return
    }

    // E2E is the ONLY supported scheme post-migration. We block the send if
    // any recipient isn't onboarded (the E2E status banner in the composer
    // shows who's missing). Same rules apply to edits — the backend only
    // accepts scheme=2 now, so trying to "downgrade" would just 400 anyway.
    const accountKey =
      accountKeyCtx.state.status === 'ready' ? accountKeyCtx.state.key : null
    if (!accountKey) {
      showToast('Шифрование не настроено. Перелогиньтесь, чтобы активировать.', 'error')
      return
    }
    // 'ready' and 'partial' both allow sending — partial just means some
    // members in the group won't get an envelope (they'll see "🔒" until they
    // onboard). Block on 'loading' (status still being fetched) and
    // 'not-ready' (1-on-1 with no peer key, or group where sender is missing
    // their own public_key).
    if (e2eStatus.kind === 'loading') {
      showToast('Проверяем статус шифрования, попробуйте через секунду.', 'info')
      return
    }
    if (e2eStatus.kind === 'not-ready') {
      const who = e2eStatus.missingMemberNames.join(', ')
      showToast(`Нельзя отправить — ${who} не настроил(и) шифрование.`, 'warning')
      return
    }

    const peerUserId = isGroup ? null : (otherUserId ?? null)
    const editTarget = editingMessageId
      ? messages.find((m) => m.id === editingMessageId)
      : null

    if (editingMessageId) {
      // Editing only makes sense on a scheme=2 message we sent ourselves —
      // legacy scheme=1 rows have no recoverable plaintext on this device.
      if (editTarget && editTarget.scheme !== 2) {
        showToast('Это сообщение нельзя редактировать.', 'warning')
        return
      }
      let payload: WSMessageAction
      if (isGroup && currentUserId && e2eStatus.kind === 'ready' && e2eStatus.groupStatus) {
        try {
          const envelopes = await encryptGroupMessage(text, e2eStatus.groupStatus, accountKey, currentUserId)
          payload = {
            action: 'edit',
            chat_id: chatId,
            message_id: editingMessageId,
            text: '',
            scheme: 2,
            envelopes,
          }
        } catch (err) {
          log.error('Group E2E re-encrypt failed on edit:', err)
          showToast('Не удалось зашифровать сообщение, повторите.', 'error')
          return
        }
      } else if (peerUserId !== null) {
        try {
          const chatKey = await getChatKey(accountKey, peerUserId)
          if (!chatKey) {
            showToast('Получатель отключил шифрование. Сообщение нельзя отправить.', 'warning')
            return
          }
          const { ciphertext, iv } = await encryptMessage(text, chatKey)
          payload = {
            action: 'edit',
            chat_id: chatId,
            message_id: editingMessageId,
            text: ciphertext,
            iv,
            scheme: 2,
          }
        } catch (err) {
          log.error('E2E encrypt failed on edit:', err)
          showToast('Не удалось зашифровать сообщение, повторите.', 'error')
          return
        }
      } else {
        showToast('Не удалось зашифровать сообщение.', 'error')
        return
      }
      const success = send(payload)
      if (success) {
        setMessageText('')
        setEditingMessageId(null)
        if (chatId) {
          clearDraft(chatId)
        }
      } else {
        showToast('Не удалось отправить изменение, повторите.', 'error')
      }
      return
    }

    // Store files for upload after message is created
    if (selectedFiles.length > 0) {
      pendingUploadRef.current = { chatId, files: [...selectedFiles] }
    }

    setSending(true)
    const rawText = text || ' '
    let outgoing: WSMessageAction

    try {
      if (isGroup && currentUserId && e2eStatus.kind === 'ready' && e2eStatus.groupStatus) {
        // Group pairwise: one envelope per current participant.
        const envelopes = await encryptGroupMessage(rawText, e2eStatus.groupStatus, accountKey, currentUserId)
        outgoing = {
          action: 'send',
          chat_id: chatId,
          text: '',
          scheme: 2,
          envelopes,
          reply_to_id: replyToId ?? undefined,
        }
      } else if (peerUserId !== null) {
        const chatKey = await getChatKey(accountKey, peerUserId)
        if (!chatKey) throw new Error('peer public_key disappeared between status check and send')
        const { ciphertext, iv } = await encryptMessage(rawText, chatKey)
        outgoing = {
          action: 'send',
          chat_id: chatId,
          text: ciphertext,
          iv,
          scheme: 2,
          reply_to_id: replyToId ?? undefined,
        }
      } else {
        throw new Error('no recipient — neither group nor peer userId')
      }
    } catch (err) {
      log.error('E2E encrypt failed on send:', err)
      pendingUploadRef.current = null
      setSending(false)
      showToast('Не удалось зашифровать сообщение, попробуйте ещё раз.', 'error')
      return
    }
    const success = send(outgoing)

    if (success) {
      setMessageText('')
      setReplyToId(null)
      setSelectedFiles([])
      if (chatId) {
        clearDraft(chatId)
      }
    } else {
      setSending(false)
      showToast('Не удалось отправить сообщение, повторите.', 'error')
      pendingUploadRef.current = null
    }
  }

  const handleFileSelect = (files: File[]) => {
    setSelectedFiles((prev) => [...prev, ...files])
  }

  const handleRemoveFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, idx) => idx !== index))
  }

  // Stable refs so the memoised MessageItem doesn't re-render the whole list on every
  // parent state change. Setters from useState are already stable; only chatId + send
  // change identity.
  const handleReply = useCallback((msgId: number) => {
    setEditingMessageId(null)
    setReplyToId(msgId)
    setMessageText('')
  }, [])

  const handleEdit = useCallback((msgId: number, text: string) => {
    setReplyToId(null)
    setEditingMessageId(msgId)
    setMessageText(text)
  }, [])

  const handleDelete = useCallback((msgId: number) => {
    if (!chatId) return
    setConfirmAction({ kind: 'delete-message', messageId: msgId })
  }, [chatId])

  // Open the forward picker with a snapshot of the chosen message. Read from a
  // ref so this callback stays stable (keeps the memoised MessageItem list from
  // re-rendering on every incoming message).
  const handleForward = useCallback((msgId: number) => {
    const msg = messagesForwardRef.current.find((m) => m.id === msgId)
    if (msg) setForwardingMessage(msg)
  }, [])

  // Forward a message (text and/or attachments) into the destination chat via
  // the /forward endpoint. E2E: the body the user sees in state is already
  // decrypted, so text is re-encrypted for the destination; attachment bodies
  // stay in S3 (server-copied) and only their file_key is re-wrapped for the
  // destination recipients (rewrapAttachmentEnvelopes). The server never sees
  // plaintext or any file_key.
  const handleForwardToChat = useCallback(async (dest: ChatItem) => {
    if (!forwardingMessage) return
    const accountKey =
      accountKeyCtx.state.status === 'ready' ? accountKeyCtx.state.key : null
    if (!accountKey || !currentUserId) {
      showToast('Шифрование не настроено. Перелогиньтесь, чтобы активировать.', 'error')
      return
    }
    // Only attachments we hold our own envelope for can be re-wrapped.
    const sourceAttachments = (forwardingMessage.attachments ?? []).filter(
      (a) => a.id && a.encrypted_file_key && a.envelope_iv,
    )
    const hasAttachments = sourceAttachments.length > 0
    // Re-encrypt the source's plaintext; for an attachment-only message use a
    // single space (the send path's empty-text placeholder).
    const rawText = forwardingMessage.text.trim() || (hasAttachments ? ' ' : '')
    if (!rawText) {
      showToast('Нечего пересылать.', 'warning')
      return
    }
    // Preserve the original author across re-forwards (chains collapse to the
    // first author, like Telegram). `||` not `??`: the wire's 0 sentinel must
    // fall through to user_id.
    const forwardedFrom = forwardingMessage.forwarded_from_user_id || forwardingMessage.user_id
    setForwarding(true)
    try {
      const payload: ForwardPayload = { text: '', scheme: 2, forwarded_from_user_id: forwardedFrom }
      // Destination recipients — needed to re-wrap attachment file_keys.
      let recipients: GroupRecipientKey[] | null = null

      if (dest.is_group) {
        const status = await getGroupKeyStatus(dest.id)
        if (!status || status.missingUserIds.length > 0 || status.changedUserIds.length > 0) {
          showToast('Нельзя переслать — не все участники настроили шифрование.', 'warning')
          return
        }
        recipients = status.recipients
        payload.envelopes = await encryptGroupMessage(rawText, status, accountKey, currentUserId)
      } else if (dest.other_user_id) {
        const chatKey = await getChatKey(accountKey, dest.other_user_id)
        if (!chatKey) {
          showToast('Получатель не настроил шифрование. Нельзя переслать.', 'warning')
          return
        }
        const encrypted = await encryptMessage(rawText, chatKey)
        payload.text = encrypted.ciphertext
        payload.iv = encrypted.iv
        recipients = await resolveAttachmentRecipients({
          isGroup: false,
          peerUserId: dest.other_user_id,
          senderUserId: currentUserId,
          senderAccountKey: accountKey,
        })
      } else {
        showToast('Не удалось определить получателя.', 'error')
        return
      }

      if (hasAttachments && recipients) {
        const recips = recipients
        payload.attachments = await Promise.all(
          sourceAttachments.map(async (att) => ({
            source_attachment_id: att.id as number,
            envelopes: await rewrapAttachmentEnvelopes({
              ownEncryptedFileKey: att.encrypted_file_key as string,
              ownEnvelopeIv: att.envelope_iv as string,
              sourceSenderUserId: forwardingMessage.user_id,
              recipients: recips,
              accountKey,
            }),
          })),
        )
      }

      await forwardMessage(dest.id, payload)
      setForwardingMessage(null)
      showToast('Переслано', 'success')
    } catch (err) {
      log.error('Forward failed:', err)
      showToast('Не удалось переслать сообщение, повторите.', 'error')
    } finally {
      setForwarding(false)
    }
  }, [forwardingMessage, accountKeyCtx.state, currentUserId, showToast])

  const handleCancelDraft = () => {
    setReplyToId(null)
    setEditingMessageId(null)
    setMessageText('')
  }

  const handleAddEmoji = useCallback((emoji: string) => {
    setMessageText((prev) => prev + emoji)
  }, [])

  const handleToggleEmoji = useCallback(() => {
    setShowEmojiPanel((prev) => !prev)
  }, [])

  const pinnedMessageIds = useMemo(
    () => new Set(pinnedMessages.map((p) => p.message_id)),
    [pinnedMessages],
  )

  const handlePin = useCallback(
    (msgId: number) => {
      if (chatId) onPinMessage?.(chatId, msgId)
    },
    [chatId, onPinMessage],
  )

  const handleUnpin = useCallback(
    (msgId: number) => {
      if (chatId) onUnpinMessage?.(chatId, msgId)
    },
    [chatId, onUnpinMessage],
  )

  const scrollToMessage = useCallback((messageId: number, highlight = true) => {
    const el = document.getElementById(`msg-${messageId}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      if (highlight) {
        el.classList.add('highlight')
        setTimeout(() => el.classList.remove('highlight'), 2000)
      }
    }
  }, [])

  const displayName = isGroup ? groupName : otherUsername
  const displayAvatar = otherAvatar

  if (!chatId || (!displayName && !isGroup)) {
    return (
      <div className="chat-window glassy empty-chat-panel">
        <div className="empty-hero">
          <div className="empty-hero__badge">NexaChat</div>
          <h2>Начните новый разговор</h2>
          <p className="text-muted">Выберите контакт слева или создайте чат по username.</p>
          <div className="empty-hero__cta">
            <span className="dot online" />
            <span>Готовы к мгновенным сообщениям</span>
          </div>
        </div>
      </div>
    )
  }

  const handleHeaderClick = () => {
    if (isFavorites) {
      // Self-chat header is informational only — there's no peer profile to show.
      return
    }
    if (isGroup) {
      setIsGroupInfoOpen(true)
    } else {
      setIsProfileModalOpen(true)
    }
  }

  return (
    <div className={`chat-window glassy${showEmojiPanel ? ' chat-window--emoji-open' : ''}`}>
      <div className="chat-window__main">
        <div className="chat-header">
          <div className="chat-header__title">
            {isMobile && (
              <button className="back-btn" onClick={onBackToList} aria-label="Назад">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </button>
            )}
            <button
              type="button"
              className="chat-header__link"
              onClick={handleHeaderClick}
              style={isFavorites ? { cursor: 'default' } : undefined}
            >
              <span className="avatar avatar-sm">
                {isFavorites ? (
                  <span
                    className="d-flex align-items-center justify-content-center"
                    style={{ background: 'var(--bs-primary, #2481cc)', color: '#fff', width: '100%', height: '100%', borderRadius: '50%' }}
                  >
                    <BookmarkIcon size={18} />
                  </span>
                ) : (
                  <img src={resolveApiUrl(displayAvatar) || '/img/default-avatar.svg'} alt="avatar" />
                )}
              </span>
              <div className="chat-header__info">
                <span className="chat-peer">{displayName}</span>
                <div className="chat-header__meta">
                  {isFavorites ? (
                    <span className="chat-subtitle">Сообщения только для вас</span>
                  ) : isGroup ? (
                    <span className="chat-subtitle">{groupMembers.length} участник(ов)</span>
                  ) : (
                    <>
                      <span className={`dot ${isOtherUserOnline ? 'online' : 'offline'}`} />
                      <span className="chat-subtitle">
                        {isOtherUserOnline ? 'В сети' : formatLastSeen(otherUserLastSeen) || 'Не в сети'}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </button>
          </div>
          <div className="chat-header__actions">
            {!isGroup && !isFavorites && otherUserId && (
              <button
                className="chat-header__call-btn"
                onClick={handleStartCall}
                disabled={callState.status !== 'idle' || !isOtherUserOnline}
                aria-label="Аудиозвонок"
              >
                <PhoneIcon size={20} />
              </button>
            )}
            <div className="chat-menu" ref={menuRef}>
              <button
                className="chat-header__menu-btn"
                onClick={() => setIsMenuOpen((v) => !v)}
                aria-label="Меню чата"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                  <circle cx="12" cy="5" r="1.5" />
                  <circle cx="12" cy="12" r="1.5" />
                  <circle cx="12" cy="19" r="1.5" />
                </svg>
              </button>
              {isMenuOpen && (
                <div className="chat-menu__dropdown">
                  <button
                    className="chat-menu__item"
                    onClick={() => {
                      setIsSearchOpen(true)
                      setIsMenuOpen(false)
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                      <circle cx="11" cy="11" r="8" />
                      <path d="m21 21-4.35-4.35" />
                    </svg>
                    Поиск
                  </button>
                  <button className="chat-menu__item" onClick={handleClearChat}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                      <path d="M12 2v6M12 22v-6M4.93 4.93l4.24 4.24M14.83 14.83l4.24 4.24M2 12h6M22 12h-6M4.93 19.07l4.24-4.24M14.83 9.17l4.24-4.24" />
                    </svg>
                    Очистить чат
                  </button>
                  {!isGroup && !isFavorites && (
                    <button className="chat-menu__item chat-menu__item--danger" onClick={handleDeleteChat}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                      Удалить чат
                    </button>
                  )}
                </div>
              )}
            </div>
            {!isConnected && (
              <span className="badge bg-warning text-dark">Reconnecting</span>
            )}
          </div>
        </div>

        {isSearchOpen && (
          <ChatSearch
            messages={messages}
            onResultClick={(messageId) => {
              setIsSearchOpen(false)
              scrollToMessage(messageId)
            }}
            onClose={() => setIsSearchOpen(false)}
          />
        )}

        {showPinnedBar && pinnedMessages.length > 0 && (
          <PinnedMessagesBar
            pinnedMessages={pinnedMessages}
            onScrollToMessage={(id) => scrollToMessage(id, false)}
            onClose={() => setShowPinnedBar(false)}
          />
        )}

        <MessageList
          messages={messages}
          currentUserId={currentUserId}
          otherUsername={otherUsername || groupName}
          isGroup={isGroup}
          groupMembers={groupMembers}
          loading={loading}
          error={error}
          isFavorites={isFavorites}
          deliveredUpTo={deliveredUpTo}
          readUpTo={readUpTo}
          onReply={handleReply}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onForward={handleForward}
          pinnedMessageIds={pinnedMessageIds}
          canPin={canPin}
          onPin={handlePin}
          onUnpin={handleUnpin}
          onJumpToMessage={scrollToMessage}
        />

        {e2eStatus.kind === 'key-changed' && (
          <div className="e2e-banner e2e-banner--danger" role="alert">
            ⚠️ Ключ шифрования {e2eStatus.peers.map((p) => p.name).join(', ')} изменился. Так бывает,
            если собеседник заново настроил шифрование, но так же выглядит и попытка
            перехватить переписку. Сверьте код безопасности в профиле, прежде чем принимать новый ключ.
            <div className="e2e-banner__actions">
              {!isGroup && (
                <button type="button" className="e2e-banner__btn" onClick={() => setIsProfileModalOpen(true)}>
                  Сверить код
                </button>
              )}
              {e2eStatus.peers.map((p) => (
                <button key={p.userId} type="button" className="e2e-banner__btn" onClick={() => handleAcceptKey(p.userId)}>
                  Принять новый ключ{e2eStatus.peers.length > 1 ? `: ${p.name}` : ''}
                </button>
              ))}
            </div>
          </div>
        )}
        {e2eStatus.kind === 'not-ready' && (
          <div
            style={{
              padding: '8px 12px',
              background: 'rgba(255, 193, 7, 0.12)',
              borderTop: '1px solid rgba(255, 193, 7, 0.3)',
              color: '#ffc107',
              fontSize: 13,
              lineHeight: 1.4,
            }}
          >
            🔒 Шифрование не активно: {e2eStatus.missingMemberNames.join(', ')}
            {e2eStatus.missingMemberNames.length === 1 ? ' не настроил(а)' : ' не настроили'} шифрование.
            Отправка возможна, когда{' '}
            {e2eStatus.missingMemberNames.length === 1 ? 'он(а)' : 'все'} зайдут в приложение.
          </div>
        )}
        <MessageComposer
          messages={messages}
          replyToId={replyToId}
          editingMessageId={editingMessageId}
          messageText={messageText}
          selectedFiles={selectedFiles}
          uploading={uploading}
          sending={sending}
          showEmojiPanel={showEmojiPanel}
          onMessageTextChange={setMessageText}
          onSubmit={handleSubmit}
          onFileSelect={handleFileSelect}
          onRemoveFile={handleRemoveFile}
          onCancelDraft={handleCancelDraft}
          onToggleEmoji={handleToggleEmoji}
          disabled={e2eStatus.kind !== 'ready'}
        />
      </div>

      {showEmojiPanel && (
        <EmojiPicker
          onSelect={handleAddEmoji}
          onClose={() => setShowEmojiPanel(false)}
        />
      )}

      {!isGroup && otherUserId && (
        <UserProfileModal
          isOpen={isProfileModalOpen}
          onClose={() => setIsProfileModalOpen(false)}
          userId={otherUserId}
          username={otherUsername || ''}
          avatarUrl={otherAvatar}
          isOnline={isOtherUserOnline}
          onKeyAccepted={afterKeyAccepted}
        />
      )}

      {isGroup && currentUserId && (
        <GroupInfoPanel
          isOpen={isGroupInfoOpen}
          onClose={() => setIsGroupInfoOpen(false)}
          chatId={chatId}
          groupName={groupName}
          avatarUrl={displayAvatar}
          members={groupMembers}
          currentUserId={currentUserId}
          onGroupUpdated={() => { onGroupUpdated?.() }}
          onGroupDeleted={() => { setIsGroupInfoOpen(false); onGroupDeleted?.() }}
          onGroupLeft={() => { setIsGroupInfoOpen(false); onGroupLeft?.() }}
        />
      )}

      <ForwardModal
        isOpen={forwardingMessage !== null}
        onClose={() => setForwardingMessage(null)}
        currentChatId={chatId}
        busy={forwarding}
        onSelect={handleForwardToChat}
      />

      <ConfirmDialog
        isOpen={confirmAction !== null}
        title={
          confirmAction?.kind === 'clear' ? 'Очистить чат?' :
          confirmAction?.kind === 'delete-chat' ? 'Удалить чат?' :
          'Удалить сообщение?'
        }
        message={
          confirmAction?.kind === 'clear' ? 'Все сообщения в этом чате будут удалены.' :
          confirmAction?.kind === 'delete-chat' ? 'Это действие нельзя отменить.' :
          undefined
        }
        confirmLabel={
          confirmAction?.kind === 'clear' ? 'Очистить' :
          confirmAction?.kind === 'delete-chat' ? 'Удалить' :
          'Удалить'
        }
        variant="danger"
        onConfirm={handleConfirmAction}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  )
}
