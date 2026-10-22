// Browser-side persistence of the E2E identity as a non-extractable WebCrypto
// X25519 key in IndexedDB.
//
// Why: a plain browser tab is the one runtime where page storage is readable
// by any script on the origin and from DevTools. Keeping the raw account_key
// there (even in sessionStorage) means an XSS can copy it and read the
// account's history forever. A CryptoKey created with `extractable: false`
// can be *used* by the page — ECDH still works, messages still decrypt — but
// the browser refuses to hand out its bytes, so the worst an XSS can do is
// decrypt while the tab is open; it cannot take the key away. IndexedDB is
// the only storage that persists CryptoKey objects (structured clone), which
// is also what gives "no password on every visit".
//
// Native shells and Electron keep the raw key in app-sandboxed storage
// (e2e.ts); this module is only reached from the web branch there.

const DB_NAME = 'nothing-e2e'
const DB_VERSION = 1
const STORE = 'identity'
const RECORD_ID = 'x25519'

export type StoredIdentity = {
  /** Non-extractable X25519 private key, usage deriveBits. */
  privateKey: CryptoKey
  /** Raw 32-byte public half (the key object cannot export it either). */
  publicKey: Uint8Array
}

type IdentityRecord = StoredIdentity & { id: string }

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
    req.onblocked = () => reject(new Error('IndexedDB open blocked'))
  })
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB()
  try {
    const tx = db.transaction(STORE, mode)
    const result = await requestToPromise(fn(tx.objectStore(STORE)))
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    })
    return result
  } finally {
    db.close()
  }
}

export async function putIdentity(identity: StoredIdentity): Promise<void> {
  const record: IdentityRecord = { id: RECORD_ID, ...identity }
  await withStore('readwrite', (s) => s.put(record))
}

export async function getIdentity(): Promise<StoredIdentity | null> {
  const record = await withStore<IdentityRecord | undefined>('readonly', (s) => s.get(RECORD_ID))
  if (!record || !record.privateKey || !(record.publicKey instanceof Uint8Array)) return null
  return { privateKey: record.privateKey, publicKey: record.publicKey }
}

export async function deleteIdentity(): Promise<void> {
  await withStore('readwrite', (s) => s.delete(RECORD_ID))
}

// ---------- WebCrypto X25519 ----------

let x25519Support: Promise<boolean> | null = null

/**
 * X25519 in WebCrypto: Chrome 133+, Firefox 130+, Safari 17+. Probed once by
 * generating a throwaway key; older engines throw NotSupportedError and the
 * caller falls back to the raw-key path.
 */
export function supportsWebCryptoX25519(): Promise<boolean> {
  if (!x25519Support) {
    x25519Support = (async () => {
      try {
        if (typeof crypto === 'undefined' || !crypto.subtle) return false
        await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
        return true
      } catch {
        return false
      }
    })()
  }
  return x25519Support
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Import a raw X25519 scalar + public point as a NON-extractable WebCrypto
 * private key. WebCrypto only imports private X25519 keys as JWK/PKCS#8, and
 * the JWK form needs both halves, hence the public key argument.
 */
export async function importX25519Private(rawPrivate: Uint8Array, rawPublic: Uint8Array): Promise<CryptoKey> {
  const jwk: JsonWebKey = { kty: 'OKP', crv: 'X25519', d: base64url(rawPrivate), x: base64url(rawPublic) }
  return crypto.subtle.importKey('jwk', jwk, { name: 'X25519' }, false, ['deriveBits'])
}

export async function importX25519Public(rawPublic: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', rawPublic as unknown as BufferSource, { name: 'X25519' }, true, [])
}

/** ECDH with a WebCrypto private key; returns the 32-byte shared secret (RFC 7748 output). */
export async function x25519DeriveShared(privateKey: CryptoKey, peerPublic: CryptoKey): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits({ name: 'X25519', public: peerPublic } as EcdhKeyDeriveParams, privateKey, 256)
  return new Uint8Array(bits)
}
