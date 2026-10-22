// The one place that is allowed to talk to `console` (ESLint `no-console`
// everywhere else; this file is exempted in eslint.config.js). debug/info are development-only noise; warn/error always
// print, and error additionally hands the entry to the reporter installed by
// main.tsx (shared/errorReporting.ts → POST /api/client-errors), so production
// failures end up in the backend log instead of a user's DevTools nobody opens.
//
// Kept dependency-free so httpClient.ts can use it without an import cycle.


export type ErrorEntry = {
  message: string
  stack?: string
  context?: string
}

type Reporter = (entry: ErrorEntry) => void

let reporter: Reporter | null = null

export function setErrorReporter(r: Reporter | null): void {
  reporter = r
}

const isDev = import.meta.env.DEV

function toEntry(args: unknown[]): ErrorEntry {
  const err = args.find((a): a is Error => a instanceof Error)
  const strings = args
    .filter((a) => !(a instanceof Error))
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
  const context = strings.join(' ').slice(0, 500)
  if (err) return { message: err.message.slice(0, 2000), stack: err.stack?.slice(0, 8000), context }
  return { message: context || 'error', context: undefined }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

export const log = {
  debug(...args: unknown[]): void {
    if (isDev) console.debug(...args)
  },
  info(...args: unknown[]): void {
    if (isDev) console.info(...args)
  },
  warn(...args: unknown[]): void {
    console.warn(...args)
  },
  error(...args: unknown[]): void {
    console.error(...args)
    if (!reporter) return
    try {
      reporter(toEntry(args))
    } catch {
      // the reporter must never take the app down
    }
  },
}
