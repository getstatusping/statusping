/**
 * The secret epoch: a random value in `instance_secrets` that a reset (beginSetup) and a finished
 * setup (completeSetup) replace. Keys that come from operator secrets (SESSION_SECRET,
 * STATUSPING_RECOVERY_TOKEN, ACK_SECRET) do not change on a reset, so whatever they sign is bound
 * to the epoch instead: the signing key is HMAC(secret, purpose:epoch). A new epoch therefore ends
 * every session, recovery session and alert link signed before it.
 *
 * A second value, the sign-in epoch, is replaced when an administrator changes the sign-in method
 * (Settings → Access, or `cli recover`). Only sign-ins (sessions and recovery sessions) are bound to
 * it, so a sign-in method change signs everyone out without breaking acknowledgement links in
 * alerts already sent.
 *
 * Sites upgraded from a release without an epoch have none until their first reset, setup or
 * sign-in method change. Until then the secret is used unchanged, exactly as before, so an upgrade
 * signs nobody out.
 */
import type { Db, Statement } from '../db/types.ts'
import { hmacSha256Hex, randomToken } from '../util/crypto.ts'

export const SECRET_EPOCH_NAME = 'secret_epoch'
export const SIGN_IN_EPOCH_NAME = 'sign_in_epoch'

export type EpochPurpose = 'session' | 'recovery' | 'ack'

/** The current epoch, or null on a site that has not been reset or set up since upgrading. */
export async function secretEpoch(db: Db): Promise<string | null> {
  return (await db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = ?`, [SECRET_EPOCH_NAME]))?.value || null
}

/**
 * `secret` bound to the current epoch for one purpose (the secret itself before the first epoch).
 * Sessions and recovery sessions are also bound to the sign-in epoch when there is one; without
 * one the derivation is exactly that of 0.3.17, so upgrading signs nobody out.
 */
export async function epochKey(db: Db, secret: string, purpose: EpochPurpose): Promise<string> {
  const epoch = await secretEpoch(db)
  const signIn = purpose === 'ack' ? null
    : (await db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = ?`, [SIGN_IN_EPOCH_NAME]))?.value || null
  if (!epoch && !signIn) return secret
  return hmacSha256Hex(secret, `statusping-epoch:${purpose}:${epoch ?? ''}${signIn ? `:sign-in:${signIn}` : ''}`)
}

const rotate = (name: string, now: number): Statement => ({
  sql: `INSERT INTO instance_secrets (name, value, created_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
  params: [name, randomToken(48), now],
})

/** Replaces the epoch; part of the reset and setup-complete batches. */
export function rotateEpochStatement(now: number): Statement {
  return rotate(SECRET_EPOCH_NAME, now)
}

/** Replaces the sign-in epoch, ending every session and recovery session (not alert links). */
export function rotateSignInEpochStatement(now: number): Statement {
  return rotate(SIGN_IN_EPOCH_NAME, now)
}
