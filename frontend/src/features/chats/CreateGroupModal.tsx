import { useEffect, useState } from 'react'

import { getContacts } from '../../shared/api/contactsApi'
import { userMessage } from '../../shared/api/errors'
import { createGroup } from '../../shared/api/groupsApi'
import { resolveApiUrl } from '../../shared/api/httpClient'
import type { GroupCreateResponse, UserListItem } from '../../shared/api/types'
import { CheckIcon, CloseIcon, SearchIcon } from '../../shared/components/Icons'
import { useAndroidBack } from '../../shared/hooks/useAndroidBack'
import { useModalBehavior } from '../../shared/hooks/useModalBehavior'
import { log } from '../../shared/log'

type Props = {
  isOpen: boolean
  onClose: () => void
  onGroupCreated: (group: GroupCreateResponse) => void
}

export function CreateGroupModal({ isOpen, onClose, onGroupCreated }: Props) {
  const [step, setStep] = useState<'members' | 'details'>('members')
  const [contacts, setContacts] = useState<UserListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [groupName, setGroupName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
      setStep('members')
      setSearch('')
      setSelectedIds(new Set())
      setGroupName('')
      setCreating(false)
      setError(null)
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

  const handleNext = () => {
    if (selectedIds.size === 0) return
    setStep('details')
  }

  const handleCreate = async () => {
    const name = groupName.trim()
    if (!name) {
      setError('Введите название группы')
      return
    }
    setCreating(true)
    setError(null)
    try {
      const group = await createGroup(name, Array.from(selectedIds))
      onGroupCreated(group)
      onClose()
    } catch (err) {
      setError(userMessage(err, 'Не удалось создать группу'))
    } finally {
      setCreating(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="contacts-modal-backdrop" onClick={handleBackdropClick}>
      <div className="contacts-modal" role="dialog" aria-modal="true">
        <div className="contacts-modal__header">
          <h2 className="contacts-modal__title">
            {step === 'members' ? 'Выберите участников' : 'Новая группа'}
          </h2>
          <button className="contacts-modal__close" onClick={onClose} aria-label="Закрыть">
            <CloseIcon />
          </button>
        </div>

        {step === 'members' && (
          <>
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
                  {search ? 'Никого не найдено' : 'У вас пока нет контактов'}
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
              <button
                className="btn btn-primary w-100"
                onClick={handleNext}
                disabled={selectedIds.size === 0}
              >
                Далее ({selectedIds.size})
              </button>
            </div>
          </>
        )}

        {step === 'details' && (
          <>
            <div className="create-group__details">
              <input
                type="text"
                className="form-control create-group__name-input"
                placeholder="Название группы"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                maxLength={100}
                autoFocus
              />
              <p className="text-muted small mt-2">
                Участников: {selectedIds.size}
              </p>
              {error && <div className="alert alert-danger mt-2">{error}</div>}
            </div>

            <div className="create-group__footer">
              <button className="btn btn-outline-secondary me-2" onClick={() => setStep('members')}>
                Назад
              </button>
              <button
                className="btn btn-primary flex-grow-1"
                onClick={handleCreate}
                disabled={creating || !groupName.trim()}
              >
                {creating ? 'Создаём...' : 'Создать группу'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
