import type { Db } from './db/types.ts'
import { randomToken, timingSafeEqual } from './util/crypto.ts'
import { epochKey } from './auth/epoch.ts'
import { nowSeconds } from './util/time.ts'

export const ACK_LINK_TTL = 24 * 60 * 60

type Capability = { i: number; e: number }

function base64url(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function unbase64url(text: string): string | null {
  try {
    const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - text.length % 4) % 4)
    return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)))
  } catch {
    return null
  }
}

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** Where the derived acknowledgement key lives when ACK_SECRET is not set. */
export const ACK_KEY_NAME = 'ack_key'

/**
 * The key that signs alert acknowledgement links: ACK_SECRET when it is set, otherwise a random
 * key this site generates once and keeps in `instance_secrets` (like the session key setup
 * stores), so escalation works without an extra secret and can never sign with an empty key.
 * With `create: false` (verifying a link) a missing key returns null: no link was ever signed.
 *
 * Setting, changing or clearing ACK_SECRET switches the signing key, so every link already sent
 * stops verifying; so does a reset or a finished setup, which delete the generated key and replace
 * the secret epoch ACK_SECRET is bound to (see auth/epoch.ts).
 */
export async function acknowledgeSecret(deps: { db: Db; getEnv: (name: string) => string | undefined }, create = true): Promise<string | null> {
  const explicit = deps.getEnv('ACK_SECRET')
  if (explicit) return epochKey(deps.db, explicit, 'ack')
  const read = async () => (await deps.db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = ?`, [ACK_KEY_NAME]))?.value || null
  const stored = await read()
  if (stored || !create) return stored
  // Concurrent first uses race on the primary key; everyone then reads the one that won.
  await deps.db.run(`INSERT INTO instance_secrets (name, value, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING`, [ACK_KEY_NAME, randomToken(48), nowSeconds()])
  const created = await read()
  if (!created) throw new Error('could not store the acknowledgement key')
  return created
}

export async function createAcknowledgeToken(incidentId: number, now: number, secret: string): Promise<string> {
  if (!secret) throw new Error('acknowledgement links need a signing key')
  const payload = base64url(JSON.stringify({ i: incidentId, e: now + ACK_LINK_TTL } satisfies Capability))
  return `${payload}.${await hmac(secret, payload)}`
}

export async function verifyAcknowledgeToken(token: string, now: number, secret: string): Promise<number | null> {
  if (!secret) return null
  const [payload, signature, ...extra] = token.split('.')
  if (!payload || !signature || extra.length || !timingSafeEqual(await hmac(secret, payload), signature)) return null
  const decoded = unbase64url(payload)
  if (!decoded) return null
  try {
    const capability = JSON.parse(decoded) as Capability
    return Number.isSafeInteger(capability.i) && capability.i > 0 && Number.isSafeInteger(capability.e) && capability.e >= now ? capability.i : null
  } catch {
    return null
  }
}

/** First acknowledgement wins. The primary key makes concurrent/replayed capability POSTs harmless. */
export async function acknowledgeIncident(db: Db, incidentId: number, by: string, via: 'alert-link' | 'admin-page', now: number): Promise<boolean> {
  const result = await db.run(
    `INSERT INTO acknowledgements (incident_id, by, at, via) VALUES (?, ?, ?, ?) ON CONFLICT (incident_id) DO NOTHING`,
    [incidentId, by, now, via],
  )
  return result.changes === 1
}
