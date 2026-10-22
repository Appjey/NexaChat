// Trust-on-first-use pinning of peers' X25519 public keys + safety numbers.
//
// Why: the server hands out `users.public_key` (GET /api/profile/:id,
// GET /api/groups/:id/keys). A malicious or compromised operator could swap a
// peer's key for one they hold and read everything we send from then on. The
// client cannot detect that from the protocol alone, so it remembers the first
// key it saw for each user (the "pin") and refuses to silently switch when the
// server later serves a different one. The user compares a *safety number*
// (derived from both parties' keys, identical on both phones) out of band to
// turn "first use" into "verified".
//
// Storage: localStorage is the synchronous source of truth, Capacitor
// Preferences the durable mirror hydrated at boot — the same dance as the
// auth token (httpClient.ts) and the app lock (appLock.ts). Pins are wiped on
// logout: they belong to the account that made the trust decisions.
//
// Nothing here touches the network; peerKeys.ts calls into it.

import { log } from '../log'
import { getPlatform } from '../platform'

const STORAGE_KEY = 'e2e_key_pins_v1'

export type KeyPin = {
  /** Base64 X25519 public key as first seen (or last explicitly accepted). */
  publicKey: string
  /** User compared the safety number out of band. */
  verified: boolean
  /** Unix ms when the pin was created or last accepted. */
  pinnedAt: number
}

export type PinCheck =
  | { status: 'new' }
  | { status: 'match'; pin: KeyPin }
  | { status: 'changed'; pin: KeyPin; newKey: string }

type PinMap = Record<string, KeyPin>

// ---------- storage ----------

function readMap(): PinMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as PinMap) : {}
  } catch {
    return {}
  }
}

function writeMap(map: PinMap) {
  const value = JSON.stringify(map)
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // quota / private mode — the Preferences mirror still works on native
  }
  void mirrorToPreferences(value)
}

async function mirrorToPreferences(value: string | null) {
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (!Capacitor.isNativePlatform()) return
    const { Preferences } = await import('@capacitor/preferences')
    if (value === null) await Preferences.remove({ key: STORAGE_KEY })
    else await Preferences.set({ key: STORAGE_KEY, value })
  } catch (err) {
    log.warn('keyPins: failed to mirror to Preferences:', err)
  }
}

/** Preferences → localStorage at boot, before the first render. */
export async function hydrateKeyPins(): Promise<void> {
  if (getPlatform() === 'web') return
  try {
    const { Preferences } = await import('@capacitor/preferences')
    const { value } = await Preferences.get({ key: STORAGE_KEY })
    if (value !== null) localStorage.setItem(STORAGE_KEY, value)
  } catch (err) {
    log.warn('keyPins: hydrate failed:', err)
  }
}

/** Logout scrub. */
export function clearKeyPins(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
  void mirrorToPreferences(null)
}

// ---------- pin state machine ----------

export function getPin(userId: number): KeyPin | null {
  return readMap()[String(userId)] ?? null
}

/**
 * Compare a freshly served key with the pin. Pure read: callers decide what
 * to do (peerKeys.ts pins on 'new' and refuses the key on 'changed').
 */
export function checkPin(userId: number, publicKey: string): PinCheck {
  const pin = getPin(userId)
  if (!pin) return { status: 'new' }
  if (pin.publicKey === publicKey) return { status: 'match', pin }
  return { status: 'changed', pin, newKey: publicKey }
}

/** First sight of a key: remember it, unverified. */
export function pinKey(userId: number, publicKey: string, now = Date.now()): KeyPin {
  const map = readMap()
  const pin: KeyPin = { publicKey, verified: false, pinnedAt: now }
  map[String(userId)] = pin
  writeMap(map)
  return pin
}

/**
 * The user explicitly accepted a changed key (e.g. the peer opted out of E2E
 * and back in). The old verification does not carry over: a new key is a new
 * identity until compared again.
 */
export function acceptNewKey(userId: number, publicKey: string, now = Date.now()): KeyPin {
  return pinKey(userId, publicKey, now)
}

export function setVerified(userId: number, verified: boolean): KeyPin | null {
  const map = readMap()
  const pin = map[String(userId)]
  if (!pin) return null
  const next = { ...pin, verified }
  map[String(userId)] = next
  writeMap(map)
  return next
}

// ---------- fingerprints and safety numbers (pure, deterministic) ----------

function b64decode(s: string): Uint8Array {
  const binary = atob(s)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function sha256(parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const buf = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    buf.set(p, off)
    off += p.length
  }
  const digest = await crypto.subtle.digest('SHA-256', buf as unknown as BufferSource)
  return new Uint8Array(digest)
}

function toHexGroups(bytes: Uint8Array, groupLen: number): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return hex.match(new RegExp(`.{1,${groupLen}}`, 'g'))?.join(' ') ?? hex
}

/**
 * Short per-key fingerprint: first 16 bytes of SHA-256(raw key) as eight
 * hex groups. Shown in the key-change dialog ("was … / now …") and in the own
 * profile so a user can read their key to a peer.
 */
export async function keyFingerprint(publicKeyB64: string): Promise<string> {
  const digest = await sha256([new TextEncoder().encode('nothing-key-fp-v1'), b64decode(publicKeyB64)])
  return toHexGroups(digest.subarray(0, 16), 4)
}

/**
 * Safety number for a pair of users, identical on both devices:
 *
 *   SHA-256( "nothing-safety-v1" || idA || keyA || idB || keyB )
 *
 * where (idA, keyA) is the pair with the smaller user id, ids are encoded as
 * 8-byte big-endian, keys are the raw 32-byte X25519 points. The 256-bit
 * digest is rendered as 60 decimal digits in 12 groups of 5 (digit stream =
 * the digest interpreted as an unsigned big-endian integer, zero-padded to 78
 * digits, first 60 kept). Two users read the groups to each other; any
 * mismatch means at least one side holds a substituted key.
 */
export async function safetyNumber(
  a: { userId: number; publicKey: string },
  b: { userId: number; publicKey: string },
): Promise<string> {
  const [first, second] = a.userId <= b.userId ? [a, b] : [b, a]
  const idBytes = (id: number) => {
    const out = new Uint8Array(8)
    new DataView(out.buffer).setBigUint64(0, BigInt(id))
    return out
  }
  const digest = await sha256([
    new TextEncoder().encode('nothing-safety-v1'),
    idBytes(first.userId),
    b64decode(first.publicKey),
    idBytes(second.userId),
    b64decode(second.publicKey),
  ])
  let n = 0n
  for (const byte of digest) n = (n << 8n) | BigInt(byte)
  const digits = n.toString(10).padStart(78, '0').slice(0, 60)
  const groups: string[] = []
  for (let i = 0; i < digits.length; i += 5) groups.push(digits.slice(i, i + 5))
  return groups.join(' ')
}
