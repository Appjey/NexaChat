import { log } from '../log'
import { isNative, isWebBrowser } from '../platform'
import { ApiError, TIMEOUT_CODE } from './errors'

const USE_PROXY = import.meta.env.VITE_USE_PROXY === 'true'
const BASE_URL = USE_PROXY ? '' : import.meta.env.VITE_API_BASE_URL ?? ''
const TOKEN_KEY = 'auth_token'
const REFRESH_TOKEN_HEADER = 'X-Refresh-Token'
// Browser builds never hold the JWT: the backend sets it as an HttpOnly
// cookie on login (sent automatically with `credentials: 'include'` and on the
// WebSocket handshake). This non-secret flag only remembers "a session was
// started here" so the app knows to try /api/auth/me on boot.
const SESSION_FLAG_KEY = 'auth_session'
/**
 * Fired on `window` when the backend answers 401 to an authenticated request,
 * i.e. the session was revoked (logout elsewhere, password change, admin
 * action) or the token is otherwise dead. The token is already removed from
 * storage by the time listeners run; useAuth reacts by clearing the in-memory
 * user so ProtectedRoute bounces to /login.
 */
export const UNAUTHORIZED_EVENT = 'auth:unauthorized'
// 401 from these means "bad credentials", not "dead session" — never log the
// user out over them.
const CREDENTIAL_PATHS = new Set(['/api/auth/login', '/api/auth/register'])
// Hard ceiling for any single HTTP request. Without this, fetch() has no default timeout,
// so a silently-dead backend (e.g. on a flaky mobile network) hangs the promise forever
// and the UI gets stuck on "loading...". 15 seconds covers slow 3G uploads with margin.
const REQUEST_TIMEOUT_MS = 15_000

async function prefsGet(key: string): Promise<string | null> {
  const { Preferences } = await import('@capacitor/preferences')
  const { value } = await Preferences.get({ key })
  return value
}

async function prefsSet(key: string, value: string): Promise<void> {
  const { Preferences } = await import('@capacitor/preferences')
  await Preferences.set({ key, value })
}

async function prefsRemove(key: string): Promise<void> {
  const { Preferences } = await import('@capacitor/preferences')
  await Preferences.remove({ key })
}

export async function hydrateAuthToken(): Promise<void> {
  if (!isNative()) return
  try {
    const value = await prefsGet(TOKEN_KEY)
    if (value) {
      localStorage.setItem(TOKEN_KEY, value)
    } else {
      const existing = localStorage.getItem(TOKEN_KEY)
      if (existing) {
        await prefsSet(TOKEN_KEY, existing)
      }
    }
  } catch (err) {
    log.error('Failed to hydrate auth token from Preferences:', err)
  }
}

/** `{"error": "...", "code": "..."}` → ApiError; anything else keeps the raw body as the message. */
function parseApiError(status: number, body: string): ApiError {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const message = typeof parsed.error === 'string' && parsed.error ? parsed.error : `Request failed: ${status}`
    const code = typeof parsed.code === 'string' ? parsed.code : undefined
    return new ApiError(status, message, code, parsed)
  } catch {
    return new ApiError(status, body || `Request failed: ${status}`)
  }
}

export function resolveApiUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  if (path.startsWith('/api/')) return `${BASE_URL}${path}`
  return path
}

/** The bearer token for native shells; always null in a browser (cookie auth). */
export function getAuthToken() {
  if (isWebBrowser()) return null
  return localStorage.getItem(TOKEN_KEY)
}

/** True when this client believes it has a session (token on native, flag on web). */
export function hasAuthSession(): boolean {
  if (isWebBrowser()) {
    try {
      return localStorage.getItem(SESSION_FLAG_KEY) === '1'
    } catch {
      return false
    }
  }
  return Boolean(getAuthToken())
}

export function setAuthToken(token?: string) {
  if (isWebBrowser()) {
    // The cookie is the session; the token value is deliberately dropped.
    // Also scrub a token a pre-cookie build may have left behind.
    try {
      localStorage.removeItem(TOKEN_KEY)
      if (token) localStorage.setItem(SESSION_FLAG_KEY, '1')
      else localStorage.removeItem(SESSION_FLAG_KEY)
    } catch {
      // ignore
    }
    return
  }
  if (!token) {
    localStorage.removeItem(TOKEN_KEY)
    if (isNative()) {
      void prefsRemove(TOKEN_KEY).catch((err) => log.error('Failed to clear token from Preferences:', err))
    }
    return
  }
  localStorage.setItem(TOKEN_KEY, token)
  if (isNative()) {
    void prefsSet(TOKEN_KEY, token).catch((err) => log.error('Failed to mirror token to Preferences:', err))
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getAuthToken()

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      credentials: 'include',
      signal: controller.signal,
      ...options,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers ?? {}),
      },
    })

    // Sliding-session refresh: if the server rotated our token (sent when the active
    // token is older than a day) the response carries a fresh JWT we should adopt.
    // Backend exposes this header via CORS ExposeHeaders so fetch() can read it.
    // (Browsers get the rotated token as a new cookie instead; the header is
    // absent for them.)
    const refreshed = response.headers.get(REFRESH_TOKEN_HEADER)
    if (refreshed && refreshed !== token && !isWebBrowser()) {
      setAuthToken(refreshed)
    }

    if (!response.ok) {
      const errorBody = await response.text()
      if (response.status === 401 && hasAuthSession() && !CREDENTIAL_PATHS.has(path)) {
        setAuthToken(undefined)
        window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
      }
      throw parseApiError(response.status, errorBody)
    }

    if (response.status === 204) {
      return undefined as T
    }

    const rawBody = await response.text()
    if (!rawBody) {
      return undefined as T
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      return JSON.parse(rawBody) as T
    }

    return rawBody as unknown as T
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(0, 'Request timed out', TIMEOUT_CODE)
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}

export function httpGet<T>(path: string, init?: RequestInit) {
  return request<T>(path, {
    ...init,
    method: 'GET',
  })
}

export function httpPost<T>(path: string, body?: unknown, init?: RequestInit) {
  const payload =
    body instanceof FormData || body instanceof URLSearchParams || typeof body === 'string'
      ? (body as BodyInit)
      : JSON.stringify(body ?? {})

  const defaultHeaders: HeadersInit = {}
  if (body instanceof URLSearchParams) {
    defaultHeaders['Content-Type'] = 'application/x-www-form-urlencoded'
  } else if (!(body instanceof FormData) && typeof body !== 'string') {
    defaultHeaders['Content-Type'] = 'application/json'
  }

  return request<T>(path, {
    ...init,
    method: 'POST',
    body: payload,
    headers: {
      ...defaultHeaders,
      ...(init?.headers ?? {}),
    },
  })
}

export function httpPut<T>(path: string, body?: unknown, init?: RequestInit) {
  const payload =
    body instanceof FormData || body instanceof URLSearchParams || typeof body === 'string'
      ? (body as BodyInit)
      : JSON.stringify(body ?? {})

  const defaultHeaders: HeadersInit = {}
  if (body instanceof URLSearchParams) {
    defaultHeaders['Content-Type'] = 'application/x-www-form-urlencoded'
  } else if (!(body instanceof FormData) && typeof body !== 'string') {
    defaultHeaders['Content-Type'] = 'application/json'
  }

  return request<T>(path, {
    ...init,
    method: 'PUT',
    body: payload,
    headers: {
      ...defaultHeaders,
      ...(init?.headers ?? {}),
    },
  })
}

export function httpDelete<T>(path: string, init?: RequestInit) {
  return request<T>(path, {
    ...init,
    method: 'DELETE',
  })
}

