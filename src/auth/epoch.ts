/**
 * The secret epoch: a random value in `instance_secrets` that a reset (beginSetup) and a finished
 * setup (completeSetup) replace. Keys that come from operator secrets (SESSION_SECRET,
 * STATUSPING_RECOVERY_TOKEN, ACK_SECRET) do not change on a reset, so whatever they sign is bound
 * to the epoch instead: the signing key is HMAC(secret, purpose:epoch). A new epoch therefore ends
 * every session, recovery session and alert link signed before it.
 *
 * Sites upgraded from a release without an epoch have none until their first reset or setup. Until
 * then the secret is used unchanged, exactly as before, so an upgrade signs nobody out.
 */
import type { Db, Statement } from '../db/types.ts'
import { hmacSha256Hex, randomToken } from '../util/crypto.ts'

export const SECRET_EPOCH_NAME = 'secret_epoch'

export type EpochPurpose = 'session' | 'recovery' | 'ack'

/** The current epoch, or null on a site that has not been reset or set up since upgrading. */
export async function secretEpoch(db: Db): Promise<string | null> {
  return (await db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = ?`, [SECRET_EPOCH_NAME]))?.value || null
}

/** `secret` bound to the current epoch for one purpose (the secret itself before the first epoch). */
export async function epochKey(db: Db, secret: string, purpose: EpochPurpose): Promise<string> {
  const epoch = await secretEpoch(db)
  return epoch ? hmacSha256Hex(secret, `statusping-epoch:${purpose}:${epoch}`) : secret
}

/** Replaces the epoch; part of the reset and setup-complete batches. */
export function rotateEpochStatement(now: number): Statement {
  return {
    sql: `INSERT INTO instance_secrets (name, value, created_at) VALUES (?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
    params: [SECRET_EPOCH_NAME, randomToken(48), now],
  }
}
