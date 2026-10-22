import { endpoints } from '../api/endpoints'
import { httpGet } from '../api/httpClient'
import { log } from '../log'
import type { GroupEnvelope, GroupRecipientKey } from './e2e'
import {
  deriveChatKey,
  encryptFile,
  encryptForGroup,
  encryptMetadata,
  generateFileKey,
  publicKeyBase64,
  unwrapFileKey,
  wrapFileKey,
} from './e2e'
import { acceptNewKey, checkPin, pinKey } from './keyPins'

/**
 * In-memory cache of other users' X25519 public keys, keyed by user_id.
 *
 *   - `string`  → user has E2E set up, value is the base64 public_key
 *   - `null`    → server confirmed no E2E for this user; the sender must block the send
 *   - missing   → not yet looked up
 *
 * Promises are memoised too so concurrent send paths don't issue duplicate HTTP
 * requests. The cache is wiped on logout (via clearPeerKeys below) and never persisted
 * to disk — public keys are cheap to refetch and bounded to the chats the user touches.
 *
 * NOTE: only *non-null* keys are cached. If we look up a peer who hasn't onboarded
 * into E2E yet, the result is NOT memoised — the next call refetches. Otherwise
 * we'd be stuck in "peer has no key" forever, even after they bootstrap and start
 * sending us scheme=2 messages. (Previous behaviour caused the "🔒 placeholder"
 * + "X не настроил шифрование" banner to persist after the peer was actually ready.)
 */
const cache: Map<number, string> = new Map()
const inflight: Map<number, Promise<string | null>> = new Map()

// ---------- trust-on-first-use ----------
//
// Every key the server serves goes through `reconcileWithPin` before it is
// used or cached. First sight pins it (keyPins.ts); a later key that differs
// from the pin is NOT used — it is parked in `changedKeys` and a window event
// tells the UI to show the key-change warning. Only an explicit
// `acceptChangedKey` (user action) replaces the pin. Own key is exempt: it is
// derived locally, not trusted from the server.

/** Fired on `window` whenever the set of unaccepted key changes changes. */
export const KEY_CHANGED_EVENT = 'e2e:key-changed'

const changedKeys: Map<number, string> = new Map()
let selfUserId: number | null = null

function notifyKeyChange() {
  try {
    window.dispatchEvent(new Event(KEY_CHANGED_EVENT))
  } catch {
    // no window (tests)
  }
}

/** Returns the key to use, or null when it differs from the pin and awaits the user's decision. */
function reconcileWithPin(userId: number, served: string): string | null {
  if (selfUserId !== null && userId === selfUserId) return served
  const check = checkPin(userId, served)
  if (check.status === 'new') {
    pinKey(userId, served)
    return served
  }
  if (check.status === 'match') {
    if (changedKeys.delete(userId)) notifyKeyChange()
    return served
  }
  if (changedKeys.get(userId) !== served) {
    changedKeys.set(userId, served)
    log.warn(`E2E: server served a different public_key for user ${userId}; refusing until accepted`)
    notifyKeyChange()
  }
  return null
}

/** The key the server currently serves for a user whose pin it no longer matches, if any. */
export function getChangedKey(userId: number): string | null {
  return changedKeys.get(userId) ?? null
}

export function hasKeyChange(userId: number): boolean {
  return changedKeys.has(userId)
}

/**
 * The user looked at the warning (ideally compared the safety number) and
 * accepts the new key: it becomes the pin, unverified, and sending resumes.
 */
export function acceptChangedKey(userId: number): boolean {
  const key = changedKeys.get(userId)
  if (!key) return false
  acceptNewKey(userId, key)
  changedKeys.delete(userId)
  cache.set(userId, key)
  notifyKeyChange()
  return true
}

type ProfileResponse = { public_key?: string | null }

/**
 * Look up another user's X25519 public_key. Returns null if the user hasn't onboarded
 * into E2E yet — callers should treat that as "peer is not E2E-ready, block the
 * send (the new strict policy)". Null lookups are NOT cached so we automatically
 * recover the moment the peer onboards.
 */
export async function getPeerPublicKey(userId: number): Promise<string | null> {
  const cached = cache.get(userId)
  if (cached !== undefined) return cached
  const existing = inflight.get(userId)
  if (existing) return existing

  const promise = (async () => {
    try {
      const profile = await httpGet<ProfileResponse>(endpoints.profile(userId))
      const served = profile.public_key || null
      if (!served) return null
      const key = reconcileWithPin(userId, served)
      if (key) cache.set(userId, key)
      return key
    } catch (err) {
      log.warn('failed to fetch peer public_key:', err)
      // Don't cache failures forever — caller can retry. But don't refetch within
      // the same tick either; remove the inflight entry so the next attempt is fresh.
      return null
    } finally {
      inflight.delete(userId)
    }
  })()
  inflight.set(userId, promise)
  return promise
}


/**
 * Drop the entire cache. Called on logout so a different user signing in on the same
 * device doesn't inherit a stale view of peers' keys (also keeps the in-memory
 * footprint bounded across long sessions).
 */
export function clearPeerKeyCache(): void {
  cache.clear()
  inflight.clear()
  changedKeys.clear()
  selfUserId = null
}

/**
 * Pre-populate the cache from an already-known (user_id, public_key) pair —
 * primarily the current user's own pubkey, derived locally from accountKey.
 *
 * Without this seed, opening the "Saved Messages" self-chat (user1==user2)
 * would round-trip /api/profile/<myId> on every cold start; on a flaky
 * network that fetch fails and the chat renders the "peer hasn't set up
 * encryption" banner against *yourself*. With it seeded, self-chat works
 * fully offline since the chat_key derives from local material end-to-end.
 *
 * No-op for falsy inputs so callers can pass `seedPeerPublicKey(user?.id, key)`
 * without a guard.
 */
export function seedPeerPublicKey(userId: number | null | undefined, publicKey: string | null | undefined): void {
  if (userId && publicKey) {
    cache.set(userId, publicKey)
    // The seeded key is our own (derived locally) — exempt it from pinning.
    selfUserId = userId
  }
}

/**
 * Compose the full path from "the other user in a 1-on-1 chat" to "an AES-GCM
 * key shared with that user". Pass null/0 for `peerUserId` (i.e. group chats
 * or unknown peer) and the function returns null, signalling "fall back to
 * scheme=1 server-side encryption".
 *
 *   chat_key = HKDF( X25519(my_account_key.private, peer.public_key), "msg-key" )
 *
 * Both sides arrive at the same key by ECDH symmetry, so encrypt/decrypt match.
 */
export async function getChatKey(
  accountKey: CryptoKey | null,
  peerUserId: number | null | undefined,
): Promise<CryptoKey | null> {
  if (!accountKey || !peerUserId) return null
  const peerPublicKey = await getPeerPublicKey(peerUserId)
  if (!peerPublicKey) return null
  return deriveChatKey(accountKey, peerPublicKey)
}

// ---------- group pairwise (Variant A) ----------

type GroupKeysResponse = { members?: Array<{ user_id: number; public_key: string }> }

/**
 * GroupKeyStatus is the full picture of a group's E2E readiness — both the
 * recipient list (only useful if `missingUserIds` is empty) and the set of
 * members who haven't onboarded into E2E yet (caller can show their names).
 *
 * Returns null only if the request itself fails (network, 403). A group where
 * every member is missing a public_key returns a status with all userIds in
 * `missingUserIds` — not null — so the UI can render a precise "N members
 * haven't set up encryption" message.
 */
export type GroupKeyStatus = {
  recipients: GroupRecipientKey[]
  missingUserIds: number[]
  /** Members whose served key differs from the pinned one and is not accepted yet. */
  changedUserIds: number[]
}

/**
 * Fetch the X25519 public_key of every member of a group. Not cached: group
 * membership and per-user public_keys can change at any time (member
 * added/removed, password rotation), and the latency to refetch is one
 * round-trip — much cheaper than serving a stale ciphertext that one member
 * can't decrypt.
 */
export async function getGroupKeyStatus(chatId: number): Promise<GroupKeyStatus | null> {
  try {
    const resp = await httpGet<GroupKeysResponse>(endpoints.groups.keys(chatId))
    const members = resp.members ?? []
    const changedUserIds: number[] = []
    const recipients: GroupRecipientKey[] = members.map((m) => {
      if (!m.public_key) return { userID: m.user_id, publicKey: '' }
      const key = reconcileWithPin(m.user_id, m.public_key)
      if (!key) changedUserIds.push(m.user_id)
      return { userID: m.user_id, publicKey: key ?? '' }
    })
    const missingUserIds = recipients
      .filter((r) => !r.publicKey && !changedUserIds.includes(r.userID))
      .map((r) => r.userID)
    return { recipients, missingUserIds, changedUserIds }
  } catch (err) {
    log.warn('failed to fetch group keys:', err)
    return null
  }
}

// ---------- attachment helpers ----------

// Internal types used by prepareAttachmentForUpload below. Not exported —
// callers receive PreparedAttachment via the function return type, no need to
// import the type name directly.
type AttachmentEnvelopeWire = {
  recipient_id: number
  encrypted_file_key: string
  iv: string
}

type PreparedAttachment = {
  ciphertext: Blob
  fileIv: string
  encryptedMetadata: string
  metadataIv: string
  envelopes: AttachmentEnvelopeWire[]
}

/**
 * Resolve the list of "recipients" for the current chat from the e2eStatus
 * shape ChatWindow already maintains. For a group, recipients comes from
 * `getGroupKeyStatus` (includes the sender). For a 1-on-1 we synthesize it:
 * sender's own public_key plus the peer's. Sender's own public_key is needed
 * so the sender can decrypt their own attachment on another device (matches
 * the message envelope pattern).
 */
export async function resolveAttachmentRecipients(args: {
  isGroup: boolean
  groupRecipients?: GroupRecipientKey[]
  peerUserId?: number
  senderUserId: number
  senderAccountKey: CryptoKey
}): Promise<GroupRecipientKey[] | null> {
  if (args.isGroup) {
    if (!args.groupRecipients || args.groupRecipients.length === 0) return null
    return args.groupRecipients
  }
  if (!args.peerUserId) return null
  const peerKey = await getPeerPublicKey(args.peerUserId)
  if (!peerKey) return null
  const selfKey = await publicKeyBase64(args.senderAccountKey)
  // Saved Messages (self-chat): sender == peer, so a single envelope covers the
  // only recipient. The server's expected recipient set is {me} (user1_id ==
  // user2_id), so emitting both sender+peer would duplicate recipient_id and the
  // upload is rejected ("duplicate envelope for recipient N").
  if (args.peerUserId === args.senderUserId) {
    return [{ userID: args.senderUserId, publicKey: selfKey }]
  }
  return [
    { userID: args.senderUserId, publicKey: selfKey },
    { userID: args.peerUserId, publicKey: peerKey },
  ]
}

/**
 * Re-wrap an existing attachment's file_key for a different chat's recipients —
 * the crypto half of forwarding a file. The body ciphertext is untouched (the
 * server copies it); we only unwrap the 32-byte file_key from our own envelope
 * in the source chat and re-wrap it under each destination recipient's chat_key.
 * E2E preserved: the file_key never leaves the client, the server sees only
 * opaque envelopes.
 *
 * ownEncryptedFileKey / ownEnvelopeIv: the requesting user's envelope on the
 * source attachment (server pre-resolves these). sourceSenderUserId: the source
 * message's author, used to derive the source chat_key that wrapped it.
 */
export async function rewrapAttachmentEnvelopes(args: {
  ownEncryptedFileKey: string
  ownEnvelopeIv: string
  sourceSenderUserId: number
  recipients: GroupRecipientKey[]
  accountKey: CryptoKey
}): Promise<AttachmentEnvelopeWire[]> {
  const sourceChatKey = await getChatKey(args.accountKey, args.sourceSenderUserId)
  if (!sourceChatKey) throw new Error('rewrap: cannot derive source chat_key')
  // extractable=true: we need to exportKey it below to re-wrap for the destination.
  const fileKey = await unwrapFileKey(args.ownEncryptedFileKey, args.ownEnvelopeIv, sourceChatKey, true)
  const out: AttachmentEnvelopeWire[] = []
  for (const r of args.recipients) {
    if (!r.publicKey) throw new Error(`rewrap: recipient ${r.userID} has no public_key`)
    const destChatKey = await deriveChatKey(args.accountKey, r.publicKey)
    const wrapped = await wrapFileKey(fileKey, destChatKey)
    out.push({ recipient_id: r.userID, encrypted_file_key: wrapped.encryptedFileKey, iv: wrapped.iv })
  }
  return out
}

/**
 * Encrypt one file and produce its per-recipient envelope set. Throws on the
 * same conditions as encryptForGroup: empty recipients, recipient with empty
 * public_key. Caller is expected to have gated send on e2eStatus = 'ready'.
 */
export async function prepareAttachmentForUpload(
  file: File,
  recipients: GroupRecipientKey[],
  senderAccountKey: CryptoKey,
): Promise<PreparedAttachment> {
  if (recipients.length === 0) throw new Error('prepareAttachmentForUpload: no recipients')
  const fileKey = await generateFileKey()
  const { ciphertext, iv: fileIv } = await encryptFile(file, fileKey)

  // Encrypt the user-visible metadata (filename + mime) under the same
  // file_key. Server-side this lands in the `encrypted_metadata` column
  // instead of the legacy plaintext `file_name` / `mime_type` columns —
  // operator can no longer read either via pg_dump. The receiving client
  // unwraps file_key, decrypts both metadata and body, then derives the
  // render bucket (image / video / document) from the decrypted mime.
  const { ciphertext: encryptedMetadata, iv: metadataIv } = await encryptMetadata(
    { fileName: file.name, mimeType: file.type || 'application/octet-stream' },
    fileKey,
  )

  const envelopes: AttachmentEnvelopeWire[] = []
  for (const r of recipients) {
    if (!r.publicKey) throw new Error(`prepareAttachmentForUpload: recipient ${r.userID} has no public_key`)
    const chatKey = await deriveChatKey(senderAccountKey, r.publicKey)
    const wrapped = await wrapFileKey(fileKey, chatKey)
    envelopes.push({
      recipient_id: r.userID,
      encrypted_file_key: wrapped.encryptedFileKey,
      iv: wrapped.iv,
    })
  }

  // Same TypeScript-narrowing dance as elsewhere: Uint8Array's buffer is
  // typed as ArrayBufferLike which doesn't satisfy Blob's BlobPart. Cast
  // through unknown — the underlying buffer is a real ArrayBuffer (we just
  // allocated it via crypto.subtle.encrypt).
  return {
    ciphertext: new Blob([ciphertext as unknown as BlobPart], { type: 'application/octet-stream' }),
    fileIv,
    encryptedMetadata,
    metadataIv,
    envelopes,
  }
}

/**
 * Encrypt `plaintext` for every current member of a group via pairwise X25519
 * ECDH. Throws if any member lacks a public_key — callers MUST gate this on
 * a prior getGroupKeyStatus check (UI blocks send until every member is
 * E2E-ready, which the lazy-vault modal in App.tsx guarantees for active users).
 *
 * `senderUserId` is required so we can include a self-envelope (so the sender
 * can read their own message back on another device). X25519 ECDH-with-self
 * is well-defined, deterministic, and only reproducible by the sender.
 */
export async function encryptGroupMessage(
  plaintext: string,
  status: GroupKeyStatus,
  accountKey: CryptoKey,
  senderUserId: number,
): Promise<GroupEnvelope[]> {
  if (status.missingUserIds.length > 0) {
    throw new Error(`encryptGroupMessage: ${status.missingUserIds.length} members missing public_key`)
  }
  if (status.changedUserIds.length > 0) {
    throw new Error(`encryptGroupMessage: ${status.changedUserIds.length} members have an unaccepted key change`)
  }
  if (!status.recipients.some((r) => r.userID === senderUserId)) {
    throw new Error('encryptGroupMessage: sender not in recipient list')
  }
  return encryptForGroup(plaintext, status.recipients, accountKey)
}
