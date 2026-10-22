import { log } from '../log'
import { decryptMessage } from './e2e'

/** Placeholder shown for a scheme=2 message we can't decrypt — missing chat_key or corrupt ciphertext. */
const ENCRYPTED_PLACEHOLDER = '[зашифрованное сообщение]'

type AnyTextHolder = { text: string; scheme?: number; iv?: string }

/**
 * Best-effort decrypt of one message payload. Returns a shallow copy with
 * `text` replaced by plaintext (or the placeholder on failure) and `iv`
 * cleared. `scheme` is preserved so the edit flow knows the message
 * originated as E2E.
 *
 * Non-E2E payloads (system messages, scheme missing/0/1) are returned
 * unchanged — the backend doesn't emit scheme=1 ciphertext anymore, and
 * system messages are plaintext by design.
 */
export async function decryptIncomingText<T extends AnyTextHolder>(
  payload: T,
  chatKey: CryptoKey | null,
): Promise<T> {
  if (payload.scheme !== 2) return payload
  if (!chatKey || !payload.iv) {
    return { ...payload, text: ENCRYPTED_PLACEHOLDER, iv: '' }
  }
  try {
    const plaintext = await decryptMessage(payload.text, payload.iv, chatKey)
    return { ...payload, text: plaintext, iv: '' }
  } catch (err) {
    log.warn('E2E decrypt failed:', err)
    return { ...payload, text: ENCRYPTED_PLACEHOLDER, iv: '' }
  }
}
