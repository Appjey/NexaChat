import 'bootstrap/dist/css/bootstrap.min.css'
import './index.css'
import './App.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { AppLockProvider } from './features/applock/AppLockProvider'
import { AccountKeyProvider } from './features/auth/AccountKeyProvider'
import { AuthProvider } from './features/auth/AuthContext'
import { CallProvider } from './features/calls/CallProvider'
import { UpdateMandatoryScreen } from './features/updates/UpdateMandatoryScreen'
import { UpdateProvider } from './features/updates/UpdateProvider'
import { AppRouter } from './router/AppRouter'
import { hydrateAuthToken } from './shared/api/httpClient'
import { hydrateAppLockPrefs } from './shared/appLock'
import { ToastProvider } from './shared/components/Toast'
import { ThemeProvider } from './shared/context/ThemeContext'
import { hydrateKeyPins } from './shared/crypto/keyPins'
import { initEarlyPushHandlers } from './shared/earlyPush'
import { installErrorReporting } from './shared/errorReporting'
import { AndroidBackProvider } from './shared/hooks/useAndroidBack'
import { log } from './shared/log'

// Must run synchronously at module load, before hydrateAuthToken awaits, so we register
// the push action listener in time for Capacitor's cold-start buffered event.
initEarlyPushHandlers()
// log.error → POST /api/client-errors, plus window error / unhandledrejection.
installErrorReporting()

// App-lock prefs hydrate alongside the token: AppLockProvider decides
// "locked on cold start?" synchronously from localStorage at first render,
// so the mirror copy must land before render. allSettled — a failed hydrate
// must not block the app any more than a failed token hydrate does.
Promise.allSettled([hydrateAuthToken(), hydrateAppLockPrefs(), hydrateKeyPins()]).then(() => {
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <AndroidBackProvider>
        <ThemeProvider>
          <ToastProvider>
            <AccountKeyProvider>
              <AuthProvider>
                {/*
                  AppLockProvider needs AccountKey + Auth above it (the lock
                  screen unwraps the vault / re-logins) and must wrap the
                  router so the gate covers every authed view. Children stay
                  mounted under the overlay — WS and calls keep running.
                */}
                <AppLockProvider>
                  <CallProvider>
                    {/*
                      UpdateProvider lives ABOVE AuthProvider's gating so the
                      mandatory-update screen blocks even the login page — a
                      user on an unsupported build shouldn't be able to log
                      in (they may not be able to use the result anyway). The
                      Screen renders its children unchanged when no mandatory
                      update is in flight.
                    */}
                    <UpdateProvider>
                      <UpdateMandatoryScreen>
                        <AppRouter />
                      </UpdateMandatoryScreen>
                    </UpdateProvider>
                  </CallProvider>
                </AppLockProvider>
              </AuthProvider>
            </AccountKeyProvider>
          </ToastProvider>
        </ThemeProvider>
      </AndroidBackProvider>
    </StrictMode>,
  )
})

// Register service worker for push notifications
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    log.error('Service worker registration failed:', err)
  })
}
