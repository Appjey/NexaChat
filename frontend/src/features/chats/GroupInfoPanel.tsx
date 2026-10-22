import { useEffect, useRef, useState } from 'react'

import {
  changeGroupRole,
  deleteGroup,
  deleteGroupAvatar,
  leaveGroup,
  removeGroupMember,
  updateGroupInfo,
  uploadGroupAvatar,
} from '../../shared/api/groupsApi'
import { resolveApiUrl } from '../../shared/api/httpClient'
import type { GroupMember } from '../../shared/api/types'
import { BanIcon, CameraIcon, CloseIcon, GroupIcon, LogOutIcon, PersonAddIcon, ShieldIcon, TrashIcon } from '../../shared/components/Icons'
import { getPin } from '../../shared/crypto/keyPins'
import { hasKeyChange } from '../../shared/crypto/peerKeys'
import { useAndroidBack } from '../../shared/hooks/useAndroidBack'
import { useModalBehavior } from '../../shared/hooks/useModalBehavior'
import { log } from '../../shared/log'
import { AddMembersModal } from './AddMembersModal'

type Props = {
  isOpen: boolean
  onClose: () => void
  chatId: number
  groupName: string
  avatarUrl?: string | null
  members: GroupMember[]
  currentUserId: number
  onGroupUpdated: () => void
  onGroupDeleted: () => void
  onGroupLeft: () => void
}

function getRoleLabel(role: string) {
  if (role === 'creator') return 'owner'
  if (role === 'admin') return 'admin'
  return ''
}

function getRoleClass(role: string) {
  if (role === 'creator') return 'gip-member__role--owner'
  if (role === 'admin') return 'gip-member__role--admin'
  return ''
}

function pluralMembers(n: number) {
  if (n % 10 === 1 && n % 100 !== 11) return `${n} участник`
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return `${n} участника`
  return `${n} участников`
}

export function GroupInfoPanel({
  isOpen,
  onClose,
  chatId,
  groupName,
  avatarUrl,
  members,
  currentUserId,
  onGroupUpdated,
  onGroupDeleted,
  onGroupLeft,
}: Props) {
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState(groupName)
  const [showAddModal, setShowAddModal] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ memberId: number; x: number; y: number } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const { handleBackdropClick } = useModalBehavior({ isOpen, onClose })
  useAndroidBack(() => { onClose(); return true }, isOpen)

  const currentMember = members.find((m) => m.user_id === currentUserId)
  const isAdmin = currentMember?.role === 'admin' || currentMember?.role === 'creator'
  const isCreator = currentMember?.role === 'creator'

  useEffect(() => { setNameValue(groupName) }, [groupName])

  useEffect(() => {
    if (!isOpen) {
      setEditingName(false)
      setShowAddModal(false)
      setContextMenu(null)
    }
  }, [isOpen])

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [contextMenu])

  const handleSaveName = async () => {
    const name = nameValue.trim()
    if (!name || name === groupName) { setEditingName(false); return }
    try {
      await updateGroupInfo(chatId, name)
      setEditingName(false)
      onGroupUpdated()
    } catch (err) { log.error('Failed to update group name:', err) }
  }

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      await uploadGroupAvatar(chatId, file)
      onGroupUpdated()
    } catch (err) { log.error('Failed to upload avatar:', err) }
  }

  const handleDeleteAvatar = async () => {
    try {
      await deleteGroupAvatar(chatId)
      onGroupUpdated()
    } catch (err) { log.error('Failed to delete avatar:', err) }
  }

  const handleRemoveMember = async (userId: number) => {
    setContextMenu(null)
    try {
      await removeGroupMember(chatId, userId)
      onGroupUpdated()
    } catch (err) { log.error('Failed to remove member:', err) }
  }

  const handleToggleAdmin = async (userId: number, currentRole: string) => {
    setContextMenu(null)
    const newRole = currentRole === 'admin' ? 'member' : 'admin'
    try {
      await changeGroupRole(chatId, userId, newRole)
      onGroupUpdated()
    } catch (err) { log.error('Failed to change role:', err) }
  }

  const handleLeave = async () => {
    try {
      await leaveGroup(chatId)
      onGroupLeft()
    } catch (err) { log.error('Failed to leave group:', err) }
  }

  const handleDelete = async () => {
    try {
      await deleteGroup(chatId)
      onGroupDeleted()
    } catch (err) { log.error('Failed to delete group:', err) }
  }

  const handleMemberContextMenu = (e: React.MouseEvent, memberId: number) => {
    e.preventDefault()
    e.stopPropagation()
    const target = members.find((m) => m.user_id === memberId)
    if (!target) return
    // Only show menu for admins/creators on other members (not on self, not on creator)
    if (memberId === currentUserId || target.role === 'creator') return
    if (!isAdmin) return
    setContextMenu({ memberId, x: e.clientX, y: e.clientY })
  }

  const contextTarget = contextMenu ? members.find((m) => m.user_id === contextMenu.memberId) : null

  // Sort: creator first, then admins, then members
  const sortedMembers = [...members].sort((a, b) => {
    const order = { creator: 0, admin: 1, member: 2 }
    return (order[a.role] ?? 3) - (order[b.role] ?? 3)
  })

  if (!isOpen) return null

  return (
    <>
    <div className="profile-modal-backdrop" onClick={handleBackdropClick}>
      <div className="gip" role="dialog" aria-modal="true">
        {/* Close button */}
        <div className="profile-modal__header-actions">
          <button className="profile-modal__action-btn" onClick={onClose} aria-label="Закрыть">
            <CloseIcon />
          </button>
        </div>

        {/* Avatar & Name */}
        <div className="gip__hero">
          <div className="gip__avatar-wrap">
            <img
              src={resolveApiUrl(avatarUrl) || '/img/default-avatar.svg'}
              alt="Group avatar"
              className="gip__avatar"
            />
            {isAdmin && (
              <label className="gip__avatar-overlay">
                <CameraIcon />
                <input type="file" accept="image/*" hidden onChange={handleAvatarUpload} />
              </label>
            )}
          </div>

          {editingName ? (
            <div className="gip__name-edit">
              <input
                type="text"
                className="gip__name-input"
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                maxLength={100}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveName()
                  if (e.key === 'Escape') { setEditingName(false); setNameValue(groupName) }
                }}
              />
              <div className="gip__name-edit-actions">
                <button className="gip__name-save" onClick={handleSaveName}>Сохранить</button>
                <button className="gip__name-cancel" onClick={() => { setEditingName(false); setNameValue(groupName) }}>Отмена</button>
              </div>
            </div>
          ) : (
            <h2
              className={`gip__name${isAdmin ? ' gip__name--editable' : ''}`}
              onClick={isAdmin ? () => setEditingName(true) : undefined}
              title={isAdmin ? 'Нажмите, чтобы изменить' : undefined}
            >
              {groupName}
            </h2>
          )}

          {isAdmin && avatarUrl && (
            <button className="gip__delete-avatar" onClick={handleDeleteAvatar} title="Удалить фото">
              <TrashIcon size={14} />
            </button>
          )}
        </div>

        {/* Members section */}
        <div className="gip__members-section fancy-scroll">
          <div className="gip__members-header">
            <GroupIcon size={16} />
            <span>{pluralMembers(members.length).toUpperCase()}</span>
            {isAdmin && (
              <button className="gip__add-btn" onClick={() => setShowAddModal(true)} title="Добавить участника">
                <PersonAddIcon size={20} />
              </button>
            )}
          </div>

          {/* Members list */}
          {sortedMembers.map((member) => {
            const roleLabel = getRoleLabel(member.role)
            const roleClass = getRoleClass(member.role)

            return (
              <div
                key={member.user_id}
                className="gip-member"
                onContextMenu={(e) => handleMemberContextMenu(e, member.user_id)}
              >
                <div className="gip-member__avatar-wrap">
                  <img src={resolveApiUrl(member.avatar_url) || '/img/default-avatar.svg'} alt="" className="gip-member__avatar" loading="lazy" />
                  <span className={`gip-member__dot ${member.is_online ? 'online' : ''}`} />
                </div>
                <div className="gip-member__info">
                  <span className="gip-member__name">
                    {member.name}
                    {member.user_id === currentUserId && <span className="gip-member__you"> (вы)</span>}
                  </span>
                  <span className={`gip-member__status ${member.is_online ? 'gip-member__status--online' : ''}`}>
                    {member.is_online ? 'в сети' : 'не в сети'}
                    {member.user_id !== currentUserId && hasKeyChange(member.user_id) && (
                      <span className="gip-member__key gip-member__key--changed" title="Ключ шифрования изменился">⚠ ключ изменился</span>
                    )}
                    {member.user_id !== currentUserId && !hasKeyChange(member.user_id) && getPin(member.user_id)?.verified && (
                      <span className="gip-member__key gip-member__key--verified" title="Код безопасности сверен">✓ проверен</span>
                    )}
                  </span>
                </div>
                {roleLabel && (
                  <span className={`gip-member__role ${roleClass}`}>{roleLabel}</span>
                )}
              </div>
            )
          })}
        </div>

        {/* Context menu */}
        {contextMenu && contextTarget && (
          <div
            ref={contextMenuRef}
            className="gip-context"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            {isCreator && (
              <button className="gip-context__item" onClick={() => handleToggleAdmin(contextMenu.memberId, contextTarget.role)}>
                <ShieldIcon />
                <span>{contextTarget.role === 'admin' ? 'Снять админа' : 'Назначить админом'}</span>
              </button>
            )}
            {isAdmin && (
              <button className="gip-context__item gip-context__item--danger" onClick={() => handleRemoveMember(contextMenu.memberId)}>
                <BanIcon />
                <span>Удалить из группы</span>
              </button>
            )}
          </div>
        )}

        {/* Bottom actions */}
        <div className="gip__footer">
          {!isCreator && (
            <button className="gip__footer-btn gip__footer-btn--warning" onClick={handleLeave}>
              <LogOutIcon />
              Покинуть группу
            </button>
          )}
          {isCreator && (
            <button className="gip__footer-btn gip__footer-btn--danger" onClick={handleDelete}>
              <TrashIcon />
              Удалить группу
            </button>
          )}
        </div>
      </div>
    </div>

    {isAdmin && (
      <AddMembersModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        chatId={chatId}
        existingMemberIds={members.map((m) => m.user_id)}
        onMembersAdded={onGroupUpdated}
      />
    )}
    </>
  )
}
