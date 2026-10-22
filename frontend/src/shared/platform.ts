import { Capacitor } from '@capacitor/core'

export const isNative = () => Capacitor.isNativePlatform()

export const getPlatform = () => Capacitor.getPlatform()

/** The Electron desktop shell (frontend/electron). Electron's default UA carries "Electron/<ver>". */
export const isElectron = () =>
  typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent)

/**
 * A plain browser tab (the website), as opposed to the Capacitor WebView or
 * the Electron shell. The browser is the only runtime where the page's
 * storage is shared with every other script on the origin and readable from
 * DevTools, so it gets the stricter storage rules: HttpOnly session cookie
 * instead of a JS-visible token, account_key only for the browser session,
 * no plaintext message cache.
 */
export const isWebBrowser = () => !isNative() && !isElectron()
