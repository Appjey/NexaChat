import { useEffect, useState } from 'react'

import { getCurrentUserChats } from '../../shared/api/chatsApi'
import { resolveApiUrl } from '../../shared/api/httpClient'
import type { ChatItem } from '../../shared/api/types'
import { Avatar } from '../../shared/components/Avatar'
import { CloseIcon, GroupIcon, SearchIcon } from '../../shared/components/Icons'
import { useAndroidBack } from '../../shared/hooks/useAndroidBack'
import { useModalBehavior } from '../../shared/hooks/useModalBehavior'
import { log } from '../../shared/log'

type Props = {
  isOpen: boolean
  onClose: () => void
  // The chat we're forwarding *from* — excluded from the destination list.
  currentChatId?: number
  // True while the parent is encrypting + sending the forward; disables the button.
  busy?: boolean
  onSelect: (chat: ChatItem) => void
  // Header / button copy; defaults to the "forward" wording.
  title?: string
  confirmLabel?: string
  busyLabel?: string
}

function getChatDisplayName(chat: ChatItem): string {
  if (chat.is_favorites) return 'Избранное'
  if (chat.is_group) return chat.group_name || 'Группа'
  return chat.other_user_name || 'Чат'
}

export function ForwardModal({
  isOpen,
  onClose,
  currentChatId,
  busy,
  onSelect,
  title = 'Переслать в…',
  confirmLabel = 'Переслать',
  busyLabel = 'Пересылаем...',
}: Props) {
  const [chats, setChats] = useState<ChatItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const { handleBackdropClick } = useModalBehavior({ isOpen, onClose })
  useAndroidBack(() => { onClose(); return true }, isOpen)

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    const load = async () => {
      // Reset picker state so each open starts on a clean, unfiltered list.
      setSearch('')
      setSelectedId(null)
      setLoading(true)
      try {
        const data = await getCurrentUserChats()
        if (!cancelled) setChats(data)
      } catch (err) {
        log.error('Failed to load chats:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [isOpen])

  const availableChats = chats.filter((c) => c.id !== currentChatId)

  const normalizedTokens = search
    .replace(/^@/, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  const filteredChats = normalizedTokens.length === 0
    ? availableChats
    : availableChats.filter((c) => {
        const name = getChatDisplayName(c).toLowerCase()
        return normalizedTokens.every((t) => name.includes(t))
      })

  const handleConfirm = () => {
    if (selectedId === null) return
    const chat = availableChats.find((c) => c.id === selectedId)
    if (chat) onSelect(chat)
  }

  if (!isOpen) return null

  return (
    <div className="contacts-modal-backdrop" onClick={handleBackdropClick}>
      <div className="contacts-modal" role="dialog" aria-modal="true">
        <div className="contacts-modal__header">
          <h2 className="contacts-modal__title">{title}</h2>
          <button className="contacts-modal__close" onClick={onClose} aria-label="Закрыть">
            <CloseIcon />
          </button>
        </div>

        <div className="contacts-modal__search">
          <SearchIcon />
          <input
            type="text"
            placeholder="Поиск чатов..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </div>

        <div className="contacts-modal__list" role="list">
          {loading ? (
            <div className="contacts-modal__empty">
              <span className="contacts-modal__spinner" style={{ width: 20, height: 20, borderWidth: 2, display: 'inline-block', verticalAlign: 'middle' }} />
            </div>
          ) : filteredChats.length === 0 ? (
            <div className="contacts-modal__empty">
              {search ? 'Ничего не найдено' : 'Нет доступных чатов'}
            </div>
          ) : (
            filteredChats.map((chat) => {
              const isSelected = selectedId === chat.id
              const displayName = getChatDisplayName(chat)
              return (
                <div
                  key={chat.id}
                  className={`contacts-modal__item${isSelected ? ' contacts-modal__item--selected' : ''}`}
                  role="listitem"
                  onClick={() => setSelectedId(chat.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <div className="contacts-modal__avatar-wrap">
                    <Avatar
                      name={displayName}
                      avatarUrl={resolveApiUrl(chat.avatar_url)}
                      size="md"
                      isFavorites={chat.is_favorites}
                    />
                  </div>
                  <div className="contacts-modal__info">
                    <span className="contacts-modal__name">
                      {chat.is_group && <GroupIcon className="chat-list-item__group-icon" size={14} />}
                      {displayName}
                    </span>
                    {chat.is_group && (
                      <span className="contacts-modal__username">{chat.member_count ?? 0} участник(ов)</span>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="create-group__footer">
          <button className="btn btn-outline-secondary me-2" onClick={onClose}>
            Отмена
          </button>
          <button
            className="btn btn-primary flex-grow-1"
            onClick={handleConfirm}
            disabled={selectedId === null || busy}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
