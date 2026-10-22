import { useCallback, useRef, useState } from 'react'

import { log } from '../../shared/log'

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

type OnIceCandidateFn = (candidate: string) => void

export function useWebRTC() {
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([])
  const hasRemoteDescRef = useRef(false)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)

  const [isMuted, setIsMuted] = useState(false)
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState | null>(null)

  const cleanup = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop())
      localStreamRef.current = null
    }
    if (pcRef.current) {
      pcRef.current.close()
      pcRef.current = null
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null
      remoteAudioRef.current = null
    }
    pendingCandidatesRef.current = []
    hasRemoteDescRef.current = false
    setConnectionState(null)
    setIsMuted(false)
  }, [])

  const createPeerConnection = useCallback((onIceCandidate: OnIceCandidateFn) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        onIceCandidate(JSON.stringify(event.candidate.toJSON()))
      }
    }

    pc.ontrack = (event) => {
      const stream = event.streams[0]
      if (stream) {
        const audio = new Audio()
        audio.srcObject = stream
        audio.volume = 1.0
        audio.play().catch(log.error)
        remoteAudioRef.current = audio
      }
    }

    pc.onconnectionstatechange = () => {
      setConnectionState(pc.connectionState)
    }

    pcRef.current = pc
    return pc
  }, [])

  const flushPendingCandidates = useCallback(async () => {
    hasRemoteDescRef.current = true
    const pc = pcRef.current
    if (!pc) return
    for (const c of pendingCandidatesRef.current) {
      await pc.addIceCandidate(new RTCIceCandidate(c))
    }
    pendingCandidatesRef.current = []
  }, [])

  // Initiate a call: get mic, create offer
  const startCall = useCallback(async (onIceCandidate: OnIceCandidateFn): Promise<string> => {
    cleanup()

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    })
    localStreamRef.current = stream

    const pc = createPeerConnection(onIceCandidate)
    stream.getTracks().forEach((track) => pc.addTrack(track, stream))

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    return JSON.stringify(offer)
  }, [cleanup, createPeerConnection])

  // Answer an incoming call: get mic, set remote SDP, create answer
  const answerCall = useCallback(async (remoteSdp: string, onIceCandidate: OnIceCandidateFn): Promise<string> => {
    cleanup()

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    })
    localStreamRef.current = stream

    const pc = createPeerConnection(onIceCandidate)
    stream.getTracks().forEach((track) => pc.addTrack(track, stream))

    const offer = JSON.parse(remoteSdp) as RTCSessionDescriptionInit
    await pc.setRemoteDescription(new RTCSessionDescription(offer))
    await flushPendingCandidates()

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    return JSON.stringify(answer)
  }, [cleanup, createPeerConnection, flushPendingCandidates])

  // Handle remote SDP answer (caller receives this)
  const handleRemoteAnswer = useCallback(async (sdp: string) => {
    const pc = pcRef.current
    if (!pc) return
    const answer = JSON.parse(sdp) as RTCSessionDescriptionInit
    await pc.setRemoteDescription(new RTCSessionDescription(answer))
    await flushPendingCandidates()
  }, [flushPendingCandidates])

  // Handle incoming ICE candidate
  const handleRemoteIceCandidate = useCallback(async (candidateJSON: string) => {
    const candidate = JSON.parse(candidateJSON) as RTCIceCandidateInit
    if (hasRemoteDescRef.current && pcRef.current) {
      await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate))
    } else {
      pendingCandidatesRef.current.push(candidate)
    }
  }, [])

  const hangup = useCallback(() => {
    cleanup()
  }, [cleanup])

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current
    if (!stream) return false

    const audioTrack = stream.getAudioTracks()[0]
    if (!audioTrack) return false

    audioTrack.enabled = !audioTrack.enabled
    const muted = !audioTrack.enabled
    setIsMuted(muted)
    return muted
  }, [])

  return {
    startCall,
    answerCall,
    handleRemoteAnswer,
    handleRemoteIceCandidate,
    hangup,
    toggleMute,
    isMuted,
    connectionState,
  }
}
