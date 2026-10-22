import { describe, expect, it } from 'vitest'

import {
  decryptMessage,
  deriveChatKey,
  encryptMessage,
  publicKeyBase64,
  setupNewVault,
  toWebCryptoIdentity,
} from './e2e'
import { supportsWebCryptoX25519 } from './identityStore'

// The web build carries a non-extractable WebCrypto X25519 key instead of the
// raw account_key. It must behave identically to the raw (noble) path, or a
// browser user and an app user could never read each other's messages.
describe('e2e: WebCrypto X25519 identity', () => {
  it('runtime supports WebCrypto X25519 (needed for these tests)', async () => {
    expect(await supportsWebCryptoX25519()).toBe(true)
  })

  it('has the same public key as the raw derivation and cannot be exported', async () => {
    const { accountKey } = await setupNewVault('alice-pass')
    const webKey = await toWebCryptoIdentity(accountKey)
    expect(webKey.extractable).toBe(false)
    expect(webKey.algorithm.name).toBe('X25519')
    expect(await publicKeyBase64(webKey)).toBe(await publicKeyBase64(accountKey))
    await expect(crypto.subtle.exportKey('jwk', webKey)).rejects.toThrow()
  })

  it('derives the same chat key via WebCrypto as via noble, both directions', async () => {
    const alice = await setupNewVault('alice-pass')
    const bob = await setupNewVault('bob-pass')
    const aliceWeb = await toWebCryptoIdentity(alice.accountKey)
    const bobPub = await publicKeyBase64(bob.accountKey)
    const alicePub = await publicKeyBase64(alice.accountKey)

    // Alice (web) → Bob (app)
    const sent = await encryptMessage('привет из браузера', await deriveChatKey(aliceWeb, bobPub))
    const bobKey = await deriveChatKey(bob.accountKey, alicePub)
    expect(await decryptMessage(sent.ciphertext, sent.iv, bobKey)).toBe('привет из браузера')

    // Bob (app) → Alice (web)
    const reply = await encryptMessage('и тебе из приложения', bobKey)
    expect(await decryptMessage(reply.ciphertext, reply.iv, await deriveChatKey(aliceWeb, bobPub))).toBe('и тебе из приложения')

    // Alice (web) ↔ Alice (app): same identity, same self-chat key
    const selfWeb = await deriveChatKey(aliceWeb, alicePub)
    const selfApp = await deriveChatKey(alice.accountKey, alicePub)
    const note = await encryptMessage('заметка', selfWeb)
    expect(await decryptMessage(note.ciphertext, note.iv, selfApp)).toBe('заметка')
  })
})
