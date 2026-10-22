// Ships `log.error` entries and uncaught exceptions to the backend
// (POST /api/client-errors), where they land in the server log with the
// user id and platform. Deliberately minimal: no third-party SDK, no PII
// beyond what the app already sends, throttled and de-duplicated so a render
// loop cannot flood the server.

import { endpoints } from './api/endpoints'
import { hasAuthSession, httpPost } from './api/httpClient'
import { type ErrorEntry, log, setErrorReporter } from './log'
import { getPlatform } from './platform'

const MAX_REPORTS_PER_MINUTE = 10
const seen = new Set<string>()
let windowStart = 0
let sentInWindow = 0

function allowed(key: string, now: number): boolean {
  if (seen.has(key)) return false
  if (now - windowStart > 60_000) {
    windowStart = now
    sentInWindow = 0
  }
  if (sentInWindow >= MAX_REPORTS_PER_MINUTE) return false
  sentInWindow++
  seen.add(key)
  return true
}

export function reportClientError(entry: ErrorEntry): void {
  // The endpoint is authenticated; before login there is nobody to attribute
  // the error to, and the request would only produce a 401.
  if (!hasAuthSession()) return
  const key = `${entry.message}|${(entry.stack ?? '').slice(0, 200)}`
  if (!allowed(key, Date.now())) return
  void httpPost(endpoints.clientErrors, {
    message: entry.message,
    stack: entry.stack,
    context: entry.context,
    url: typeof location !== 'undefined' ? location.href.slice(0, 500) : undefined,
    platform: getPlatform(),
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 300) : undefined,
  }).catch(() => {
    // never log here — log.error would call us again
  })
}

/** Wire log.error → backend and catch what nobody else caught. Call once at boot. */
export function installErrorReporting(): void {
  setErrorReporter(reportClientError)
  window.addEventListener('error', (event) => {
    log.error('uncaught error', event.error instanceof Error ? event.error : event.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    log.error('unhandled rejection', event.reason instanceof Error ? event.reason : String(event.reason))
  })
}
