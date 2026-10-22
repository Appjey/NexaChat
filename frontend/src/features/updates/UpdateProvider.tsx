import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import { type AppRelease, fetchLatestRelease } from '../../shared/api/updatesApi'
import { log } from '../../shared/log'
import { Updater } from '../../shared/nativeUpdater'
import { isNative } from '../../shared/platform'
import { UpdateContext, type UpdateState } from './UpdateContext'

const PREFS_LAST_CHECK = 'update_check_last_at'
const PREFS_DISMISSED_CODE = 'update_dismissed_version_code'

/**
 * Hosts the update state machine + side effects (HTTP poll, native plugin
 * calls, Preferences persistence). Mount once near the top of the React
 * tree — the banner / mandatory screen consume via useUpdate().
 *
 * On web (isNative === false) this provider runs in a degenerate "always
 * up to date" mode: the native plugin isn't registered, so we have no
 * versionCode to compare and no way to install. Banners are silently
 * suppressed.
 */
export function UpdateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UpdateState>({ status: 'loading' })
  // Hold the current native versionCode so we can re-derive state.mandatory
  // when the banner is dismissed without re-fetching the release.
  const currentVersionRef = useRef<number | null>(null)
  // Persisted dismissed-version cache. Hydrated in the initial useEffect
  // so the synchronous code path in `checkNow` can apply it without
  // awaiting Preferences for every cold-start check.
  const dismissedVersionRef = useRef<number | null>(null)

  const setStateIfDifferent = useCallback((next: UpdateState) => {
    setState((prev) => (statesEqual(prev, next) ? prev : next))
  }, [])

  const performCheck = useCallback(
    async (force: boolean): Promise<void> => {
      if (!isNative()) {
        // Web path: we never offer updates here. Render children as if up to date.
        setStateIfDifferent({ status: 'up_to_date', currentVersionCode: 0 })
        return
      }

      // Resolve our own versionCode lazily — it doesn't change at runtime
      // but caching it once across re-checks avoids round-tripping the JNI
      // bridge each time.
      if (currentVersionRef.current === null) {
        try {
          const v = await Updater.getCurrentVersion()
          currentVersionRef.current = v.version_code
        } catch (err) {
          setStateIfDifferent({
            status: 'error',
            message: 'cannot read installed version',
            currentVersionCode: null,
            mandatory: false,
          })
          log.warn('getCurrentVersion failed:', err)
          return
        }
      }
      const currentCode = currentVersionRef.current

      // Note: a previous version used a 24h debounce here to skip the
      // HTTP poll on rapid cold starts. That had a bug — when the
      // debounce hit, we set state to 'up_to_date' unconditionally,
      // which hid the banner even when an available release existed in
      // memory. Until we persist the release-row itself across cold
      // starts (and re-evaluate the version comparison from cache), the
      // simpler invariant is to always poll. ~300-byte response is
      // cheap; cold starts are infrequent enough that this isn't load.
      void force // intentionally unused while the debounce is disabled

      let latest
      try {
        latest = await fetchLatestRelease('android')
      } catch (err) {
        // Transport / 5xx — silent fail. Surface as error state so the
        // settings panel can show "Не удалось проверить", but the banner
        // simply doesn't appear.
        setStateIfDifferent({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
          currentVersionCode: currentCode,
          mandatory: false,
        })
        return
      }
      // Whether or not we found a release, remember the check time so the
      // 24h debounce kicks in. Failed checks are NOT remembered — we want
      // to retry sooner.
      const { Preferences } = await import('@capacitor/preferences')
      await Preferences.set({ key: PREFS_LAST_CHECK, value: String(Date.now()) })

      if (!latest || latest.version_code <= currentCode) {
        setStateIfDifferent({ status: 'up_to_date', currentVersionCode: currentCode })
        return
      }

      const mandatory = currentCode < latest.min_supported_version_code

      // Respect a soft-dismiss (only meaningful for non-mandatory updates).
      if (!mandatory && dismissedVersionRef.current === latest.version_code) {
        setStateIfDifferent({ status: 'up_to_date', currentVersionCode: currentCode })
        return
      }

      setStateIfDifferent({
        status: 'available',
        release: latest,
        currentVersionCode: currentCode,
        mandatory,
      })
    },
    [setStateIfDifferent],
  )

  // Initial cold-start check. Hydrate the dismissed-version cache first so
  // `performCheck` can read it synchronously.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (isNative()) {
        try {
          const { Preferences } = await import('@capacitor/preferences')
          const { value } = await Preferences.get({ key: PREFS_DISMISSED_CODE })
          if (value) {
            const code = Number(value)
            if (Number.isFinite(code)) {
              dismissedVersionRef.current = code
            }
          }
        } catch (err) {
          log.warn('hydrate dismissed-version failed:', err)
        }
      }
      if (cancelled) return
      await performCheck(false)
    })()
    return () => {
      cancelled = true
    }
  }, [performCheck])

  const checkNow = useCallback(async () => {
    setState({ status: 'loading' })
    await performCheck(true)
  }, [performCheck])

  const dismiss = useCallback(async () => {
    // Soft update offered but not started: remember the version so it doesn't nag.
    if (state.status === 'available' && !state.mandatory) {
      const code = state.release.version_code
      dismissedVersionRef.current = code
      const { Preferences } = await import('@capacitor/preferences')
      await Preferences.set({ key: PREFS_DISMISSED_CODE, value: String(code) })
      setState({ status: 'up_to_date', currentVersionCode: state.currentVersionCode })
      return
    }
    // Download/install/check failed: let the user fall back to the running
    // version for this session instead of being trapped on a dead-end screen.
    // Deliberately NOT persisted — the next cold start re-checks and re-prompts
    // (including a mandatory update) once the download works again.
    if (state.status === 'error') {
      setState({ status: 'up_to_date', currentVersionCode: state.currentVersionCode ?? 0 })
    }
  }, [state])

  // Core download routine, parameterised so both the initial "Обновить" tap
  // (from `available`) and a "Повторить" tap (from `error`, which still holds
  // the release) can drive it without re-polling.
  const runDownload = useCallback(
    async (release: AppRelease, currentVersionCode: number, mandatory: boolean): Promise<void> => {
      if (!isNative()) return
      setState({
        status: 'downloading',
        release,
        currentVersionCode,
        mandatory,
        progress: { loaded: 0, total: release.size_bytes },
      })

      const handle = await Updater.addListener('download_progress', (ev) => {
        setState((prev) =>
          prev.status === 'downloading'
            ? { ...prev, progress: { loaded: ev.bytes_loaded, total: ev.bytes_total } }
            : prev,
        )
      })

      try {
        const result = await Updater.downloadApk({
          url: release.url,
          sha256: release.sha256,
          fileName: `messenger-v${release.version_code}.apk`,
        })
        await handle.remove()
        setState({
          status: 'ready_to_install',
          release,
          path: result.path,
          currentVersionCode,
          mandatory,
        })
      } catch (err) {
        await handle.remove()
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
          currentVersionCode,
          mandatory,
          // Keep the release so "Повторить" can re-download without re-polling.
          release,
        })
      }
    },
    [],
  )

  const startDownload = useCallback(async () => {
    if (state.status !== 'available') return
    await runDownload(state.release, state.currentVersionCode, state.mandatory)
  }, [state, runDownload])

  const install = useCallback(async () => {
    if (state.status !== 'ready_to_install') return
    if (!isNative()) return
    try {
      await Updater.installApk({ path: state.path })
      // Android takes over from here. We can't observe the install outcome
      // — if it succeeds the process is killed and restarted; if it fails
      // we stay at ready_to_install and the user can retry. A previous
      // version of this code subscribed to App.appStateChange to detect
      // rejected installs, but that import path crashed the app at boot on
      // some devices (see v1.6 postmortem). Punted on retry-detection for
      // now; manual retry is good enough.
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        currentVersionCode: state.currentVersionCode,
        mandatory: state.mandatory,
        release: state.release,
      })
    }
  }, [state])

  // Retry from an error: re-download if we still hold the release (a failed
  // download/install), otherwise re-run the version check.
  const retry = useCallback(async () => {
    if (state.status === 'error' && state.release) {
      await runDownload(state.release, state.currentVersionCode ?? 0, state.mandatory)
      return
    }
    await checkNow()
  }, [state, runDownload, checkNow])

  return (
    <UpdateContext.Provider value={{ state, checkNow, dismiss, startDownload, install, retry }}>
      {children}
    </UpdateContext.Provider>
  )
}

/** Shallow comparison just deep enough to avoid identical-state re-renders. */
function statesEqual(a: UpdateState, b: UpdateState): boolean {
  if (a.status !== b.status) return false
  switch (a.status) {
    case 'loading':
      return true
    case 'up_to_date':
      return a.currentVersionCode === (b as typeof a).currentVersionCode
    case 'available':
      return (
        a.release.version_code === (b as typeof a).release.version_code &&
        a.mandatory === (b as typeof a).mandatory
      )
    case 'downloading':
      return (
        a.release.version_code === (b as typeof a).release.version_code &&
        a.progress.loaded === (b as typeof a).progress.loaded
      )
    case 'ready_to_install':
      return a.path === (b as typeof a).path
    case 'error':
      return a.message === (b as typeof a).message
  }
}
