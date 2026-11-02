import { useEffect, useState } from 'react'

import { addContact, getContacts, searchUsers } from '../../shared/api/contactsApi'
import { resolveApiUrl } from '../../shared/api/httpClient'
import type { UserListItem } from '../../shared/api/types'
import { Avatar } from '../../shared/components/Avatar'
import { ConfirmDialog } from '../../shared/components/ConfirmDialog'
import { CheckIcon, CloseIcon, PersonAddIcon, TrashIcon } from '../../shared/components/Icons'
import { useAndroidBack } from '../../shared/hooks/useAndroidBack'
import { useLongPress } from '../../shared/hooks/useLongPress'
import { useModalBehavior } from '../../shared/hooks/useModalBehavior'
import { log } from '../../shared/log'

type Props = {
  isOpen: boolean
  onClose: () => void
  onSelectContact: (contact: UserListItem) => void | Promise<void>
  onRemoveContact?: (userId: number) => void | Promise<void>
}

type RowProps = {
  user: UserListItem
  index: number
  isContact: boolean
  isLoading: boolean
  isAdding: boolean
  isSelected: boolean
  selectionMode: boolean
  canSelect: boolean
  onStartChat: (user: UserListItem) => void
  onAddContact: (user: UserListItem) => void
  onToggleSelect: (userId: number) => void
}

function ContactRow({
  user,
  index,
  isContact,
  isLoading,
  isAdding,
  isSelected,
  selectionMode,
  canSelect,
  onStartChat,
  onAddContact,
  onToggleSelect,
}: RowProps) {
  const longPress = useLongPress(() => {
    if (canSelect) onToggleSelect(user.id)
  })

  const handleRowClick = () => {
    if (selectionMode) {
      if (canSelect) onToggleSelect(user.id)
      return
    }
    if (isLoading) return
    onStartChat(user)
  }

  return (
    <div
      className={`contacts-modal__item${isSelected ? ' contacts-modal__item--selected' : ''}`}
      style={{ animationDelay: `${index * 30}ms` }}
      role="listitem"
      onClick={handleRowClick}
      {...longPress}
    >
      <div className="contacts-modal__avatar-wrap">
        <Avatar
          name={user.name || user.username}
          avatarUrl={resolveApiUrl(user.avatar_url)}
          size="md"
        />
        {isSelected && (
          <span className="contacts-modal__select-badge" aria-hidden="true">
            <CheckIcon size={12} />
          </span>
        )}
      </div>
      <div className="contacts-modal__info">
        <span className="contacts-modal__name">{user.name}</span>
        <span className="contacts-modal__username">@{user.username}</span>
      </div>

      <div className="contacts-modal__actions-group" onClick={(e) => e.stopPropagation()}>
        {isLoading && <span className="contacts-modal__spinner" />}
        {/* Add-to-contacts is the only inline action that survives — it's non-destructive and
            its bright green styling makes it obviously a separate target from the row body. */}
        {!isContact && !selectionMode && (
          <button
            className="contacts-modal__action-btn contacts-modal__action-btn--add"
            onClick={() => onAddContact(user)}
            disabled={isAdding}
            tabIndex={0}
            title="Добавить в контакты"
            aria-label="Добавить в контакты"
          >
            {isAdding ? <span className="contacts-modal__spinner" /> : <PersonAddIcon size={22} />}
          </button>
        )}
      </div>
    </div>
  )
}

function pluralContacts(n: number) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'контакт'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'контакта'
  return 'контактов'
}

export function ContactsModal({ isOpen, onClose, onSelectContact, onRemoveContact }: Props) {
  const [contacts, setContacts] = useState<UserListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<UserListItem[]>([])
  const [searching, setSearching] = useState(false)
  const [startingId, setStartingId] = useState<number | null>(null)
  const [addingId, setAddingId] = useState<number | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const [bulkRemoving, setBulkRemoving] = useState(false)
  const { handleBackdropClick } = useModalBehavior({ isOpen, onClose })

  const selectionMode = selectedIds.size > 0

  // Android back: in selection mode → exit selection first; otherwise close the modal.
  useAndroidBack(() => {
    if (selectionMode) {
      setSelectedIds(new Set())
      return true
    }
    onClose()
    return true
  }, isOpen)

  useEffect(() => {
    if (!isOpen) return

    let cancelled = false
    setLoading(true)
    getContacts()
      .then((data) => {
        if (!cancelled) setContacts(data)
      })
      .catch(log.error)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) {
      setSearch('')
      setSearchResults([])
      setSearching(false)
      setSelectedIds(new Set())
      setBulkConfirmOpen(false)
    }
  }, [isOpen])

  useEffect(() => {
    const query = search.replace(/^@/, '').trim()
    if (query.length < 2) {
      setSearchResults([])
      return
    }

    const timeout = setTimeout(async () => {
      setSearching(true)
      try {
        const users = await searchUsers(query)
        setSearchResults(users)
      } catch (err) {
        log.error('Search failed:', err)
      } finally {
        setSearching(false)
      }
    }, 300)

    return () => clearTimeout(timeout)
  }, [search])

  const handleStartChat = async (contact: UserListItem) => {
    setStartingId(contact.id)
    try {
      await onSelectContact(contact)
      onClose()
    } finally {
      setStartingId(null)
    }
  }

  const handleAddContact = async (user: UserListItem) => {
    setAddingId(user.id)
    try {
      await addContact(user.id)
      setContacts((prev) => [...prev, user])
    } catch (err) {
      log.error('Failed to add contact:', err)
    } finally {
      setAddingId(null)
    }
  }

  const handleToggleSelect = (userId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }

  const handleBulkDelete = async () => {
    if (!onRemoveContact || selectedIds.size === 0) return
    setBulkRemoving(true)
    const idsToRemove = Array.from(selectedIds)
    try {
      // Remove in parallel; partial failure is acceptable (server is the source of truth —
      // we drop locally only the ones that succeeded).
      const results = await Promise.allSettled(idsToRemove.map((id) => onRemoveContact(id)))
      const succeeded = new Set<number>()
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') succeeded.add(idsToRemove[i])
      })
      setContacts((prev) => prev.filter((c) => !succeeded.has(c.id)))
      setSelectedIds(new Set())
      setBulkConfirmOpen(false)
    } finally {
      setBulkRemoving(false)
    }
  }

  const normalizedTokens = search
    .replace(/^@/, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  const filteredContacts = normalizedTokens.length === 0
    ? contacts
    : contacts.filter((c) => {
        const name = c.name.toLowerCase()
        const username = c.username.toLowerCase()
        return normalizedTokens.every((t) => name.includes(t) || username.includes(t))
      })

  const contactIds = new Set(contacts.map((c) => c.id))
  const globalResults = searchResults.filter((u) => !contactIds.has(u.id))

  const queryLengthForSearch = search.replace(/^@/, '').trim().length
  const hasGlobalSearch = queryLengthForSearch >= 2
  // Global ("Найдено") section is hidden while selecting — selection mode is exclusively
  // about managing existing contacts, and external users can't be bulk-removed anyway.
  const showGlobalResults = !selectionMode && hasGlobalSearch && globalResults.length > 0

  if (!isOpen) return null

  const renderRow = (user: UserListItem, index: number, isContact: boolean) => (
    <ContactRow
      key={user.id}
      user={user}
      index={index}
      isContact={isContact}
      isLoading={startingId === user.id}
      isAdding={addingId === user.id}
      isSelected={selectedIds.has(user.id)}
      selectionMode={selectionMode}
      canSelect={isContact && Boolean(onRemoveContact)}
      onStartChat={handleStartChat}
      onAddContact={handleAddContact}
      onToggleSelect={handleToggleSelect}
    />
  )

  return (
    <div className="contacts-modal-backdrop" onClick={handleBackdropClick}>
      <div className="contacts-modal" role="dialog" aria-modal="true">
        {selectionMode ? (
          <div className="contacts-modal__header contacts-modal__header--selection">
            <button
              className="contacts-modal__icon-btn"
              onClick={() => setSelectedIds(new Set())}
              aria-label="Отменить выбор"
            >
              <CloseIcon />
            </button>
            <span className="contacts-modal__selection-count">{selectedIds.size}</span>
            <button
              className="contacts-modal__icon-btn contacts-modal__icon-btn--danger"
              onClick={() => setBulkConfirmOpen(true)}
              aria-label="Удалить выбранных"
            >
              <TrashIcon size={22} />
            </button>
          </div>
        ) : (
          <div className="contacts-modal__header">
            <h2 className="contacts-modal__title">Контакты</h2>
            <button className="contacts-modal__close" onClick={onClose} aria-label="Закрыть">
              <CloseIcon />
            </button>
          </div>
        )}

        <div className="contacts-modal__search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            placeholder="Поиск контактов и пользователей..."
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
          ) : (
            <>
              {filteredContacts.length > 0 && (
                <>
                  {showGlobalResults && (
                    <div className="contacts-modal__section-label">Контакты</div>
                  )}
                  {filteredContacts.map((contact, i) => renderRow(contact, i, true))}
                </>
              )}

              {showGlobalResults && (
                <>
                  <div className="contacts-modal__section-label">Найдено</div>
                  {globalResults.map((user, i) => renderRow(user, filteredContacts.length + i, false))}
                </>
              )}

              {searching && (
                <div className="contacts-modal__empty">
                  <span className="contacts-modal__spinner" style={{ width: 20, height: 20, borderWidth: 2, display: 'inline-block', verticalAlign: 'middle' }} />
                </div>
              )}

              {filteredContacts.length === 0 && !showGlobalResults && !searching && (
                <div className="contacts-modal__empty">
                  {queryLengthForSearch >= 2
                    ? 'Никого не найдено'
                    : search
                      ? 'Введите минимум 2 символа для поиска'
                      : 'У вас пока нет контактов'}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={bulkConfirmOpen}
        title={`Удалить ${selectedIds.size} ${pluralContacts(selectedIds.size)}?`}
        message="Контакты будут удалены из вашего списка. Это действие нельзя отменить."
        confirmLabel="Удалить"
        variant="danger"
        busy={bulkRemoving}
        onConfirm={handleBulkDelete}
        onCancel={() => { if (!bulkRemoving) setBulkConfirmOpen(false) }}
      />
    </div>
  )
}
