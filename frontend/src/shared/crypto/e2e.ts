import { x25519 } from '@noble/curves/ed25519.js'

import { log } from '../log'
import { isWebBrowser } from '../platform'
import {
  deleteIdentity,
  getIdentity,
  importX25519Private,
  importX25519Public,
  putIdentity,
  supportsWebCryptoX25519,
  x25519DeriveShared,
} from './identityStore'

// End-to-end message encryption — see backend/ops/E2E.md for the full design.
//
// Layered keys:
//   password            (only in the user's head + briefly in app state during login)
//      └─→ PBKDF2  → vault_key                     (derived per login, never persisted)
//             └─→ AES-GCM wraps account_key        (account_key is random 32 bytes)
//                    └─→ stored as `encrypted_account_key` on the server (opaque blob)
//
//   account_key         (cached on device, used to AES-GCM each scheme=2 message)
//
// Multi-device sync works because every device with the same password derives the same
// vault_key, then unwraps the same account_key — the server stores the wrapped blob,
// not the key.
//
// KDF choice: PBKDF2-HMAC-SHA256 with 600 000 iterations. Built into WebCrypto in every
// modern browser and Android WebView, no external dependency. Argon2id would be more
// memory-hard but requires libsodium.js (~150 KB WASM). For a personal-messenger
// threat model PBKDF2 is adequate; if a stronger KDF is needed later, add a version
// field to `vault_salt` and roll forward.

const PBKDF2_ITERATIONS = 600_000
const PBKDF2_HASH = 'SHA-256'
const ACCOUNT_KEY_BYTES = 32 // AES-256
const SALT_BYTES = 16
const IV_BYTES = 12 // AES-GCM nonce

export type VaultMaterial = {
  vaultSalt: string // base64 of the 16-byte PBKDF2 salt
  encryptedAccountKey: string // base64 of (iv || ciphertext || GCM tag) wrapping the 32-byte account key
}

/** True when WebCrypto AES-GCM + PBKDF2 are usable in this runtime. */
export function isE2EAvailable(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined'
}

// ---------- low-level helpers ----------

// TypeScript 5.7 tightened the typing on Uint8Array — the underlying buffer is
// `ArrayBufferLike` (could be a SharedArrayBuffer), and WebCrypto refuses to accept
// anything but a real `ArrayBuffer`-backed view. Cast through `BufferSource` at each
// WebCrypto boundary. Safe in practice — every Uint8Array we touch is allocated by
// us, so the backing buffer is always a regular ArrayBuffer.
const asBuffer = (b: Uint8Array): BufferSource => b as unknown as BufferSource

function randomUint8Array(n: number): Uint8Array {
  const bytes = new Uint8Array(n)
  crypto.getRandomValues(bytes)
  return bytes
}

function b64encode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function b64decode(s: string): Uint8Array {
  const binary = atob(s)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function deriveVaultKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: asBuffer(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function aesGcmEncrypt(plaintext: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const iv = randomUint8Array(IV_BYTES)
  const ctBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBuffer(iv) },
    key,
    asBuffer(plaintext),
  )
  const ct = new Uint8Array(ctBuffer)
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv, 0)
  out.set(ct, iv.length)
  return out
}

async function aesGcmDecrypt(combined: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const iv = combined.slice(0, IV_BYTES)
  const ct = combined.slice(IV_BYTES)
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asBuffer(iv) },
    key,
    asBuffer(ct),
  )
  return new Uint8Array(pt)
}

async function importAccountKey(raw: Uint8Array): Promise<CryptoKey> {
  // extractable=true so we can re-wrap on password change (export -> wrap with new vault_key).
  // The key is in JS memory anyway; non-extractable would not actually protect it against
  // an attacker with code-execution.
  return crypto.subtle.importKey('raw', asBuffer(raw), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt'])
}

// ---------- high-level operations ----------

/**
 * First-time onboarding: generate a fresh account_key + vault salt, wrap account_key
 * under a freshly-derived vault_key, return both pieces — caller uploads the vault
 * material to the server and caches the imported account_key locally.
 */
export async function setupNewVault(password: string): Promise<{
  accountKey: CryptoKey
  vault: VaultMaterial
}> {
  const rawAccountKey = randomUint8Array(ACCOUNT_KEY_BYTES)
  const salt = randomUint8Array(SALT_BYTES)
  const vaultKey = await deriveVaultKey(password, salt)
  const wrapped = await aesGcmEncrypt(rawAccountKey, vaultKey)
  const accountKey = await importAccountKey(rawAccountKey)
  return {
    accountKey,
    vault: {
      vaultSalt: b64encode(salt),
      encryptedAccountKey: b64encode(wrapped),
    },
  }
}

/**
 * Unwrap an existing account_key using the password and the server-stored salt + blob.
 * Throws if the password is wrong (AES-GCM auth tag mismatches) — the caller treats
 * that as "user typed the wrong password" rather than as a corruption.
 */
export async function openVault(password: string, vault: VaultMaterial): Promise<CryptoKey> {
  const salt = b64decode(vault.vaultSalt)
  const wrapped = b64decode(vault.encryptedAccountKey)
  const vaultKey = await deriveVaultKey(password, salt)
  const rawAccountKey = await aesGcmDecrypt(wrapped, vaultKey)
  return importAccountKey(rawAccountKey)
}

/**
 * Re-wrap the same account_key under a new password (used on password change).
 * The account_key itself doesn't rotate — that would orphan every stored message — only
 * the wrapper changes, with a fresh salt and a new derivation from the new password.
 */
export async function rewrapAccountKey(
  accountKey: CryptoKey,
  newPassword: string,
): Promise<VaultMaterial> {
  const rawBuffer = await crypto.subtle.exportKey('raw', accountKey)
  const raw = new Uint8Array(rawBuffer)
  const salt = randomUint8Array(SALT_BYTES)
  const vaultKey = await deriveVaultKey(newPassword, salt)
  const wrapped = await aesGcmEncrypt(raw, vaultKey)
  return {
    vaultSalt: b64encode(salt),
    encryptedAccountKey: b64encode(wrapped),
  }
}

/**
 * Encrypt a message body with account_key. Returns base64 ciphertext + base64 IV,
 * matching what the backend stores under scheme=2 (the GORM `Text` and `IV` columns).
 */
export async function encryptMessage(
  plaintext: string,
  accountKey: CryptoKey,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = randomUint8Array(IV_BYTES)
  const ctBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBuffer(iv) },
    accountKey,
    asBuffer(new TextEncoder().encode(plaintext)),
  )
  return {
    ciphertext: b64encode(new Uint8Array(ctBuffer)),
    iv: b64encode(iv),
  }
}

/**
 * Decrypt a base64-encoded ciphertext + iv with account_key. Throws on auth tag
 * mismatch (wrong key, corrupted blob, IV mismatch). Callers should catch and
 * fall back to a placeholder string rather than letting the throw bubble into
 * the render path.
 */
export async function decryptMessage(
  ciphertext: string,
  iv: string,
  accountKey: CryptoKey,
): Promise<string> {
  const ctUint8Array = b64decode(ciphertext)
  const ivUint8Array = b64decode(iv)
  const ptBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asBuffer(ivUint8Array) },
    accountKey,
    asBuffer(ctUint8Array),
  )
  return new TextDecoder().decode(ptBuffer)
}

// ---------- X25519 keypair (Phase C — inter-user E2E) ----------
//
// Each user has an X25519 keypair derived deterministically from their account_key.
// Multi-device sync still works: both devices have the same account_key, so both
// derive the same private key + the same public key.
//
// To send a scheme=2 message from Alice to Bob:
//   shared = X25519(Alice.private, Bob.public)
//   message_key = HKDF(shared, info="msg-key")     // see deriveChatKey below
//   ciphertext = AES-GCM(plaintext, message_key)
//
// Bob receives ciphertext + IV + Alice's user_id. He fetches Alice's public_key
// from the server, computes the same shared via X25519(Bob.private, Alice.public),
// derives the same message_key, decrypts. ECDH symmetry guarantees both sides
// arrive at the same shared bytes.
//
// Private key is never persisted separately — it's re-derived from account_key on
// demand via HKDF-SHA-256 with a fixed info label so the same account_key always
// produces the same X25519 scalar.

const X25519_SCALAR_LABEL = 'messenger-x25519-private-v1'
const CHAT_KEY_HKDF_LABEL = 'messenger-chat-aes-v1'

/**
 * Derive the X25519 private scalar from a raw account_key. Uses HKDF-SHA-256 with
 * a fixed info label so the output is deterministic — every device with the same
 * account_key derives the same scalar.
 */
async function deriveX25519Private(rawAccountKey: Uint8Array): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    asBuffer(rawAccountKey),
    { name: 'HKDF' },
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(X25519_SCALAR_LABEL),
    },
    baseKey,
    256,
  )
  return new Uint8Array(bits)
}

/**
 * X25519 keypair derived from a CryptoKey (the imported account_key). Both halves
 * are returned as raw 32-byte arrays. The library's X25519 expects raw byte slices
 * for both scalar and public point.
 */
async function deriveX25519Keypair(
  accountKey: CryptoKey,
): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', accountKey))
  const privateKey = await deriveX25519Private(raw)
  const publicKey = x25519.getPublicKey(privateKey)
  return { privateKey, publicKey }
}

// ---------- identity key polymorphism ----------
//
// The key the app carries around ("accountKey" everywhere below) is one of:
//   - the AES-GCM account_key itself (native shells, Electron, and browsers
//     without WebCrypto X25519): the X25519 pair is re-derived from it on demand;
//   - a NON-extractable WebCrypto X25519 private key (browsers): produced once
//     from the account_key by toWebCryptoIdentity and persisted in IndexedDB.
//     Its public half cannot be exported from the key object, so it is kept in
//     a side table.
// Everything that needs the public key or an ECDH goes through the two helpers
// below, so the rest of the module does not care which one it holds.

const x25519PublicByKey = new WeakMap<CryptoKey, Uint8Array>()

function isX25519Key(key: CryptoKey): boolean {
  return key.algorithm.name === 'X25519'
}

async function identityPublicKey(key: CryptoKey): Promise<Uint8Array> {
  if (isX25519Key(key)) {
    const pub = x25519PublicByKey.get(key)
    if (!pub) throw new Error('X25519 identity without a registered public key')
    return pub
  }
  return (await deriveX25519Keypair(key)).publicKey
}

async function ecdh(key: CryptoKey, peerPublic: Uint8Array): Promise<Uint8Array> {
  if (isX25519Key(key)) {
    return x25519DeriveShared(key, await importX25519Public(peerPublic))
  }
  const { privateKey } = await deriveX25519Keypair(key)
  return x25519.getSharedSecret(privateKey, peerPublic)
}

/**
 * Turn the account_key into a non-extractable WebCrypto X25519 identity (same
 * keypair the raw path derives, so a user's public key is identical whether
 * they are on the web or in the app). The raw scalar exists in JS memory only
 * for the duration of this call.
 */
export async function toWebCryptoIdentity(accountKey: CryptoKey): Promise<CryptoKey> {
  const { privateKey, publicKey } = await deriveX25519Keypair(accountKey)
  const webKey = await importX25519Private(privateKey, publicKey)
  x25519PublicByKey.set(webKey, publicKey)
  privateKey.fill(0)
  return webKey
}

/** Base64 of the user's X25519 public key — what gets uploaded to /api/auth/vault. */
export async function publicKeyBase64(accountKey: CryptoKey): Promise<string> {
  return b64encode(await identityPublicKey(accountKey))
}

/**
 * Compute the AES-GCM-256 key shared between two parties via X25519 ECDH +
 * HKDF-SHA-256. Both sender (using their private + peer's public) and recipient
 * (using their private + sender's public) derive byte-identical chat keys —
 * that's the symmetry property of ECDH.
 */
export async function deriveChatKey(
  myAccountKey: CryptoKey,
  peerPublicKeyBase64: string,
): Promise<CryptoKey> {
  const shared = await ecdh(myAccountKey, b64decode(peerPublicKeyBase64))
  // Run HKDF over the raw ECDH output so a discrete-log break against the curve
  // isn't enough to recover the AES key without also breaking SHA-256.
  const baseKey = await crypto.subtle.importKey(
    'raw',
    asBuffer(shared),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(CHAT_KEY_HKDF_LABEL),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// ---------- group pairwise E2E (Variant A) ----------
//
// For 1-on-1 chats `deriveChatKey(self, peer.public)` gives both sides the same
// AES-GCM key. For groups we generalise: the sender derives a separate chat key
// per recipient (including a self-loopback for own-device echo), encrypts the
// plaintext once per recipient, and packs the resulting (recipient_id, ct, iv)
// envelopes into the WebSocket payload. Each receiving client decrypts only
// the envelope addressed to them, using the same X25519(self, sender.public)
// → HKDF → AES-GCM key.
//
// Edge cases worth flagging here so MessageComposer can decide what to do:
//   - A participant whose public_key is empty hasn't completed E2E onboarding.
//     The caller must refuse the send (the UI keeps the composer disabled until
//     every member has a key), otherwise that user simply can't read the message.
//   - The sender's own envelope uses ECDH(self.private, self.public) — well-
//     defined for X25519, deterministic, and only reproducible by the sender.

export type GroupRecipientKey = {
  userID: number
  /** Base64 of the recipient's X25519 public key, or empty if they haven't onboarded. */
  publicKey: string
}

export type GroupEnvelope = {
  recipient_id: number
  ciphertext: string
  iv: string
}

/**
 * Encrypt `plaintext` once per recipient, returning the envelope list to send
 * to the backend. Throws if any recipient is missing a public_key — the
 * caller's UI gates the send on `getGroupKeyStatus` first, so reaching this
 * function with an empty key is a programmer error. Sender must be included
 * in `recipients` so they can read their own outgoing message on another
 * device.
 */
export async function encryptForGroup(
  plaintext: string,
  recipients: GroupRecipientKey[],
  senderAccountKey: CryptoKey,
): Promise<GroupEnvelope[]> {
  if (recipients.length === 0) {
    throw new Error('encryptForGroup: no recipients')
  }
  const envelopes: GroupEnvelope[] = []
  for (const r of recipients) {
    if (!r.publicKey) {
      throw new Error(`encryptForGroup: recipient ${r.userID} has no public_key`)
    }
    const chatKey = await deriveChatKey(senderAccountKey, r.publicKey)
    const { ciphertext, iv } = await encryptMessage(plaintext, chatKey)
    envelopes.push({ recipient_id: r.userID, ciphertext, iv })
  }
  return envelopes
}

// ---------- attachment E2E (file body + per-recipient wrapped file_key) ----------
//
// Each attachment gets a fresh random `file_key` (AES-256). The file body is
// encrypted once with that key + a random IV. The key is then wrapped once per
// recipient with their pairwise chat_key (the same X25519-ECDH derived key
// used for messages). Server stores opaque ciphertext + opaque wrapped keys
// and can read neither.

/** Generate a fresh random 32-byte AES key for one attachment. */
export async function generateFileKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

/**
 * Encrypt one file (as Blob / File) and return ciphertext bytes + base64 IV.
 * The entire file is loaded into RAM via arrayBuffer() — fine up to ~100MB on
 * modern browsers, risky beyond that. Chunked encryption is a future task.
 */
export async function encryptFile(
  file: Blob,
  fileKey: CryptoKey,
): Promise<{ ciphertext: Uint8Array; iv: string }> {
  const iv = randomUint8Array(IV_BYTES)
  const plaintext = new Uint8Array(await file.arrayBuffer())
  const ctBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBuffer(iv) },
    fileKey,
    asBuffer(plaintext),
  )
  return { ciphertext: new Uint8Array(ctBuffer), iv: b64encode(iv) }
}

/**
 * Decrypt one file body. Returns a Blob (so callers can blob:-URL it for img/video
 * rendering or hand to a download anchor). The mime_type is whatever the sender
 * recorded on the Attachment row — the server can't verify it (ciphertext).
 */
export async function decryptFile(
  ciphertext: Uint8Array,
  ivB64: string,
  fileKey: CryptoKey,
  mimeType: string,
): Promise<Blob> {
  const iv = b64decode(ivB64)
  const ptBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asBuffer(iv) },
    fileKey,
    asBuffer(ciphertext),
  )
  return new Blob([ptBuffer], { type: mimeType || 'application/octet-stream' })
}

/**
 * Encrypt the small per-file metadata blob ({fileName, mimeType}) under the
 * same file_key that encrypts the body. Server never sees the plaintext —
 * filename + claimed mime stay private from the operator (they used to live
 * in the FileName / MimeType DB columns in cleartext). Different IV from the
 * body so the same key can be reused safely.
 */
export type AttachmentMetadata = {
  fileName: string
  mimeType: string
}

export async function encryptMetadata(
  meta: AttachmentMetadata,
  fileKey: CryptoKey,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = randomUint8Array(IV_BYTES)
  const plaintext = new TextEncoder().encode(JSON.stringify(meta))
  const ctBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBuffer(iv) },
    fileKey,
    asBuffer(plaintext),
  )
  return { ciphertext: b64encode(new Uint8Array(ctBuffer)), iv: b64encode(iv) }
}

/**
 * Decrypt the metadata blob produced by encryptMetadata. Returns the same
 * shape the sender put in. Throws on auth-tag mismatch (wrong file_key) so
 * the caller can surface a "🔒 Не удалось расшифровать" placeholder.
 */
export async function decryptMetadata(
  ciphertextB64: string,
  ivB64: string,
  fileKey: CryptoKey,
): Promise<AttachmentMetadata> {
  const ciphertext = b64decode(ciphertextB64)
  const iv = b64decode(ivB64)
  const ptBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asBuffer(iv) },
    fileKey,
    asBuffer(ciphertext),
  )
  const json = new TextDecoder().decode(ptBuffer)
  const parsed = JSON.parse(json) as Partial<AttachmentMetadata>
  return {
    fileName: typeof parsed.fileName === 'string' ? parsed.fileName : '',
    mimeType: typeof parsed.mimeType === 'string' ? parsed.mimeType : '',
  }
}

/**
 * Wrap a file_key under a recipient's chat_key (per-recipient envelope). Same
 * AES-GCM construction as messages — fresh IV, the body here is the 32 raw
 * bytes of file_key.
 */
export async function wrapFileKey(
  fileKey: CryptoKey,
  chatKey: CryptoKey,
): Promise<{ encryptedFileKey: string; iv: string }> {
  const rawBuffer = await crypto.subtle.exportKey('raw', fileKey)
  const raw = new Uint8Array(rawBuffer)
  const iv = randomUint8Array(IV_BYTES)
  const ctBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBuffer(iv) },
    chatKey,
    asBuffer(raw),
  )
  return { encryptedFileKey: b64encode(new Uint8Array(ctBuffer)), iv: b64encode(iv) }
}

/**
 * Unwrap a recipient's wrapped file_key. Used by the read path: client fetches
 * attachment metadata (which includes encrypted_file_key + envelope_iv pre-
 * resolved for them server-side), derives chat_key with the sender via ECDH,
 * unwraps. The result is the same AES-GCM CryptoKey the sender used to encrypt
 * the file body.
 */
// `extractable` defaults to false (the read path only decrypts the body with
// this key). Pass true when forwarding: re-wrapping the file_key for another
// chat's recipients needs to exportKey it, which requires an extractable key.
export async function unwrapFileKey(
  encryptedFileKey: string,
  envelopeIvB64: string,
  chatKey: CryptoKey,
  extractable = false,
): Promise<CryptoKey> {
  const ct = b64decode(encryptedFileKey)
  const iv = b64decode(envelopeIvB64)
  const rawBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asBuffer(iv) },
    chatKey,
    asBuffer(ct),
  )
  return crypto.subtle.importKey('raw', rawBuffer, { name: 'AES-GCM' }, extractable, ['decrypt'])
}

// ---------- key persistence ----------

const STORED_ACCOUNT_KEY = 'account_key_b64'

/**
 * Where the raw account_key is kept between reloads. Native shells and the
 * Electron app use localStorage (app-sandboxed storage, mirrored to Capacitor
 * Preferences on Android). A plain browser tab normally does not store the
 * raw key at all — it keeps a non-extractable X25519 key in IndexedDB (see
 * saveAccountKey / identityStore.ts). Only when the engine lacks WebCrypto
 * X25519 does the browser fall back to sessionStorage: the key dies with the
 * window and the next visit asks for the password again.
 */
function accountKeyStore(): Storage {
  return isWebBrowser() ? sessionStorage : localStorage
}

/**
 * Persist the raw account_key bytes (base64) to localStorage + Capacitor Preferences.
 *
 * Threat model: the device's app-private storage is the trust boundary. localStorage in
 * a Capacitor WebView (androidScheme=https) is sandboxed per app. Capacitor Preferences
 * on Android maps to SharedPreferences, which on modern Android is encrypted at rest by
 * the OS as part of file-based encryption. If an attacker has code-execution on the
 * device, they read this key — same as any other native messenger.
 */
export async function saveAccountKey(accountKey: CryptoKey): Promise<CryptoKey> {
  if (isX25519Key(accountKey)) {
    // Already the persisted web identity (e.g. re-save after a reload).
    return accountKey
  }
  if (isWebBrowser() && (await supportsWebCryptoX25519())) {
    try {
      const webKey = await toWebCryptoIdentity(accountKey)
      const publicKey = x25519PublicByKey.get(webKey)
      if (!publicKey) throw new Error('missing public key')
      await putIdentity({ privateKey: webKey, publicKey })
      try {
        sessionStorage.removeItem(STORED_ACCOUNT_KEY)
      } catch {
        // ignore
      }
      return webKey
    } catch (err) {
      log.warn('IndexedDB identity store unavailable, keeping the key for this session only:', err)
    }
  }
  const rawBuffer = await crypto.subtle.exportKey('raw', accountKey)
  const b64 = b64encode(new Uint8Array(rawBuffer))
  try {
    accountKeyStore().setItem(STORED_ACCOUNT_KEY, b64)
  } catch {
    // localStorage may be unavailable in private modes; non-fatal — account_key just
    // won't survive page reload, user re-enters password on next visit.
  }
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (Capacitor.isNativePlatform()) {
      const { Preferences } = await import('@capacitor/preferences')
      await Preferences.set({ key: STORED_ACCOUNT_KEY, value: b64 })
    }
  } catch (err) {
    log.warn('Failed to mirror account_key to Preferences:', err)
  }
  return accountKey
}

/** Read the account_key back from localStorage (after hydrate copied it from Prefs). */
export async function loadStoredAccountKey(): Promise<CryptoKey | null> {
  if (isWebBrowser()) {
    // A pre-sessionStorage build may have persisted the key on disk; drop it.
    try {
      localStorage.removeItem(STORED_ACCOUNT_KEY)
    } catch {
      // ignore
    }
    try {
      const identity = await getIdentity()
      if (identity) {
        x25519PublicByKey.set(identity.privateKey, identity.publicKey)
        return identity.privateKey
      }
    } catch (err) {
      log.warn('IndexedDB identity store unreadable:', err)
    }
  }
  const b64 = accountKeyStore().getItem(STORED_ACCOUNT_KEY)
  if (!b64) return null
  try {
    const raw = b64decode(b64)
    return await importAccountKey(raw)
  } catch (err) {
    log.warn('Stored account_key is corrupt:', err)
    return null
  }
}

/** Wipe the account_key from all storage. Called on logout. */
export async function clearStoredAccountKey(): Promise<void> {
  try {
    localStorage.removeItem(STORED_ACCOUNT_KEY)
    sessionStorage.removeItem(STORED_ACCOUNT_KEY)
  } catch {
    // ignore
  }
  try {
    await deleteIdentity()
  } catch {
    // no IndexedDB (native) or nothing stored
  }
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (Capacitor.isNativePlatform()) {
      const { Preferences } = await import('@capacitor/preferences')
      await Preferences.remove({ key: STORED_ACCOUNT_KEY })
    }
  } catch {
    // ignore
  }
}

/**
 * Mirror native-side Preferences → localStorage at app boot, the same way the auth
 * token hydration works. Must run before useAuth tries to load the key.
 */
export async function hydrateAccountKey(): Promise<void> {
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (!Capacitor.isNativePlatform()) return
    const { Preferences } = await import('@capacitor/preferences')
    const { value } = await Preferences.get({ key: STORED_ACCOUNT_KEY })
    if (value) {
      localStorage.setItem(STORED_ACCOUNT_KEY, value)
    } else {
      const existing = localStorage.getItem(STORED_ACCOUNT_KEY)
      if (existing) await Preferences.set({ key: STORED_ACCOUNT_KEY, value: existing })
    }
  } catch (err) {
    log.warn('Failed to hydrate account_key from Preferences:', err)
  }
}
