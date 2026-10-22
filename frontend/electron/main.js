// Electron main process for the desktop client (macOS arm64 first target).
//
// Mirrors the Android Capacitor model: the web bundle (built with
// `vite build --mode desktop`, so API/WS base = https://nothingapp.ru) is
// bundled locally and served from the https://localhost origin — the same
// origin the Android WebView reports (androidScheme=https), which the
// backend already allows in CORS. No backend changes needed.
//
// To get that origin we intercept the https scheme in the default session:
// requests to https://localhost are answered from ./dist, everything else
// passes through to the network untouched (bypassCustomProtocolHandlers).
// WebSockets are not affected by protocol handlers, so wss://nothingapp.ru
// connects directly.

const { app, BrowserWindow, Menu, net, protocol, session, shell } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')

const APP_ORIGIN = 'https://localhost'
const DIST_DIR = path.join(__dirname, 'dist')

// Strict origin comparison — a prefix check would also match
// https://localhost.evil.com and let it hijack the app window.
function isAppUrl(url) {
  try {
    return new URL(url).origin === APP_ORIGIN
  } catch {
    return false
  }
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.txt': 'text/plain',
}

async function serveFromDist(request) {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname)
  } catch {
    return new Response('bad request', { status: 400 })
  }
  let filePath = path.normalize(path.join(DIST_DIR, pathname))

  // Path traversal guard: never serve anything outside dist/.
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + path.sep)) {
    return new Response('not found', { status: 404 })
  }

  // SPA fallback: router paths (/login, /chats, …) have no extension and no
  // file on disk — they resolve to index.html. A missing path WITH an
  // extension is a genuine 404 (e.g. a stale hashed asset) — masking it
  // with index.html would surface as a baffling JS parse error instead.
  let ext = path.extname(filePath).toLowerCase()
  try {
    const stat = await fs.stat(filePath)
    if (stat.isDirectory()) {
      filePath = path.join(DIST_DIR, 'index.html')
      ext = '.html'
    }
  } catch {
    if (ext) return new Response('not found', { status: 404 })
    filePath = path.join(DIST_DIR, 'index.html')
    ext = '.html'
  }

  const body = await fs.readFile(filePath)
  return new Response(body, {
    headers: {
      'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
      // Vite hashes asset filenames; index.html must never be cached so a
      // replaced bundle takes effect on next launch.
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=31536000',
    },
  })
}

// The bundle is the same code the website runs; these shell-side tweaks strip
// the browser feel on desktop without forking the web app: no dragging
// images/links out of the window, no text-selection cursor on chrome
// elements. Message text stays selectable.
const DESKTOP_CSS = `
  img, a { -webkit-user-drag: none; }
  button, label, img { -webkit-user-select: none; }
`

function buildAppMenu() {
  // Replaces Electron's default menu, which is full of browser roles
  // (zoom, force reload, …). Edit/Window roles stay — on macOS clipboard
  // shortcuts only work when an Edit menu exists. Reload and DevTools are
  // kept deliberately: same "every user is a tester" reasoning as
  // webContentsDebuggingEnabled in the Android build.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
      },
      { role: 'windowMenu' },
    ]),
  )
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 600,
    title: 'Nothing',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.webContents.on('did-finish-load', () => {
    void win.webContents.insertCSS(DESKTOP_CSS)
  })

  // The app renders its own context menu for messages; native one is only
  // for editable fields (cut/copy/paste + spellcheck), which the web app
  // doesn't cover and Electron doesn't provide by default.
  win.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return
    Menu.buildFromTemplate([
      ...params.dictionarySuggestions.map((suggestion) => ({
        label: suggestion,
        click: () => win.webContents.replaceMisspelling(suggestion),
      })),
      ...(params.misspelledWord ? [{ type: 'separator' }] : []),
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { type: 'separator' },
      { role: 'selectAll' },
    ]).popup()
  })

  // Links with target=_blank (and window.open) go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && !isAppUrl(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // The shell must never navigate away from the bundled app.
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    if (/^https?:/.test(url)) void shell.openExternal(url)
  })

  void win.loadURL(APP_ORIGIN + '/')
  return win
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // A second WS session for the same account confuses presence — keep one
  // instance and focus it instead.
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    buildAppMenu()

    protocol.handle('https', (request) => {
      if (new URL(request.url).origin === APP_ORIGIN) {
        return serveFromDist(request)
      }
      return net.fetch(request, { bypassCustomProtocolHandlers: true })
    })

    // getUserMedia for WebRTC calls; the app only does audio, so camera
    // capture stays denied even if a compromised page asks for it.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
      if (permission === 'media') {
        const types = details.mediaTypes ?? []
        callback(types.length > 0 && types.every((t) => t === 'audio'))
        return
      }
      callback(['notifications', 'clipboard-read'].includes(permission))
    })

    const win = createWindow()

    // CI / smoke hook: SMOKE_SCREENSHOT=/path/out.png renders the app,
    // captures the window and exits — lets a headless check verify the
    // bundle actually boots inside the shell.
    if (process.env.SMOKE_SCREENSHOT) {
      win.webContents.on('did-finish-load', () => {
        setTimeout(async () => {
          try {
            const image = await win.webContents.capturePage()
            await fs.writeFile(process.env.SMOKE_SCREENSHOT, image.toPNG())
          } catch (err) {
            console.error('smoke screenshot failed:', err)
            process.exitCode = 1
          }
          app.quit()
        }, 4000)
      })
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
