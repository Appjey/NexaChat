# End-to-end message encryption: design

This document captures the encryption layering. It is the place to start when
reasoning about why a particular message is or isn't readable on the server
or on a peer device.

> **Status note (post-migration).** scheme=1 has been removed. Today the only
> valid encryption scheme is scheme=2 (client-side E2E). Group chats use
> pairwise X25519 envelopes (Variant A). The `MESSAGE_ENCRYPTION_KEY` is no
> longer read by the backend; legacy scheme=1 rows in the DB are not
> decryptable and render as a "🔒 placeholder" until purged. The historical
> commentary below describes the dual-scheme transitional state we lived in
> between the Phase A/B/C rollouts and is kept for context.

## Goal

Stop the backend operator from being able to read users' messages. Concretely:

1. The backend has no master key. All message ciphertexts in `messages` /
   `message_envelopes` are encrypted by senders' clients under per-pair
   X25519 ECDH-derived AES-GCM keys.
2. A user logging in from a fresh device still sees their full chat history
   — same password → same `account_key` on every device.
3. The transition was done without downtime: a dual-scheme period coexisted
   with `MESSAGE_ENCRYPTION_KEY` until every active user had a published
   `public_key`, then the legacy path was removed.

## Encryption scheme (current)

Every new message is scheme=2 client-side encrypted. The `messages.scheme`
column remains for historical reasons (and to identify legacy rows during
cleanup) but the backend rejects sends with any value other than 2.

The send path goes through `ChatService.prepareMessageBody`:
- 1-on-1: client supplies `text` (ciphertext) + `iv`, both stored as opaque
  blobs on the `messages` row.
- Group: client supplies an `envelopes` array (one per current participant);
  the row's `text`/`iv` are empty and per-recipient ciphertexts live in
  `message_envelopes`. See "Group pairwise" below.

The read path (`ChatService.GetMessages` and friends) resolves the caller's
envelope for group messages and otherwise leaves ciphertext + iv intact for
the client to decrypt.

## Key derivation: vault_key + account_key

The client never asks the server "give me my key." Instead it derives the key
from the user's password every time the app starts:

```
                          ┌────────────────────────────────┐
                          │  password (only in the user's  │
                          │  head, on their device(s))     │
                          └──────────────┬─────────────────┘
                                         │
                ┌────────────────────────┼─────────────────────────┐
                │                        │                         │
                ▼                        ▼                         ▼
       auth_password =       vault_key =                       (the key the
       Argon2(password,      Argon2(password,                   user typed —
              salt_auth)            salt_vault)                  forgotten
                                                                 in O(seconds))
                │                        │
                ▼                        ▼
       sent to server          stays on the device,
       for password check      decrypts account_key
```

`account_key` is a random 32-byte secret generated once on the user's first
device. The server stores it in `users.encrypted_account_key` — encrypted with
`vault_key`, never in cleartext.

`users.vault_salt` is the PBKDF2 salt for `vault_key`. Random 16 bytes,
generated client-side once when the user opts into E2E, sent to the server,
and served back to the client on every login (so subsequent devices can
re-derive the same `vault_key` from the same password).

### Per-user X25519 keypair (Phase C — inter-user E2E)

`account_key` is **not** used directly to encrypt messages between two users.
Different users have different `account_key`s — naively encrypting with the
sender's would leave the recipient unable to decrypt. Instead, each user has
an **X25519 keypair derived deterministically from `account_key`**:

```
account_key  ──HKDF-SHA-256(info="messenger-x25519-private-v1")──►  X25519 private
                                                                           │
                                                                           ▼ X25519 base-point
                                                                       X25519 public
                                                                           │
                                                                           ▼
                                                          uploaded to users.public_key
                                                              (published openly)
```

For a scheme=2 message from Alice to Bob:

```
Alice's client:                                  Bob's client (receiving):
  shared = X25519(Alice.private, Bob.public)       shared = X25519(Bob.private, Alice.public)
       │                                                 │
       │  HKDF(info="messenger-chat-aes-v1")              │  same HKDF
       ▼                                                 ▼
   chat_key (AES-GCM-256)  ═══ identical bytes ═══   chat_key
       │                                                 │
       ▼ AES-GCM with per-message random IV               ▼
   ciphertext + iv ───────── stored on server ──────► ciphertext + iv  →  plaintext
```

ECDH's symmetry property guarantees both sides arrive at the same `chat_key`
without ever putting anything secret on the wire. Multi-device still works
because both of Alice's devices derive the same X25519 private key from the
same `account_key`.

Group chats use **pairwise E2E (Variant A)**: the sender encrypts the
plaintext once per recipient (including a self-envelope for own-device echo)
and ships the resulting envelopes via `message_envelopes`. Forward secrecy
is not provided — a removed member who saved their old envelopes can still
read messages they were addressed to. Sender Keys / MLS-style ratcheting is
deferred.

### Why this solves multi-device

Two phones with the same account: both get the same `encrypted_account_key`
and `vault_salt` from the server. Both derive the same `vault_key` from the
same password. Both unwrap to the same `account_key`, and from there the
same X25519 private. New device login is a no-op for history sync — the
moment auth completes, the new device has every key needed.

### Threat model

This is **not** strict E2E in the Signal sense — the server briefly sees the
password during login. The threat model is "honest-but-curious operator":
the operator can't `cat .env` and decrypt messages, can't `pg_dump` and
decrypt messages, can't `docker exec ... env` and decrypt messages, can't
ECDH against `public_key` because they have no `private_key`. They can in
principle log raw request bodies and grab the password as it flies past —
but `ginZapLogger` doesn't capture bodies, and they'd have to actively
backdoor the binary to get there. That's materially better than "the
operator just runs the existing decrypt path."

What the server **can** still do:
* See who messages whom and when — message metadata is in the clear.
* Replace `users.public_key` with their own (MITM the introduction) — but
  only against a peer the client has never seen. Clients pin the first key
  they see per user and refuse a different one until the user accepts it
  explicitly; safety numbers let two people detect a swap out of band. See
  "Key verification" below.
* Read system messages ("Bob joined the group") — they are intentionally
  plaintext (no IV) so they don't need a key.

### Forgotten password = lost messages

No recovery code in this iteration. If a user forgets their password, their
`encrypted_account_key` is forever unrecoverable. The ciphertexts in the DB
remain stored but indistinguishable from random data. We discussed adding a
24-word recovery mnemonic (server stores a second `recovery_encrypted_account_key`)
and decided against it for v1 — every parallel decryption path is permanent
architectural cost. The path is left open: if recovery becomes a requirement
later, add a column, add `PUT /api/auth/recovery`, done.

## Key verification (TOFU + safety numbers)

Implemented client-side only; the server is unchanged.

**Pinning.** Every `public_key` the client receives for another user — from
`GET /api/profile/:id` (1-on-1) or `GET /api/groups/:id/keys` (groups) — goes
through `shared/crypto/keyPins.ts` before it is used or cached
(`peerKeys.reconcileWithPin`):

* first sight → the key is pinned on the device (`localStorage` +
  Capacitor Preferences mirror, key `e2e_key_pins_v1`, hydrated at boot);
* same as the pin → used;
* different from the pin → **not used**. The key is parked, a
  `e2e:key-changed` window event fires, and the chat shows a red banner
  with the composer disabled. Messages that arrive encrypted under the new
  key render as the `[зашифрованное сообщение]` placeholder until the user
  presses «Принять новый ключ»; after that the pin is replaced (unverified)
  and the thread is re-fetched. The user's own key is exempt (derived
  locally, never trusted from the server).

A key legitimately changes only when the user opts out of E2E and back in
(`PUT /api/auth/vault`). A password change re-wraps the same `account_key`,
so the public key — and every pin that points at it — stays valid. Pins are
per account on the device and are wiped on logout.

**Safety number.** For users A and B (ordered by id):

```
SHA-256( "nothing-safety-v1" || id_A (8 bytes BE) || key_A (32 bytes)
                              || id_B (8 bytes BE) || key_B (32 bytes) )
```

rendered as 60 decimal digits in 12 groups of 5 (digest as an unsigned
big-endian integer, zero-padded to 78 digits, first 60). Both devices compute
it from their *pinned* view of the peer's key, so it is identical on both
phones exactly when neither side holds a substituted key. It is shown in the
peer's profile («Шифрование»), together with an «Отметить как сверенный»
toggle; the own profile shows the key fingerprint
(`SHA-256("nothing-key-fp-v1" || key)`, first 16 bytes, hex) so a user can
read it to a peer. Group member lists show «✓ проверен» / «⚠ ключ изменился»
per member; a group send is blocked while any member's key change is
unaccepted.

What this does **not** do: it cannot tell a legitimate re-setup from an
attack — only the humans can, by comparing the safety number. It also does
not protect the very first contact if the server lied from the start
(classic TOFU limitation); verifying the safety number closes that gap.

## Forward secrecy

**Status: not provided, by design decision (2026-10).**

Today `chat_key = HKDF(X25519(my_static, peer_static))` is the same key for
the lifetime of the pair. AES-GCM uses a fresh random IV per message, which
is confidentiality, not secrecy over time: whoever obtains a user's
`account_key` (phone forensics, a leaked backup, a future password
compromise) can decrypt every message that user ever sent or received, past
and future, and nothing in the protocol heals after a compromise (no
post-compromise security either).

Options considered:

* **Double Ratchet + X3DH (Signal).** Real FS and PCS. Requires per-device
  identity and prekey bundles on the server, per-device ratchet state, and —
  the expensive part for this product — gives up the "same password → same
  keys on every device, new device sees full history instantly" property.
  History and session state would have to be synced between a user's own
  devices through a new, separately secured channel, and groups need Sender
  Keys on top. Estimate: 4–6 weeks of protocol work plus the multi-device
  sync feature, and a one-way migration for existing chats.
* **MLS.** Same cost class with a bigger surface; only makes sense for large
  groups, which this product caps at 50.
* **Periodic account keypair rotation** (re-wrap under a new X25519 key).
  Limits the blast radius of a *future* key leak to messages after the
  rotation, but a leaked `account_key` still unlocks everything derived from
  it — not FS, and it breaks the deterministic multi-device derivation.
* **Per-chat hash ratchet** derived from the static `chat_key` (FS-lite):
  past messages become unreadable to someone who captures the current chain
  state, but a new device can no longer decrypt history unless the chain
  state is uploaded wrapped under `account_key` — which hands the same
  attacker the same history. Net gain close to zero here.

Decision: keep the static scheme, document it as a known limitation, and
revisit only if the product drops the zero-sync multi-device model. The
compensating controls are the ones that protect `account_key` at rest:
app-private storage, `allowBackup=false` plus `dataExtractionRules` on
Android, the biometric app lock, session revocation, and the CSP that stops
an XSS from exfiltrating the key.

## API surface

### `POST /api/auth/register` and `/login` responses

Both endpoints return the three vault fields alongside the JWT. All three may
be `null` for users who haven't onboarded into E2E yet.

```jsonc
{
  "user_id": 1,
  "username": "alice",
  "name": "Alice",
  "token": "ey...",
  "vault_salt": "base64-16-bytes-or-null",
  "encrypted_account_key": "base64-blob-or-null",
  "public_key": "base64-32-bytes-or-null"
}
```

### `GET /api/auth/me`

Same three fields appear in the existing profile-fetch response. Used on
every app launch to learn whether E2E is set up.

### `GET /api/profile/:user_id`

Profile lookups now include `public_key` so peers can ECDH against it. Null
for users without E2E.

### `PUT /api/auth/vault`

Sets or clears the vault material in one transaction. All three fields must
be present-and-non-empty or all three empty (cleared) — half-state would
leave other users ECDH-ing against a `public_key` whose private half nobody
can recover. Sanity bounds:

* `vault_salt` ≤ 64 chars (base64 of 16 bytes is 24, so generous).
* `encrypted_account_key` ≤ 4096 chars (the realistic ciphertext is ~120,
  cap accommodates future wrappers).
* `public_key` ≤ 64 chars (X25519 public is exactly 44 base64 chars).

```jsonc
PUT /api/auth/vault
{
  "vault_salt": "Xq3...=",
  "encrypted_account_key": "8Vt...=",
  "public_key": "Aq8..."
}
→ 200 {"success": true}
```

### WebSocket: `send` / `edit`

The client message frame gained two optional fields:

```jsonc
{
  "action": "send",
  "chat_id": 42,
  "text": "<plaintext-or-ciphertext>",
  "reply_to_id": 0,
  // present and == 2 for client-side encrypted messages, absent otherwise
  "scheme": 2,
  // present alongside scheme=2: client-generated GCM nonce, base64
  "iv": "Aq8..."
}
```

When the server broadcasts `new` and `edit` events it mirrors `scheme` + `iv`
back so the receiving client can decrypt.

### REST: `GET /api/chats/:id/messages`

Same shape — each `messageResponse` carries `scheme` + `iv` when (and only
when) the row is scheme=2.

## Push notifications under scheme=2

The push body is the plaintext message, truncated to 200 chars. The server
doesn't have plaintext for scheme=2, so it falls back to a generic
`"Новое сообщение"`. The notification title (sender's display name) and routing
(open chat X on tap) stay informative. We can do better later — encrypt the
payload, push it, decrypt client-side via service worker / native handler —
but that's a separate piece of work.

## Frontend lifecycle

Storage differs by runtime. Native (Capacitor) and Electron keep the raw
`account_key` in localStorage (mirrored to Capacitor Preferences on Android)
so the app opens without a password. A plain browser tab never stores the
raw key: on login it derives the X25519 pair once, imports the private half
into WebCrypto as a **non-extractable** key (`shared/crypto/identityStore.ts`)
and persists that `CryptoKey` object in IndexedDB. The page can still run
ECDH with it, so the user is not asked for the password again, but the
browser refuses to export its bytes — an XSS can decrypt while the tab is
open, it cannot take the key away. WebCrypto X25519 needs Chrome 133+,
Firefox 130+ or Safari 17+; older engines fall back to keeping the raw key in
`sessionStorage` for the window's lifetime and ask for the password on the
next visit. Because the raw `account_key` is no longer at hand in a browser,
the password-change form re-opens the vault with the old password to re-wrap
it. The browser build also keeps no plaintext message or chat-list cache and
never holds the JWT in JS (HttpOnly cookie, see README). Key pins stay in
localStorage on every runtime — they are public keys, the only requirement
is integrity.

1. **First login** — server returns `vault_salt: null`, `encrypted_account_key:
   null`, `public_key: null`. Client generates `account_key` (32 random bytes
   via WebCrypto) + `vault_salt` (16 random bytes), derives `vault_key =
   PBKDF2(password, vault_salt, 600 000)`, encrypts `account_key` under
   `vault_key` (AES-GCM), derives X25519 keypair from `account_key`, PUTs
   `/api/auth/vault` with all three fields.
2. **Every login** — read `vault_salt` + `encrypted_account_key` from
   `/api/auth/me` (or login response). Derive `vault_key`. Decrypt
   `account_key`. Cache on disk (Capacitor Preferences) so cold-restart
   works without re-typing the password. Phase B users without `public_key`
   get a transparent backfill on this path.
3. **Message send** — for 1-on-1: fetch peer's `public_key` (cached in
   memory), derive `chat_key = HKDF(X25519(my.private, peer.public),
   "messenger-chat-aes-v1")`, encrypt with `chat_key` + per-message random IV,
   send `{text: ciphertext, iv, scheme: 2}`. For groups or peers without
   `public_key`: fall back to scheme=1 plaintext send.
4. **Message receive** — if `scheme === 2`: fetch the chat's peer
   `public_key`, derive the same `chat_key` via ECDH symmetry, AES-GCM-open
   `text` with `iv` + `chat_key`. Otherwise display `text` as-is.
5. **Password change** — re-derive `vault_key` from the new password with a
   fresh `vault_salt`, re-encrypt the same `account_key` under the new
   `vault_key`, PUT `/api/auth/vault`. The X25519 keypair doesn't rotate
   (it's deterministic from `account_key`), so existing scheme=2 messages
   stay readable.

PBKDF2-HMAC-SHA256 with 600 000 iterations is what WebCrypto ships natively;
Argon2 would be more memory-hard but requires a libsodium WASM dep (~200 KB)
we'd rather not carry. X25519 + HKDF comes from `@noble/curves`
(~30 KB minified, pure JS, no WASM).

## Rollout (historical)

The rollout was phased:

1. **Phase A — backend dual-scheme:** added the `scheme` column + envelope
   table, made the read/write paths scheme-aware, kept `MESSAGE_ENCRYPTION_KEY`
   for legacy rows.
2. **Phase B — frontend scheme=2 for 1-on-1:** `bootstrapVaultOnLogin` set up
   the vault on every login/register; new 1-on-1 messages became scheme=2.
3. **Phase C — group pairwise:** `encryptForGroup` + `message_envelopes` table
   + `GET /api/groups/:id/keys`; groups with all-onboarded members went
   scheme=2.
4. **Final cutover:** removed the scheme=1 path from the backend and the
   scheme=1 fallback from the frontend; rotated `JWT_SECRET` on prod to
   force every remaining user through a re-login (and `bootstrapVaultOnLogin`)
   so their `public_key` was populated; purged legacy scheme=1 rows from
   `messages` + cascade tables; removed `MESSAGE_ENCRYPTION_KEY` from
   `/etc/messenger/secrets/`.

The codebase is now single-scheme: scheme=2 only. Anything else is a stale
or buggy client and gets a clear "обновите приложение" error from the WS
handler.
