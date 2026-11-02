import { useMemo } from 'react'

import { resolveApiUrl } from '../../shared/api/httpClient'
import type { ChatItem } from '../../shared/api/types'
import { Avatar } from '../../shared/components/Avatar'
import { GroupIcon } from '../../shared/components/Icons'

type Props = {
  chats: ChatItem[]
  activeChatId?: number
  onSelect: (chatId: number) => void
  loading?: boolean
  error?: string | null
  hasActiveFilter?: boolean
  onResetFilter?: () => void
  onlineUsers?: Set<number>
}

function getChatDisplayName(chat: ChatItem): string {
  if (chat.is_favorites) return 'Избранное'
  if (chat.is_group) return chat.group_name || 'Группа'
  return chat.other_user_name || 'Чат'
}

export function ChatList({
  chats,
  activeChatId,
  onSelect,
  loading,
  error,
  hasActiveFilter = false,
  onResetFilter,
  onlineUsers,
}: Props) {
  // Favorites is always pinned to the top regardless of last activity; remaining
  // chats stay in updated_at-desc order (matches the server's bucketing).
  const sortedChats = useMemo(
    () =>
      [...chats].sort((a, b) => {
        if (a.is_favorites && !b.is_favorites) return -1
        if (!a.is_favorites && b.is_favorites) return 1
        return b.updated_at.localeCompare(a.updated_at)
      }),
    [chats],
  )

  return (
    <div className="telegram-chat-list">
      {error && <div className="alert alert-danger alert-sm m-2">{error}</div>}

      {/* Chat list items */}
      <div className="telegram-chat-list__items fancy-scroll">
        {loading ? (
          <div className="telegram-empty-list">
            <p className="text-muted small">Загружаем диалоги...</p>
          </div>
        ) : sortedChats.length === 0 ? (
          hasActiveFilter ? (
            <div className="telegram-empty-list telegram-empty-list--search">
              <div className="telegram-empty-list__icon" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </div>
              <p className="telegram-empty-list__title">Ничего не найдено</p>
              <p className="telegram-empty-list__subtitle">
                Попробуйте другое имя, @username или ключевое слово.
              </p>
              {onResetFilter && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm telegram-empty-list__reset"
                  onClick={onResetFilter}
                >
                  Сбросить поиск
                </button>
              )}
            </div>
          ) : (
            <div className="telegram-empty-list">
              <p className="telegram-empty-list__title">Пока пусто</p>
              <p className="telegram-empty-list__subtitle">
                Добавьте контакт и начните общение
              </p>
            </div>
          )
        ) : (
          <ul className="telegram-chat-ul">
            {sortedChats.map((chat) => {
              const isActive = chat.id === activeChatId
              const hasUnread = chat.unread_count > 0
              const displayName = getChatDisplayName(chat)
              const isOnline =
                !chat.is_group &&
                !chat.is_favorites &&
                Boolean(chat.other_user_id && onlineUsers?.has(chat.other_user_id))

              return (
                <li
                  key={chat.id}
                  className={`chat-list-item${isActive ? ' active' : ''}${hasUnread ? ' has-unread' : ''}`}
                  role="button"
                  onClick={() => onSelect(chat.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelect(chat.id)
                    }
                  }}
                  tabIndex={0}
                >
                  <Avatar
                    name={displayName}
                    avatarUrl={resolveApiUrl(chat.avatar_url)}
                    size="md"
                    isFavorites={chat.is_favorites}
                    online={isOnline}
                  />
                  <div className="chat-list-item-content">
                    <div className="chat-list-item__top">
                      <span className="chat-list-item__name">
                        {chat.is_group && (
                          <GroupIcon className="chat-list-item__group-icon" size={14} />
                        )}
                        {displayName}
                      </span>
                      <span className="chat-list-item__time">
                        {chat.is_favorites
                          ? 'закреплён'
                          : new Date(chat.updated_at).toLocaleTimeString('ru-RU', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                      </span>
                    </div>
                    <div className="chat-list-item__preview">
                      <span className="chat-list-item__message text-truncate">
                        {chat.last_message || (chat.is_favorites ? 'Личные заметки и ссылки' : 'Нет сообщений')}
                      </span>
                      {hasUnread && (
                        <span className="unread-badge">{chat.unread_count}</span>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
