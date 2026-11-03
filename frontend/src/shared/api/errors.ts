// API errors as the client sees them. The backend answers every failure with
// `{"error": "<english message>", "code": "<machine readable>"}` (see
// backend/internal/handlers/response.go); the Russian copy the user reads is
// chosen HERE from the code, never by matching on the server's text.

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly data?: Record<string, unknown>

  constructor(status: number, message: string, code?: string, data?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.data = data
  }
}

/** Thrown by httpClient when the request hit its own timeout. */
export const TIMEOUT_CODE = 'timeout'

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Неверный логин или пароль',
  too_many_attempts: 'Слишком много попыток входа, попробуйте позже',
  wrong_current_password: 'Неверный текущий пароль',
  username_taken: 'Это имя пользователя уже занято',
  username_invalid: 'Имя пользователя: 3–20 символов, только латиница, цифры и _',
  name_invalid: 'Имя: от 2 до 50 символов, хотя бы одна буква или цифра',
  weak_password: 'Пароль должен быть не короче 8 символов',
  validation: 'Проверьте введённые данные',
  version_conflict: 'Настройки были изменены на другом устройстве',
  client_update_required: 'Обновите приложение, чтобы продолжить',
  unauthorized: 'Нужно войти заново',
  forbidden: 'Нет доступа',
  not_found: 'Не найдено',
  rate_limited: 'Слишком много запросов, попробуйте позже',
  timeout: 'Сервер не отвечает, проверьте соединение',
}

/**
 * The text to show the user for a failed request. Prefers the code's Russian
 * copy, then a status-based generic, then the caller's fallback. The server's
 * English message is never shown.
 */
export function userMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code && MESSAGES[err.code]) return MESSAGES[err.code]
    if (err.status === 401) return MESSAGES.unauthorized
    if (err.status === 403) return MESSAGES.forbidden
    if (err.status === 404) return MESSAGES.not_found
    if (err.status === 429) return MESSAGES.rate_limited
    if (err.status >= 500) return 'Ошибка сервера, попробуйте позже'
  }
  return fallback
}

export function isApiStatus(err: unknown, status: number): boolean {
  return err instanceof ApiError && err.status === status
}
