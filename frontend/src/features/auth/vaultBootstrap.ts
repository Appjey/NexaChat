import { endpoints } from '../../shared/api/endpoints'
import { httpPut } from '../../shared/api/httpClient'
import {
  isE2EAvailable,
  openVault,
  publicKeyBase64,
  saveAccountKey,
  setupNewVault,
  type VaultMaterial,
} from '../../shared/crypto/e2e'
import { log } from '../../shared/log'

type ServerVaultFields = {
  vault_salt?: string | null
  encrypted_account_key?: string | null
  public_key?: string | null
}

/**
 * After a successful login/register, establish the user's E2E account_key:
 *
 *   - If the server returned existing `vault_salt` + `encrypted_account_key` we
 *     re-derive the vault_key from the password they just typed and unwrap the
 *     same account_key all other devices use.
 *
 *   - If both are absent we treat this as first-time E2E onboarding: generate a
 *     fresh account_key + salt, wrap it under the password, PUT it back to the
 *     server. Subsequent logins (this device or others) hit the first branch.
 *
 * The returned key is persisted to localStorage + Capacitor Preferences before
 * returning so the AccountKeyProvider can read it back on a future cold start
 * without needing the password again.
 *
 * Returns null if WebCrypto isn't usable (very old runtimes). E2E is mandatory,
 * so the composer then stays disabled and E2E messages render as placeholders.
 *
 * Throws if the password is wrong (existing vault that won't unwrap) or if the
 * server-side PUT fails on a fresh setup. Callers swallow + show a generic
 * error rather than blocking login on E2E setup.
 */
export async function bootstrapVaultOnLogin(
  password: string,
  serverFields: ServerVaultFields,
): Promise<CryptoKey | null> {
  if (!isE2EAvailable()) return null

  const hasExistingVault =
    typeof serverFields.vault_salt === 'string' &&
    serverFields.vault_salt.length > 0 &&
    typeof serverFields.encrypted_account_key === 'string' &&
    serverFields.encrypted_account_key.length > 0

  let accountKey: CryptoKey

  if (hasExistingVault) {
    accountKey = await openVault(password, {
      vaultSalt: serverFields.vault_salt as string,
      encryptedAccountKey: serverFields.encrypted_account_key as string,
    })

    // Phase B-only users have vault material but no public_key on the server yet.
    // Backfill it in the background — derives deterministically from the same
    // account_key, so once it's uploaded other users can ECDH against it. Failure
    // here is non-fatal: other users cannot encrypt to this user until the
    // next login fixes the row.
    if (!serverFields.public_key) {
      try {
        const pub = await publicKeyBase64(accountKey)
        await putVault({
          vaultSalt: serverFields.vault_salt as string,
          encryptedAccountKey: serverFields.encrypted_account_key as string,
          publicKey: pub,
        })
      } catch (err) {
        log.warn('Phase C public_key backfill failed:', err)
      }
    }
  } else {
    const { accountKey: fresh, vault } = await setupNewVault(password)
    // Tell the server about our new vault material. If this fails the user is still
    // logged in fine, but their account_key won't be recoverable from another device
    // until they re-set it — bubble the error so the caller can decide whether to
    // surface it.
    await putVault({
      ...vault,
      publicKey: await publicKeyBase64(fresh),
    })
    accountKey = fresh
  }

  // On the web this returns the non-extractable X25519 identity that was just
  // persisted; everywhere else it is the account_key itself.
  return saveAccountKey(accountKey)
}

/**
 * Push fresh vault material to the server. Used by the onboarding flow above and by
 * the password-change rotation flow in ChangePasswordForm. publicKey is mandatory
 * for new uploads — the server rejects half-state where salt+wrap exist but
 * public_key doesn't (other users could otherwise ECDH against nothing).
 */
export async function putVault(vault: VaultMaterial & { publicKey: string }): Promise<void> {
  await httpPut(endpoints.auth.vault, {
    vault_salt: vault.vaultSalt,
    encrypted_account_key: vault.encryptedAccountKey,
    public_key: vault.publicKey,
  })
}
