import { describe, expect, it } from 'vitest'

import type { Message } from '../../shared/api/types'
import { deriveChatKey, encryptMessage, publicKeyBase64, setupNewVault } from '../../shared/crypto/e2e'
import { clearPeerKeyCache, seedPeerPublicKey } from '../../shared/crypto/peerKeys'
import { canDecryptThread, decryptMessages, selectScheme2Payload } from './threadCrypto'

describe('threadCrypto: cold deep-link decryption lifecycle', () => {
  it('blocks caching while chat metadata or accountKey is missing and decrypts once hydrated', async () => {
    clearPeerKeyCache()
    const { accountKey: aliceKey } = await setupNewVault('alice-password')
    const { accountKey: bobKey } = await setupNewVault('bob-password')

    const alicePub = await publicKeyBase64(aliceKey)
    const bobPub = await publicKeyBase64(bobKey)

    const chatKey = await deriveChatKey(aliceKey, bobPub)
    const { ciphertext, iv } = await encryptMessage('Привет из холодного старта!', chatKey)

    const raw: Message[] = [
      {
        id: 101,
        chat_id: 3,
        user_id: 2,
        text: ciphertext,
        iv,
        scheme: 2,
        is_deleted: false,
        attachments: [],
        created_at: '2026-10-31T14:00:00Z',
      },
    ]

    // 1. Cold deep-link (`/?chat=3`) before `getCurrentUserChats()` resolves:
    //    `chat` is undefined. `canDecryptThread` must be false so we never
    //    poison `messageCacheRef` / `localStorage` with placeholder text.
    expect(canDecryptThread(raw, undefined, aliceKey)).toBe(false)
    const unhydrated = await decryptMessages(raw, undefined, aliceKey)
    expect(unhydrated[0].text).toBe('[зашифрованное сообщение]')

    // 2. Cold deep-link before `AccountKey` finishes loading (`accountKey` is null):
    const chatMeta = { is_group: false, other_user_id: 2 }
    expect(canDecryptThread(raw, chatMeta, null)).toBe(false)

    // 3. Once both `chatMeta` and `accountKey` are hydrated (and peer key is available),
    //    `canDecryptThread` returns true and `decryptMessages` recovers plaintext.
    seedPeerPublicKey(1, alicePub)
    seedPeerPublicKey(2, bobPub)
    expect(canDecryptThread(raw, chatMeta, aliceKey)).toBe(true)

    const decrypted = await decryptMessages(raw, chatMeta, aliceKey)
    expect(decrypted[0].text).toBe('Привет из холодного старта!')
    clearPeerKeyCache()
  })

  it('selectScheme2Payload picks the recipient envelope for group broadcasts', () => {
    const picked = selectScheme2Payload(
      [
        { recipient_id: 1, ciphertext: 'ct-1', iv: 'iv-1' },
        { recipient_id: 2, ciphertext: 'ct-2', iv: 'iv-2' },
      ],
      '',
      undefined,
      2,
    )
    expect(picked).toEqual({ text: 'ct-2', iv: 'iv-2' })
    expect(
      selectScheme2Payload(
        [{ recipient_id: 1, ciphertext: 'ct-1', iv: 'iv-1' }],
        '',
        undefined,
        99,
      ),
    ).toBeNull()
  })
})
