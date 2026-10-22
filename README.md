# Messenger

Real-time messenger with a React frontend and a Go backend.

## Features

- 💬 Real-time 1-on-1 and group chats (WebSocket)
- 🔐 JWT authentication
- 🔒 End-to-end encryption (E2E): X25519 ECDH + AES-256-GCM. The server never sees plaintext — neither message bodies, nor attachment bodies, nor filenames / mime types
- 📞 1-on-1 audio calls (WebRTC, STUN)
- 📎 File attachments via S3/MinIO (client-side encrypted, opaque blobs server-side)
- 📌 Pinned messages
- 🔔 Web Push (VAPID) and FCM notifications
- 🟢 Presence tracking (online / offline)
- 📨 Offline message delivery
- ✏️ Message editing and deletion
- 💬 Message replies (threading)
- 👥 Group chats with roles (owner / admin / member), contact management
- 🔖 "Saved Messages" self-chat (auto-created on registration, pinned to top, cannot be deleted — only cleared)
- 🚀 In-app self-update for Android (CI-signed APK with SHA-256 verification + mandatory / optional release policy)
- 🌗 Light / dark theme

## Stack

**Backend:** Go 1.24 · Gin · GORM · PostgreSQL 16 · WebSocket · JWT · zap

**Frontend:** React 19 · TypeScript · Vite · Bootstrap 5 · React Router 7 · `@noble/curves`

**Mobile:** Capacitor Android (WebView) · FCM push

**Desktop:** Electron (macOS arm64) — same web bundle, served from the `https://localhost` origin

**Infrastructure:** Docker · MinIO · Nginx · Certbot · GitHub Actions · GHCR · Distroless

## Quick start

```bash
# Clone
git clone https://github.com/Fkuloff/messenger.git
cd messenger

# Configure .env
cp .env.example .env
nano .env

# Run (postgres + minio + backend + frontend)
docker-compose up --build
```

Visit `http://localhost`.

### Minimal env

```bash
POSTGRES_PASSWORD=your_password
JWT_SECRET=your_very_secure_jwt_secret_at_least_32_chars
```

Everything else has sensible defaults. Full reference in `.env.example`.

## Layout

```
messenger/
├── backend/                  # Go backend (Gin + GORM + PostgreSQL)
│   ├── cmd/server/           # Entry point
│   └── internal/             # Handlers, services, repos, models, secrets
├── frontend/                 # React 19 (TypeScript + Vite + Bootstrap)
│   ├── src/                  # Pages, features (auth/chats/calls/...), shared/crypto
│   ├── android/              # Capacitor Android wrapper (debug + release APK)
│   └── electron/             # Electron desktop shell (macOS arm64 DMG)
├── nginx-proxy/              # Production nginx config
├── ops/                      # SECRETS.md, OBJECT-STORAGE.md, E2E.md runbooks
├── .github/workflows/        # CI/CD pipeline
├── docker-compose.yml        # Dev: postgres, minio, backend, frontend
└── docker-compose.prod.yml   # Prod: + nginx-proxy, SSL (Certbot), Docker secrets
```

## Architecture

**Backend — layered:**
```
Handlers → Services → Repositories → Models
```
Handlers MUST NOT touch repositories directly; services encapsulate all business logic and data access.

**WebSocket:**
- Single global `/ws` connection, multiplexed by `chat_id`
- Worker pool (50 workers) for broadcast fan-out
- Heartbeat (ping/pong 54 s), per-user rate limit 10 msg/s
- Offline queue → delivered on reconnect

**Encryption (E2E, scheme=2 only — server-side scheme=1 has been removed):**
- On-device: `vault_key = PBKDF2(password, salt, 600k iter)` → unwraps `account_key`
- Inter-user: `chat_key = HKDF(X25519(my.private, peer.public))` → AES-256-GCM
- 1-on-1 message: single ciphertext + IV on the `messages` row
- Group message (pairwise, Variant A): one envelope per recipient in `message_envelopes`
- Attachments: body encrypted under a per-file `file_key` (AES-256-GCM), `file_key` wrapped per recipient in `attachment_envelopes`; filename + mime stored as a second AES-GCM blob under the same `file_key` in `encrypted_metadata`
- Multi-device: same password → same `account_key` → same X25519 keypair → same `chat_key` on every device
- Server stores only ciphertexts + public keys + per-recipient wrapped keys. Plaintext lives nowhere on the server

See `ops/E2E.md` for the full key-derivation diagram and threat model.

**File storage:**
- S3-compatible (MinIO) with presigned URLs (Signature-query-param self-authenticated)
- Dual endpoint: internal (Docker network) + public (browser-facing)
- Stored objects are opaque ciphertext (`application/octet-stream`); storage keys carry no filename or extension

## API

**Public:**
```
POST   /api/auth/register
POST   /api/auth/login
GET    /health
GET    /api/avatars/:user_id
GET    /api/group-avatars/:chat_id
```

**Protected** (JWT required):
```
# Auth + E2E vault
POST   /api/auth/logout           GET  /api/auth/me
PUT    /api/auth/password         PUT  /api/auth/vault

# 1-on-1 chats
GET    /api/chats                 POST /api/chats
GET    /api/chats/:id             DELETE /api/chats/:id
POST   /api/chats/:id/clear       GET  /api/chats/:id/messages

# Group chats
POST   /api/groups                GET  /api/groups/:id
PUT    /api/groups/:id            DELETE /api/groups/:id
GET    /api/groups/:id/keys       POST /api/groups/:id/leave
POST   /api/groups/:id/members    DELETE /api/groups/:id/members/:user_id
PUT    /api/groups/:id/members/:user_id/role
POST   /api/groups/:id/avatar     DELETE /api/groups/:id/avatar

# Pins
POST   /api/chats/:id/messages/:message_id/pin
DELETE /api/chats/:id/messages/:message_id/pin
GET    /api/chats/:id/pins

# Attachments (multipart, encrypted client-side)
POST   /api/chats/:id/messages/:message_id/attachments
GET    /api/attachments/:id       DELETE /api/attachments/:id

# Profile + contacts + presence + files
GET    /api/profile               PUT  /api/profile
GET    /api/profile/:user_id
GET    /api/contacts              POST /api/contacts/:user_id
DELETE /api/contacts/:user_id     GET  /api/users/search
POST   /api/user/avatar           DELETE /api/user/avatar
GET    /api/files/:filename
GET    /api/presence/:user_id
GET    /api/unread                GET  /api/unread/counts

# Push (VAPID + FCM)
GET    /api/push/vapid-key        POST /api/push/subscribe
POST   /api/push/unsubscribe      GET  /api/push/status
POST   /api/push/fcm/register     POST /api/push/fcm/unregister

WS     /ws
```

**Self-update (public):**
```
GET    /api/updates/latest?platform=android   # 200 + JSON release row, or 204 if none
```
Android client polls this on cold start; compares `version_code` against the
installed APK. If newer → banner; if installed < `min_supported_version_code`
→ unblockable mandatory upgrade screen.

**Admin** (X-Admin-Key header, constant-time compared; 503 if `ADMIN_API_KEY` unset):
```
POST   /api/admin/releases        # called only by the release CI workflow
```

## Development

```bash
# Docker (recommended)
docker-compose up --build              # All services
docker-compose --profile dev up        # + pgAdmin

# Backend
cd backend
go run cmd/server/main.go
go test -v -race ./...

# Frontend
cd frontend
npm install
npm run dev                            # Vite dev server
npm run build                          # Web production build
npm run build:android                  # Android-mode build (uses .env.android)
npm run sync:android                   # build:android + cap sync android
npm run sync:desktop                   # Desktop-mode build (.env.desktop) + copy into electron/dist
npm run open:desktop                   # Launch the Electron shell (run sync:desktop first)
npm run dist:desktop                   # Build macOS arm64 DMG (electron/release/)
npm run lint                           # ESLint
npm run knip                           # Find unused exports / dead code
npm test                               # Vitest (includes E2E crypto roundtrip suite)
```

**Android APK:** always run `npm run sync:android` before `gradlew assembleDebug` / `assembleRelease`. The plain `npm run build` script bakes in an empty `VITE_API_BASE_URL`, which silently routes API calls back at the WebView itself.

**Desktop (macOS, Apple Silicon):** `cd frontend/electron && npm install` once, then `npm run dist:desktop` from `frontend/` produces `electron/release/Messenger-<version>-mac-arm64.dmg`. The shell serves the bundled web app from the `https://localhost` origin (same one the Android WebView reports), so the backend CORS allow-list needs no changes; API/WS traffic goes to the host baked in via `.env.desktop`. Without a Developer ID certificate the app is ad-hoc signed — on another Mac use right-click → Open on first launch (no notarization).

**Backend linting (CI parity):** run `golangci-lint` v1.64.8 inside Docker — the native Windows binary peaks past 7 GB RAM and trashes the host. See `CLAUDE.md` for the exact command.

## CI/CD

Two workflows in `.github/workflows/`:

**`ci.yml`** — runs on every push / PR to `main`:

1. **Lint** — golangci-lint (backend) + ESLint (frontend)
2. **Test** — `go test -race -coverprofile` with PostgreSQL; Vitest on frontend
3. **Build** — Go binary + `npm run build`
4. **Docker** — build and push to GHCR (linux/amd64)

No deploy here — pushing to `main` does not touch production.

**`release.yml`** — runs on `git tag v*`:

1. Bump `versionCode` / `versionName` in `frontend/android/app/build.gradle`
2. Build a **signed** Android release APK (keystore stored as base64 secret)
3. Compute SHA-256 + size, rename to `messenger-<version>.apk`
4. Create a GitHub Release with the APK as a public asset
5. POST the release metadata to `/api/admin/releases` so connected clients
   pick up the update banner on their next cold start
6. Build + push `messenger-backend:<version>` and `messenger-frontend:<version>`
   Docker images to GHCR (plus `latest`)
7. `scp docker-compose.prod.yml + nginx-proxy/` to the production VM,
   then SSH-deploy: `docker compose pull && up -d && nginx -s reload`
8. A second job on an Apple Silicon runner builds the desktop client
   (`Messenger-<version>-mac-arm64.dmg`, ad-hoc signed) and attaches it to
   the same GitHub Release. Not registered in `/api/admin/releases` — the
   desktop client has no self-updater

Default policy: `min_supported_version_code = version_code` for the new release,
making every release a mandatory upgrade for older installs. Override for an
optional release: `gh workflow run release.yml -f min_supported=1`.

Required secrets / variables are documented in the header of `release.yml`
and in `CLAUDE.md`.

## Deployment (Production)

```bash
# On the server
mkdir ~/messenger && cd ~/messenger
# Copy docker-compose.prod.yml, nginx-proxy/, .env onto the host
cp .env.example .env
nano .env

# Populate /etc/messenger/secrets/ per ops/SECRETS.md

# First-time SSL bootstrap
chmod +x init-letsencrypt.sh && ./init-letsencrypt.sh

# Run
docker compose -f docker-compose.prod.yml up -d
```

Production stack: Nginx (reverse proxy + Let's Encrypt SSL) → Frontend (Nginx) → Backend (Distroless) → PostgreSQL + MinIO. Secrets ride on Docker Compose `secrets:` mounts under `/run/secrets/`, never in `.env`.

Object storage runs on Chainguard's MinIO build (`cgr.dev/chainguard/minio`, pinned by digest) since the official `minio/minio` images were pulled from Docker Hub; the backend creates its bucket on startup, so there is no init job. Details, digest bumps and the volume-ownership note are in `ops/OBJECT-STORAGE.md`.

## Limits

| Parameter | Limit |
|----------|-------|
| WebSocket message size | 64 KB (room for WebRTC SDP payloads) |
| Connections per user | 5 |
| Rate limit (WS) | 10 msg/s |
| Rate limit (HTTP) | 30 req/s/IP |
| Message text | 10 000 chars |
| Group members | 50 |
| Images | 100 MB |
| Videos | 500 MB |
| Documents | 50 MB |
| Files per message | 10 |

## License

[GNU AGPL v3.0](LICENSE). The Affero clause means anyone who runs this
code as a network service must offer their modified source to its users.
If you fork the backend and host it for others, you owe them your patches.
