import { useCallback, useEffect, useRef, useState } from 'react'

import type { WSEvent, WSMessageAction } from '../../shared/api/types'
import { log } from '../../shared/log'
import { type PendingCall, subscribePendingCall } from '../../shared/pendingCall'
import type { CallState } from './CallContext'
import { CallContext } from './CallContext'
import { createRingback, createRingtone } from './ringback'
import { useWebRTC } from './useWebRTC'

const initialState: CallState = {
  status: 'idle',
  callId: null,
  chatId: null,
  otherUserId: null,
  otherUsername: null,
  otherAvatar: null,
  isMuted: false,
  callDuration: 0,
}

// Caller's no-answer window: after this with no call_answer, post a missed call.
const RING_TIMEOUT_MS = 35000
// Callee's wait after tapping a doorbell: if no fresh offer arrives, bail out.
const CONNECTING_TIMEOUT_MS = 12000

export function CallProvider({ children }: { children: React.ReactNode }) {
  const [callState, setCallState] = useState<CallState>(initialState)
  const sendRef = useRef<((data: WSMessageAction) => boolean) | null>(null)
  const callStateRef = useRef(callState)
  const incomingSdpRef = useRef<string | null>(null)
  // Caller's no-answer timer; callee's wait-for-offer timer; the doorbell that
  // the callee tapped but hasn't acked yet (waiting for WS to connect).
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const connectingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingReadyRef = useRef<PendingCall | null>(null)

  const webrtc = useWebRTC()

  const clearRingTimer = useCallback(() => {
    if (ringTimerRef.current) {
      clearTimeout(ringTimerRef.current)
      ringTimerRef.current = null
    }
  }, [])

  const clearConnectingTimer = useCallback(() => {
    if (connectingTimerRef.current) {
      clearTimeout(connectingTimerRef.current)
      connectingTimerRef.current = null
    }
  }, [])

  // Keep ref in sync
  useEffect(() => {
    callStateRef.current = callState
  }, [callState])

  // Ringback tone while outgoing
  useEffect(() => {
    if (callState.status !== 'outgoing') return
    const ringback = createRingback()
    ringback.start()
    return () => ringback.stop()
  }, [callState.status])

  // Ringtone for incoming call
  useEffect(() => {
    if (callState.status !== 'incoming') return
    const ringtone = createRingtone()
    ringtone.start()
    return () => ringtone.stop()
  }, [callState.status])

  // Call duration timer
  useEffect(() => {
    if (callState.status !== 'active') return
    const interval = setInterval(() => {
      setCallState((prev) => ({ ...prev, callDuration: prev.callDuration + 1 }))
    }, 1000)
    return () => clearInterval(interval)
  }, [callState.status])

  // Send hangup when page is about to unload (refresh/close tab)
  useEffect(() => {
    const handleBeforeUnload = () => {
      const state = callStateRef.current
      if (state.status !== 'idle' && state.callId && state.chatId) {
        sendRef.current?.({ action: 'call_hangup', chat_id: state.chatId, call_id: state.callId })
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  // Auto-hangup on WebRTC connection failure
  useEffect(() => {
    if (webrtc.connectionState === 'failed' || webrtc.connectionState === 'disconnected') {
      if (callStateRef.current.status === 'active') {
        hangup()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webrtc.connectionState])

  const send = useCallback((data: WSMessageAction): boolean => {
    return sendRef.current?.(data) ?? false
  }, [])

  const resetState = useCallback(() => {
    clearRingTimer()
    clearConnectingTimer()
    setCallState(initialState)
    incomingSdpRef.current = null
  }, [clearRingTimer, clearConnectingTimer])

  // Callee side of the doorbell flow: once we have both a tapped doorbell and a
  // live WS send, enter 'connecting', emit call_ready (→ caller re-offers), and
  // arm a bail timer in case the fresh offer never arrives.
  const flushPendingReady = useCallback(() => {
    const pc = pendingReadyRef.current
    if (!pc || !sendRef.current) return
    // Already busy with another call → drop the stale doorbell so it can't fire
    // a phantom call_ready on a later reconnect. (When we're merely waiting for
    // the socket above, pc is kept so the cold-start tap still rings.)
    if (callStateRef.current.status !== 'idle') {
      pendingReadyRef.current = null
      return
    }
    pendingReadyRef.current = null
    setCallState({
      status: 'connecting',
      callId: pc.callId,
      chatId: pc.chatId,
      otherUserId: pc.callerId,
      otherUsername: null,
      otherAvatar: null,
      isMuted: false,
      callDuration: 0,
    })
    sendRef.current({ action: 'call_ready', chat_id: pc.chatId, call_id: pc.callId })
    clearConnectingTimer()
    connectingTimerRef.current = setTimeout(() => {
      const s = callStateRef.current
      if (s.status === 'connecting' && s.callId === pc.callId) {
        resetState()
      }
    }, CONNECTING_TIMEOUT_MS)
  }, [clearConnectingTimer, resetState])

  const registerSend = useCallback((fn: ((data: WSMessageAction) => boolean) | null) => {
    sendRef.current = fn
    // WS just (re)connected — if a doorbell tap is waiting, ack it now.
    if (fn) flushPendingReady()
  }, [flushPendingReady])

  // Subscribe to doorbell taps (cold/warm start). Stash it and try to flush;
  // flushPendingReady no-ops until the WS send is registered.
  useEffect(() => {
    return subscribePendingCall((pc) => {
      pendingReadyRef.current = pc
      flushPendingReady()
    })
  }, [flushPendingReady])

  const hangup = useCallback(() => {
    const state = callStateRef.current
    if (state.status !== 'idle' && state.callId && state.chatId) {
      send({ action: 'call_hangup', chat_id: state.chatId, call_id: state.callId })
    }
    webrtc.hangup()
    resetState()
  }, [send, webrtc, resetState])

  const sendIceCandidate = useCallback((chatId: number, callId: string) => {
    return (candidate: string) => {
      send({ action: 'call_ice', chat_id: chatId, call_id: callId, candidate })
    }
  }, [send])

  const initiateCall = useCallback(async (
    chatId: number,
    otherUserId: number,
    otherUsername: string,
    otherAvatar?: string | null,
  ) => {
    if (callStateRef.current.status !== 'idle') return

    const callId = crypto.randomUUID()

    setCallState({
      status: 'outgoing',
      callId,
      chatId,
      otherUserId,
      otherUsername,
      otherAvatar: otherAvatar ?? null,
      isMuted: false,
      callDuration: 0,
    })

    // No-answer timer. Covers both the online-but-ignored case and the offline
    // doorbell case (caller keeps ringing while the callee is woken by push).
    clearRingTimer()
    ringTimerRef.current = setTimeout(() => {
      const s = callStateRef.current
      if ((s.status === 'outgoing' || s.status === 'connecting') && s.callId === callId) {
        // Post a missed-call system message + tell the callee to stop ringing.
        send({ action: 'call_missed', chat_id: chatId, call_id: callId })
        send({ action: 'call_hangup', chat_id: chatId, call_id: callId })
        webrtc.hangup()
        resetState()
      }
    }, RING_TIMEOUT_MS)

    try {
      const sdp = await webrtc.startCall(sendIceCandidate(chatId, callId))
      send({ action: 'call_offer', chat_id: chatId, call_id: callId, sdp, sdp_type: 'offer' })
    } catch {
      webrtc.hangup()
      resetState()
    }
  }, [webrtc, send, sendIceCandidate, resetState, clearRingTimer])

  const acceptCall = useCallback(async () => {
    const state = callStateRef.current
    if (state.status !== 'incoming' || !incomingSdpRef.current || !state.chatId || !state.callId) return

    try {
      const answerSdp = await webrtc.answerCall(
        incomingSdpRef.current,
        sendIceCandidate(state.chatId, state.callId),
      )
      send({ action: 'call_answer', chat_id: state.chatId, call_id: state.callId, sdp: answerSdp, sdp_type: 'answer' })
      incomingSdpRef.current = null
      setCallState((prev) => ({ ...prev, status: 'active' }))
    } catch {
      webrtc.hangup()
      resetState()
    }
  }, [webrtc, send, sendIceCandidate, resetState])

  const rejectCall = useCallback(() => {
    const state = callStateRef.current
    if (state.status !== 'incoming' || !state.chatId || !state.callId) return
    send({ action: 'call_reject', chat_id: state.chatId, call_id: state.callId })
    webrtc.hangup()
    resetState()
  }, [send, webrtc, resetState])

  const toggleMute = useCallback(() => {
    webrtc.toggleMute()
    setCallState((prev) => ({ ...prev, isMuted: !prev.isMuted }))
  }, [webrtc])

  const handleCallEvent = useCallback((event: WSEvent, callerInfo?: { username: string; avatar?: string | null }) => {
    if ('error' in event) return
    const state = callStateRef.current

    switch (event.action) {
      case 'call_offer': {
        // Auto-accept path: we tapped a doorbell, we're 'connecting' for this
        // call_id, and the caller just sent the fresh offer. Answer it directly.
        if (state.status === 'connecting' && state.callId === event.call_id && state.chatId) {
          clearConnectingTimer()
          incomingSdpRef.current = event.sdp
          const chatId = state.chatId
          webrtc.answerCall(event.sdp, sendIceCandidate(chatId, event.call_id)).then((answerSdp) => {
            send({ action: 'call_answer', chat_id: chatId, call_id: event.call_id, sdp: answerSdp, sdp_type: 'answer' })
            incomingSdpRef.current = null
            setCallState((prev) => ({
              ...prev,
              status: 'active',
              otherUsername: callerInfo?.username ?? prev.otherUsername,
              otherAvatar: callerInfo?.avatar ?? prev.otherAvatar,
            }))
          }).catch(() => { hangup() })
          return
        }
        if (state.status !== 'idle') {
          send({ action: 'call_reject', chat_id: event.chat_id, call_id: event.call_id })
          return
        }
        incomingSdpRef.current = event.sdp
        setCallState({
          status: 'incoming',
          callId: event.call_id,
          chatId: event.chat_id,
          otherUserId: event.user_id,
          otherUsername: callerInfo?.username ?? null,
          otherAvatar: callerInfo?.avatar ?? null,
          isMuted: false,
          callDuration: 0,
        })
        break
      }

      case 'call_answer': {
        if (state.status !== 'outgoing' || state.callId !== event.call_id) return
        clearRingTimer()
        webrtc.handleRemoteAnswer(event.sdp).then(() => {
          setCallState((prev) => ({ ...prev, status: 'active' }))
        }).catch(() => {
          hangup()
        })
        break
      }

      case 'call_ready': {
        // Callee came online via the doorbell and is ready. Mint a FRESH offer
        // (never reuse the stale one) and resend — now relayed normally.
        if (state.status !== 'outgoing' || state.callId !== event.call_id || !state.chatId) return
        const chatId = state.chatId
        webrtc.startCall(sendIceCandidate(chatId, event.call_id)).then((sdp) => {
          send({ action: 'call_offer', chat_id: chatId, call_id: event.call_id, sdp, sdp_type: 'offer' })
        }).catch(() => { hangup() })
        break
      }

      case 'call_ice': {
        if (!state.callId || state.callId !== event.call_id) return
        webrtc.handleRemoteIceCandidate(event.candidate).catch(log.error)
        break
      }

      case 'call_hangup':
      case 'call_reject': {
        if (state.callId !== event.call_id) return
        webrtc.hangup()
        resetState()
        break
      }
    }
  }, [webrtc, send, hangup, resetState, sendIceCandidate, clearRingTimer, clearConnectingTimer])

  return (
    <CallContext.Provider value={{
      callState,
      initiateCall,
      acceptCall,
      rejectCall,
      hangup,
      toggleMute,
      handleCallEvent,
      registerSend,
    }}>
      {children}
    </CallContext.Provider>
  )
}
