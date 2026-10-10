import type { Db } from './db/types.ts'
import { timingSafeEqual } from './util/crypto.ts'

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

export async function createAcknowledgeToken(incidentId: number, now: number, secret: string): Promise<string> {
  const payload = base64url(JSON.stringify({ i: incidentId, e: now + ACK_LINK_TTL } satisfies Capability))
  return `${payload}.${await hmac(secret, payload)}`
}

export async function verifyAcknowledgeToken(token: string, now: number, secret: string): Promise<number | null> {
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
