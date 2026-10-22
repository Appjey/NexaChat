import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

/**
 * Content-Security-Policy, injected as a <meta http-equiv> tag on production
 * builds only (the Vite dev server injects inline HMR/refresh scripts that a
 * strict policy would block). A meta tag is the one delivery channel shared by
 * all three shells — nginx (web), the Capacitor WebView (origin
 * https://localhost) and the Electron protocol handler (same origin) — so the
 * policy has a single source of truth here.
 *
 * What it protects: an XSS in the app must not be able to load foreign script
 * or exfiltrate localStorage (JWT, E2E account_key, decrypted message cache)
 * anywhere except the API and file origins the app talks to anyway.
 *
 * Per-build origins:
 *   VITE_API_BASE_URL  — API + WebSocket origin (empty on the web build: the
 *                        app is served from the same origin and uses relative
 *                        /api and /ws, covered by 'self').
 *   VITE_FILES_ORIGIN  — presigned attachment/avatar URLs (MinIO public
 *                        endpoint). Set in .env.android / .env.desktop and as a
 *                        Docker build arg for the web image.
 *
 * Android needs 'unsafe-inline' for script-src: Capacitor splices its native
 * bridge into index.html as an inline <script> without a nonce
 * (@capacitor/android JSInjector.getInjectedStream). connect-src, object-src
 * and base-uri still hold there, which is what keeps the stored secrets from
 * leaving the device.
 */
function originOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function buildCsp(mode: string, env: Record<string, string>): string {
  const self = "'self'"
  const api = originOf(env.VITE_API_BASE_URL)
  const ws = api ? api.replace(/^http/, 'ws') : ''
  const files = originOf(env.VITE_FILES_ORIGIN)
  if (!files) {
    console.warn('[csp] VITE_FILES_ORIGIN is not set: presigned attachment downloads will be blocked by the policy')
  }
  const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)))
  const directives: Record<string, string[]> = {
    'default-src': [self],
    'script-src': mode === 'android' ? [self, "'unsafe-inline'"] : [self],
    // React inline style={{}} attributes + Electron insertCSS; a CSS injection
    // cannot read localStorage, so 'unsafe-inline' here is an accepted cost.
    'style-src': [self, "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'font-src': [self, 'https://fonts.gstatic.com', 'data:'],
    'img-src': uniq([self, 'data:', 'blob:', api, files]),
    'media-src': uniq([self, 'blob:', files]),
    'connect-src': uniq([self, api, ws, files]),
    'worker-src': [self],
    'manifest-src': [self],
    'object-src': ["'none'"],
    'base-uri': [self],
    'form-action': [self],
  }
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ')
}

function cspPlugin(mode: string, env: Record<string, string>): Plugin {
  return {
    name: 'nothing-csp-meta',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: buildCsp(mode, env) },
          injectTo: 'head-prepend',
        },
      ]
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const useProxy = env.VITE_USE_PROXY === 'true'
  const proxyTarget = env.VITE_PROXY_TARGET || env.VITE_API_BASE_URL || 'http://localhost:8080'

  const proxy = useProxy
    ? {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
        },
        '/static': {
          target: proxyTarget,
          changeOrigin: true,
        },
        '/uploads': {
          target: proxyTarget,
          changeOrigin: true,
        },
        '/ws': {
          target: proxyTarget.replace(/^http/, 'ws'),
          changeOrigin: true,
          ws: true,
        },
      }
    : undefined

  return {
    plugins: [react(), cspPlugin(mode, env)],
    server: useProxy ? { proxy } : undefined,
  }
})
