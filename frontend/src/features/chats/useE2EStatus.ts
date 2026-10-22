import { useCallback, useEffect, useState } from 'react'

import type { GroupMember } from '../../shared/api/types'
import {
  acceptChangedKey,
  getGroupKeyStatus,
  getPeerPublicKey,
  type GroupKeyStatus,
  hasKeyChange,
  KEY_CHANGED_EVENT,
} from '../../shared/crypto/peerKeys'

// E2E readiness of the active chat, which gates the composer:
//   - 'loading'    : still fetching keys, composer disabled.
//   - 'ready'      : everyone has a public_key, composer fully active.
//   - 'not-ready'  : someone (named in missingMemberNames) is missing a key,
//                    composer disabled, yellow banner.
//   - 'key-changed': the server served a public_key for a peer that differs
//                    from the one pinned on this device (keyPins.ts). Could be
//                    a legit re-setup, could be a key swap — composer disabled
//                    until the user accepts the new key explicitly.
export type E2EStatus =
  | { kind: 'loading' }
  | { kind: 'ready'; groupStatus?: GroupKeyStatus }
  | { kind: 'not-ready'; missingMemberNames: string[] }
  | { kind: 'key-changed'; peers: Array<{ userId: number; name: string }> }

export function useE2EStatus({
  chatId,
  isGroup,
  otherUserId,
  otherUsername,
  groupMembers,
  onKeyAccepted,
}: {
  chatId?: number
  isGroup: boolean
  otherUserId?: number
  otherUsername?: string
  groupMembers: GroupMember[]
  onKeyAccepted?: (peerUserId: number) => void
}) {
  const [e2eStatus, setE2EStatus] = useState<E2EStatus>({ kind: 'loading' })
  // Bumped whenever peerKeys reports a (new or resolved) key change so the
  // status effect below re-evaluates.
  const [keyEpoch, setKeyEpoch] = useState(0)
  useEffect(() => {
    const bump = () => setKeyEpoch((e) => e + 1)
    window.addEventListener(KEY_CHANGED_EVENT, bump)
    return () => window.removeEventListener(KEY_CHANGED_EVENT, bump)
  }, [])

  const afterKeyAccepted = useCallback((userId: number) => {
    onKeyAccepted?.(userId)
    setKeyEpoch((e) => e + 1)
  }, [onKeyAccepted])

  const handleAcceptKey = useCallback((userId: number) => {
    if (acceptChangedKey(userId)) afterKeyAccepted(userId)
  }, [afterKeyAccepted])

  const resetE2EStatus = useCallback(() => setE2EStatus({ kind: 'loading' }), [])

  // Fetch E2E readiness for the active chat. Recomputes when participants
  // change (group member added/removed → groupMembers identity flips, which
  // is debounced upstream via groupInfo state in ChatsPage).
  //
  // `setStatusIfChanged` is critical: even with stable deps, React's strict
  // mode + react-refresh can cause the effect to refire on hot reload. If we
  // set e2eStatus to a new-object-but-equivalent value each time, the
  // ensuing re-render makes deps appear "changed" → infinite loop. Compare
  // shallow contents and skip the update when nothing material changed.
  useEffect(() => {
    if (!chatId) return
    let cancelled = false

    const setStatusIfChanged = (next: E2EStatus) => {
      setE2EStatus((prev) => {
        if (prev.kind !== next.kind) return next
        if (prev.kind === 'ready' && next.kind === 'ready') return prev
        if (prev.kind === 'not-ready' && next.kind === 'not-ready') {
          const a = prev.missingMemberNames.join('|')
          const b = next.missingMemberNames.join('|')
          return a === b ? prev : next
        }
        if (prev.kind === 'key-changed' && next.kind === 'key-changed') {
          const a = prev.peers.map((p) => p.userId).join('|')
          const b = next.peers.map((p) => p.userId).join('|')
          return a === b ? prev : next
        }
        return next
      })
    }

    const resolveMissingNames = (missingIds: number[]) =>
      missingIds.map((uid) => {
        const m = groupMembers.find((gm) => gm.user_id === uid)
        return m?.name || m?.username || `id=${uid}`
      })

    if (isGroup) {
      getGroupKeyStatus(chatId).then((status) => {
        if (cancelled) return
        if (!status) {
          setStatusIfChanged({ kind: 'loading' })
          return
        }
        if (status.changedUserIds.length > 0) {
          setStatusIfChanged({
            kind: 'key-changed',
            peers: status.changedUserIds.map((uid) => ({ userId: uid, name: resolveMissingNames([uid])[0] })),
          })
        } else if (status.missingUserIds.length === 0) {
          setStatusIfChanged({ kind: 'ready', groupStatus: status })
        } else {
          setStatusIfChanged({
            kind: 'not-ready',
            missingMemberNames: resolveMissingNames(status.missingUserIds),
          })
        }
      }).catch(() => {
        if (!cancelled) setStatusIfChanged({ kind: 'loading' })
      })
    } else if (otherUserId) {
      getPeerPublicKey(otherUserId).then((key) => {
        if (cancelled) return
        if (key) {
          setStatusIfChanged({ kind: 'ready' })
        } else if (hasKeyChange(otherUserId)) {
          setStatusIfChanged({ kind: 'key-changed', peers: [{ userId: otherUserId, name: otherUsername || 'собеседник' }] })
        } else {
          setStatusIfChanged({ kind: 'not-ready', missingMemberNames: [otherUsername || 'собеседник'] })
        }
      }).catch(() => {
        if (!cancelled) setStatusIfChanged({ kind: 'loading' })
      })
    } else {
      setStatusIfChanged({ kind: 'loading' })
    }

    return () => { cancelled = true }
  }, [chatId, isGroup, otherUserId, otherUsername, groupMembers, keyEpoch])

  return { e2eStatus, resetE2EStatus, handleAcceptKey, afterKeyAccepted }
}
