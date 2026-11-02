import { useEffect, useMemo, useRef } from 'react'

import type { GroupMember, Message } from '../../shared/api/types'
import { MessageItem } from './MessageItem'
import { SystemMessage } from './SystemMessage'

type Props = {
  messages: Message[]
  currentUserId?: number
  otherUsername: string
  isGroup?: boolean
  groupMembers?: GroupMember[]
  loading?: boolean
  error?: string | null
  // Self-chat (Saved Messages): suppress read receipts — talking to yourself.
  isFavorites?: boolean
  e2eReady?: boolean
  // Peer's read-receipt pointers (1-on-1): highest message id delivered / read.
  deliveredUpTo?: number
  readUpTo?: number
  pinnedMessageIds?: Set<number>
  canPin?: boolean
  onReply: (msgId: number) => void
  onEdit: (msgId: number, text: string) => void
  onDelete: (msgId: number) => void
  onForward: (msgId: number) => void
  onPin?: (msgId: number) => void
  onUnpin?: (msgId: number) => void
  onJumpToMessage?: (msgId: number) => void
}

// Deterministic color palette for group sender names
const SENDER_COLORS = [
  '#e57373', '#f06292', '#ba68c8', '#9575cd',
  '#7986cb', '#64b5f6', '#4fc3f7', '#4dd0e1',
  '#4db6ac', '#81c784', '#aed581', '#ff8a65',
]

function getSenderColor(userId: number): string {
  return SENDER_COLORS[userId % SENDER_COLORS.length]
}

function getSenderName(
  message: Message,
  currentUserId: number | undefined,
  otherUsername: string,
  isGroup: boolean,
  membersMap: Map<number, GroupMember>,
): string {
  if (message.user_id === currentUserId) return 'Вы'
  if (isGroup) {
    const member = membersMap.get(message.user_id)
    return member?.name || member?.username || `User #${message.user_id}`
  }
  return otherUsername
}

export function MessageList({
  messages,
  currentUserId,
  otherUsername,
  isGroup = false,
  groupMembers = [],
  loading,
  error,
  isFavorites = false,
  e2eReady = false,
  deliveredUpTo = 0,
  readUpTo = 0,
  pinnedMessageIds,
  canPin,
  onReply,
  onEdit,
  onDelete,
  onForward,
  onPin,
  onUnpin,
  onJumpToMessage,
}: Props) {
  // Build a lookup map for group members
  const membersMap = new Map(groupMembers.map((m) => [m.user_id, m]))

  // Reverse messages for column-reverse layout:
  // CSS column-reverse flips visual order, so we reverse the array
  // to display oldest→newest (top→bottom) while scroll starts at bottom
  const reversedMessages = useMemo(() => messages.slice().reverse(), [messages])

  // Auto-scroll to newest message. Column-reverse layout means scrollTop=0 is the visual bottom.
  // Android WebView loses the column-reverse scroll anchor when the list updates, so we pin it manually:
  // - always pin when the caller sent the message (they just hit send)
  // - pin when the user is already near the bottom (live-reading)
  // - leave alone when the user scrolled up reading history (don't yank them down)
  const containerRef = useRef<HTMLDivElement>(null)
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : undefined
  const lastMessageOwner = messages.length > 0 ? messages[messages.length - 1].user_id : undefined
  useEffect(() => {
    const el = containerRef.current
    if (!el || lastMessageId === undefined) return
    const isOwn = lastMessageOwner === currentUserId
    // In column-reverse, scrollTop is 0 at the bottom and negative as you scroll up.
    const isNearBottom = el.scrollTop > -120
    if (isOwn || isNearBottom) {
      el.scrollTop = 0
    }
  }, [lastMessageId, lastMessageOwner, currentUserId])

  const renderContent = () => {
    if (error) {
      return <div className="alert alert-danger m-3">{error}</div>
    }

    if (loading) {
      return <div className="text-center p-4 text-muted">Загружаем сообщения...</div>
    }

    if (messages.length === 0) {
      return <div className="text-center text-muted p-4">В этом чате пока нет сообщений.</div>
    }

    return reversedMessages.map((message) => {
      // Deleted messages are kept in the array so reply quotes can still resolve them,
      // but they are not rendered as standalone messages in the chat.
      if (message.is_deleted) return null

      if (message.type === 'system') {
        return <SystemMessage key={message.id} text={message.text} />
      }

      const isOwn = message.user_id === currentUserId
      const senderName = getSenderName(message, currentUserId, otherUsername, isGroup, membersMap)
      const replyToMessage = message.reply_to_id
        ? messages.find((m) => m.id === message.reply_to_id)
        : null

      // Read-receipt tick state for our own 1-on-1 messages. Monotonic ids mean
      // "read up to N" covers everything earlier. Undefined elsewhere (incoming,
      // groups, self-chat) so the memoised MessageItem skips re-rendering those.
      const receiptStatus = isOwn && !isGroup && !isFavorites
        ? (message.id <= readUpTo ? 'read' : message.id <= deliveredUpTo ? 'delivered' : 'sent')
        : undefined

      return (
        <MessageItem
          key={message.id}
          message={message}
          isOwn={isOwn}
          senderName={senderName}
          showSenderName={isGroup && !isOwn}
          senderColor={isGroup && !isOwn ? getSenderColor(message.user_id) : undefined}
          currentUserId={currentUserId}
          receiptStatus={receiptStatus}
          replyToMessage={replyToMessage}
          isPinned={pinnedMessageIds?.has(message.id)}
          canPin={canPin}
          onReply={onReply}
          onEdit={onEdit}
          onDelete={onDelete}
          onForward={onForward}
          onPin={onPin}
          onUnpin={onUnpin}
          onJumpToMessage={onJumpToMessage}
        />
      )
    })
  }

  return (
    <div id="messages" className="chat-body fancy-scroll" ref={containerRef}>
      {renderContent()}
      {e2eReady && !loading && !error && (
        <div className="chat-e2e-pill">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span>Сквозное шифрование</span>
        </div>
      )}
    </div>
  )
}
