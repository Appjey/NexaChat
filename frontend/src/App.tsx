import './App.css'

import { useCallback, useRef, useState } from 'react'
import { Outlet } from 'react-router-dom'

import { useAccountKey } from './features/auth/AccountKey'
import { useAuthContext } from './features/auth/AuthContext'
import { LazyVaultModal } from './features/auth/LazyVaultModal'
import { ActiveCallOverlay } from './features/calls/ActiveCallOverlay'
import { useCallContext } from './features/calls/CallContext'
import { IncomingCallModal } from './features/calls/IncomingCallModal'
import { SlideMenu } from './features/menu/SlideMenu'
import { useFCMNotifications } from './shared/hooks/useFCMNotifications'

export type OutletContextType = {
  menuOpen: boolean
  setMenuOpen: (open: boolean) => void
  onChatSelectedRef: React.MutableRefObject<((chatId: number) => void) | null>
  openContactsModal?: () => void
  openSettingsModal?: () => void
  openCreateGroupModal?: () => void
}

export default function AppLayout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [contactsModalOpen, setContactsModalOpen] = useState(false)
  const [settingsModalOpen, setSettingsModalOpen] = useState(false)
  const [createGroupModalOpen, setCreateGroupModalOpen] = useState(false)
  const onChatSelectedRef = useRef<((chatId: number) => void) | null>(null)
  const { callState, acceptCall, rejectCall, hangup, toggleMute } = useCallContext()
  const { user, loading } = useAuthContext()
  const accountKeyCtx = useAccountKey()
  // Show the lazy-vault modal only when we know the user is authenticated
  // AND we definitely don't have an account_key on this device. AccountKey
  // 'loading' is the boot-time hydrate window — don't flash the modal during
  // it. Auth 'loading' means we haven't decided yet whether the user is in.
  const needsVaultBootstrap =
    !loading && user !== null && accountKeyCtx.state.status === 'missing'

  useFCMNotifications(true)

  const handleChatSelected = useCallback((chatId: number) => {
    onChatSelectedRef.current?.(chatId)
  }, [])

  const openContactsModal = useCallback(() => {
    setContactsModalOpen(true)
  }, [])

  const openSettingsModal = useCallback(() => {
    setSettingsModalOpen(true)
  }, [])

  const openCreateGroupModal = useCallback(() => {
    setCreateGroupModalOpen(true)
  }, [])

  const handleAcceptCall = useCallback(() => {
    if (callState.chatId) {
      onChatSelectedRef.current?.(callState.chatId)
    }
    acceptCall()
  }, [callState.chatId, acceptCall])

  const hasActiveCall = callState.status === 'outgoing' || callState.status === 'active' || callState.status === 'connecting'

  return (
    <>
      {hasActiveCall && (
        <ActiveCallOverlay
          otherUsername={callState.otherUsername || ''}
          otherAvatar={callState.otherAvatar}
          duration={callState.callDuration}
          isMuted={callState.isMuted}
          status={callState.status as 'outgoing' | 'active' | 'connecting'}
          onToggleMute={toggleMute}
          onHangup={hangup}
        />
      )}

      <div className={`telegram-layout${hasActiveCall ? ' has-active-call' : ''}`}>
        <SlideMenu
          isOpen={menuOpen}
          onClose={() => setMenuOpen(false)}
          onChatSelected={handleChatSelected}
          contactsModalOpen={contactsModalOpen}
          onContactsModalChange={setContactsModalOpen}
          settingsModalOpen={settingsModalOpen}
          onSettingsModalChange={setSettingsModalOpen}
          createGroupModalOpen={createGroupModalOpen}
          onCreateGroupModalChange={setCreateGroupModalOpen}
        />
        <div className="telegram-main">
          <Outlet
            context={
              {
                menuOpen,
                setMenuOpen,
                onChatSelectedRef,
                openContactsModal,
                openSettingsModal,
                openCreateGroupModal,
              } satisfies OutletContextType
            }
          />
        </div>

        {callState.status === 'incoming' && (
          <IncomingCallModal
            callerName={callState.otherUsername || 'Неизвестный'}
            callerAvatar={callState.otherAvatar}
            onAccept={handleAcceptCall}
            onReject={rejectCall}
          />
        )}

        {needsVaultBootstrap && <LazyVaultModal />}
      </div>
    </>
  )
}
