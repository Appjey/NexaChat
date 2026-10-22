import { useEffect, useMemo, useState } from 'react'

import { getContacts } from '../../shared/api/contactsApi'
import { addGroupMembers } from '../../shared/api/groupsApi'
import { resolveApiUrl } from '../../shared/api/httpClient'
import type { UserListItem } from '../../shared/api/types'
import { CheckIcon, CloseIcon, SearchIcon } from '../../shared/components/Icons'
import { useAndroidBack } from '../../shared/hooks/useAndroidBack'
import { useModalBehavior } from '../../shared/hooks/useModalBehavior'
import { log } from '../../shared/log'

type Props = {
  isOpen: boolean
  onClose: () => void
  chatId: number
  existingMemberIds: number[]
  onMembersAdded: () => void
}

export function AddMembersModal({ isOpen, onClose, chatId, existingMemberIds, onMembersAdded }: Props) {
  const [contacts, setContacts] = useState<UserListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [adding, setAdding] = useState(false)
  const { handleBackdropClick } = useModalBehavior({ isOpen, onClose })
  useAndroidBack(() => { onClose(); return true }, isOpen)

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setLoading(true)
    getContacts()
      .then((data) => { if (!cancelled) setContacts(data) })
      .catch(log.error)
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) {
      setSearch('')
      setSelectedIds(new Set())
      setAdding(false)
    }
  }, [isOpen])

  const toggleMember = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const existingSet = useMemo(() => new Set(existingMemberIds), [existingMemberIds])
  const availableContacts = contacts.filter((c) => !existingSet.has(c.id))

  const normalizedTokens = search
    .replace(/^@/, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  const filteredContacts = normalizedTokens.length === 0
    ? availableContacts
    : availableContacts.filter((c) => {
        const name = c.name.toLowerCase()
        const username = c.username.toLowerCase()
        return normalizedTokens.every((t) => name.includes(t) || username.includes(t))
      })

  const handleAdd = async () => {
    if (selectedIds.size === 0) return
    setAdding(true)
    try {
      await addGroupMembers(chatId, Array.from(selectedIds))
      onMembersAdded()
      onClose()
    } catch (err) {
      log.error('Failed to add members:', err)
    } finally {
      setAdding(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="contacts-modal-backdrop" onClick={handleBackdropClick}>
      <div className="contacts-modal" role="dialog" aria-modal="true">
        <div className="contacts-modal__header">
          <h2 className="contacts-modal__title">
            Добавить участников
            <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginLeft: 8 }}>
              {existingMemberIds.length}
            </span>
          </h2>
          <button className="contacts-modal__close" onClick={onClose} aria-label="Закрыть">
            <CloseIcon />
          </button>
        </div>

        <div className="contacts-modal__search">
          <SearchIcon />
          <input
            type="text"
            placeholder="Поиск контактов..."
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
          ) : filteredContacts.length === 0 ? (
            <div className="contacts-modal__empty">
              {search ? 'Никого не найдено' : 'Нет доступных контактов'}
            </div>
          ) : (
            filteredContacts.map((contact) => {
              const isSelected = selectedIds.has(contact.id)
              return (
                <div
                  key={contact.id}
                  className={`contacts-modal__item${isSelected ? ' contacts-modal__item--selected' : ''}`}
                  role="listitem"
                  onClick={() => toggleMember(contact.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <div className="contacts-modal__avatar-wrap">
                    <img
                      src={resolveApiUrl(contact.avatar_url) || '/img/default-avatar.svg'}
                      alt=""
                      className="contacts-modal__avatar"
                      loading="lazy"
                    />
                  </div>
                  <div className="contacts-modal__info">
                    <span className="contacts-modal__name">{contact.name}</span>
                    <span className="contacts-modal__username">@{contact.username}</span>
                  </div>
                  <div className={`create-group__checkbox${isSelected ? ' checked' : ''}`}>
                    {isSelected && <CheckIcon />}
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
            onClick={handleAdd}
            disabled={selectedIds.size === 0 || adding}
          >
            {adding ? 'Добавляем...' : `Добавить (${selectedIds.size})`}
          </button>
        </div>
      </div>
    </div>
  )
}
