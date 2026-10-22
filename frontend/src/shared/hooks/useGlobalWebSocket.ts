import { useCallback,useEffect, useRef, useState } from 'react'

import { endpoints } from '../api/endpoints'
import { getAuthToken } from '../api/httpClient'
import type { WSEvent,WSMessageAction } from '../api/types'

type UseGlobalWebSocketProps = {
  onMessage: (event: WSEvent) => void
  enabled?: boolean
}

export function useGlobalWebSocket({ onMessage, enabled = true }: UseGlobalWebSocketProps) {
  const [isConnected, setIsConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<number | undefined>(undefined)
  const reconnectAttemptsRef = useRef(0)
  const onMessageRef = useRef(onMessage)

  // Exponential backoff (ms): 1s, 2s, 4s, ... capped at 30s. Avoids battery drain on
  // Samsung's aggressive app-freeze cycle where each wake-up would otherwise reconnect
  // immediately and die again a few seconds later.
  const maxReconnectAttempts = 20
  const baseReconnectDelay = 1000
  const maxReconnectDelay = 30000
  // Consider the connection "stable" only after it has lived this long. Only a stable
  // connection resets the attempt counter — otherwise a brief open/close flap on each
  // background freeze would reset forever, hiding the fact that we're in a loop.
  const stableUptimeMs = 5000

  useEffect(() => {
    onMessageRef.current = onMessage
  }, [onMessage])

  useEffect(() => {
    if (!enabled) {
      return
    }

    let isActive = true
    let connectionInProgress = false
    let stableTimeout: number | undefined

    const scheduleReconnect = () => {
      if (!isActive) return
      if (reconnectAttemptsRef.current >= maxReconnectAttempts) return
      // Don't burn reconnects while the tab/app is hidden — the visibility handler
      // below will kick off a fresh connect as soon as we're visible again.
      if (typeof document !== 'undefined' && document.hidden) return

      const delay = Math.min(baseReconnectDelay * 2 ** reconnectAttemptsRef.current, maxReconnectDelay)
      reconnectAttemptsRef.current++
      if (reconnectTimeoutRef.current) window.clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = window.setTimeout(connect, delay)
    }

    const connect = () => {
      if (!isActive || connectionInProgress) return

      if (wsRef.current?.readyState === WebSocket.OPEN ||
          wsRef.current?.readyState === WebSocket.CONNECTING) {
        return
      }

      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }

      connectionInProgress = true

      const wsBaseUrl = import.meta.env.VITE_API_BASE_URL || window.location.origin
      // Native shells cannot set headers on a WebSocket, so they pass the
      // token as a query param; browsers send the HttpOnly session cookie
      // with the handshake and getAuthToken() is null for them.
      const token = getAuthToken()
      const query = token ? `?token=${encodeURIComponent(token)}` : ''
      const wsUrl = `${wsBaseUrl.replace(/^http/, 'ws')}${endpoints.ws.global}${query}`

      const ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        connectionInProgress = false
        if (!isActive) {
          ws.close()
          return
        }
        setIsConnected(true)
        // Reset the attempt counter only after the connection stays alive long enough
        // to be considered stable. Resetting on every onopen creates an endless
        // reconnect cycle when the server accepts but drops us seconds later.
        if (stableTimeout) window.clearTimeout(stableTimeout)
        stableTimeout = window.setTimeout(() => {
          reconnectAttemptsRef.current = 0
        }, stableUptimeMs)
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WSEvent
          onMessageRef.current(data)
        } catch {
          // Ignore parse errors
        }
      }

      ws.onerror = () => {
        connectionInProgress = false
      }

      ws.onclose = () => {
        connectionInProgress = false
        setIsConnected(false)
        if (stableTimeout) {
          window.clearTimeout(stableTimeout)
          stableTimeout = undefined
        }

        if (wsRef.current === ws) {
          wsRef.current = null
        }

        scheduleReconnect()
      }

      wsRef.current = ws
    }

    const initTimeout = window.setTimeout(connect, 100)

    // When the app comes back to the foreground (Android resume, tab focus), give up
    // any pending backoff and reconnect immediately — the user expects live state.
    const handleVisibilityChange = () => {
      if (document.hidden) return
      if (wsRef.current?.readyState === WebSocket.OPEN) return
      reconnectAttemptsRef.current = 0
      if (reconnectTimeoutRef.current) window.clearTimeout(reconnectTimeoutRef.current)
      connect()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      isActive = false
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.clearTimeout(initTimeout)
      if (reconnectTimeoutRef.current) {
        window.clearTimeout(reconnectTimeoutRef.current)
      }
      if (stableTimeout) window.clearTimeout(stableTimeout)
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      setIsConnected(false)
    }
  }, [enabled])

  const send = useCallback((data: WSMessageAction) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false
    }
    ws.send(JSON.stringify(data))
    return true
  }, [])

  return { isConnected, send }
}
