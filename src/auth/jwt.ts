/** Minimal JWT (RS256 / ES256) verification against a JWKS, using WebCrypto only. */
import { OIDC_MAX_RESPONSE_BYTES, readCappedJson } from '../util/capped-body.ts'

const encoder = new TextEncoder()

export function b64urlEncode(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(input: string): Uint8Array<ArrayBuffer> {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export const b64urlDecodeText = (input: string) => new TextDecoder().decode(b64urlDecode(input))

export interface Jwk extends JsonWebKey {
  kid?: string
}

export class JwtError extends Error {}

const JWKS_TTL_MS = 60 * 60 * 1000
/**
 * A token whose key id is not in the cached set may mean the issuer rotated its keys, so the set
 * is fetched again, but at most this often per JWKS URL: anyone can send a token with a made-up
 * `kid`, and without the limit every such request would cost a key fetch.
 */
export const JWKS_REFRESH_INTERVAL_MS = 60 * 1000

interface JwksEntry {
  keys: Jwk[]
  expires: number
  /** When the set was last fetched (or a fetch last started); refreshes wait for the interval. */
  fetchedAt: number
}
const jwksCache = new Map<string, JwksEntry>()
/** One fetch per URL at a time: concurrent requests share it. */
const jwksInFlight = new Map<string, Promise<JwksEntry>>()

function fetchJwks(url: string, fetchFn: typeof fetch): Promise<JwksEntry> {
  const pending = jwksInFlight.get(url)
  if (pending) return pending
  const previous = jwksCache.get(url)
  // A failed fetch still counts against the refresh interval.
  if (previous) previous.fetchedAt = Date.now()
  const run = (async () => {
    try {
      const res = await fetchFn(url, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new JwtError(`JWKS fetch failed: HTTP ${res.status}`)
      const body = (await readCappedJson(res, OIDC_MAX_RESPONSE_BYTES)) as { keys?: Jwk[] }
      const now = Date.now()
      const entry: JwksEntry = { keys: Array.isArray(body.keys) ? body.keys : [], expires: now + JWKS_TTL_MS, fetchedAt: now }
      jwksCache.set(url, entry)
      return entry
    } catch (err) {
      // With nothing cached, remember the failure as an empty, already-expired set: until the
      // refresh interval passes, tokens are refused without another fetch (a cold isolate during
      // an outage would otherwise fetch once per forged token).
      if (!jwksCache.has(url)) jwksCache.set(url, { keys: [], expires: 0, fetchedAt: Date.now() })
      throw err
    }
  })()
  jwksInFlight.set(url, run)
  return run.finally(() => jwksInFlight.delete(url))
}

/** The cached key set, fetched when missing or expired. */
async function getJwks(url: string, fetchFn: typeof fetch): Promise<JwksEntry> {
  const cached = jwksCache.get(url)
  const now = Date.now()
  // An expired set whose refetch just failed stays in use until the next attempt is allowed.
  if (cached && (cached.expires > now || now - cached.fetchedAt < JWKS_REFRESH_INTERVAL_MS)) return cached
  return fetchJwks(url, fetchFn)
}

/**
 * The key set fetched again because a token named a key it lacks (rotation), or null when the
 * last fetch was too recent. Every key id the current set lacks is thereby treated as unknown,
 * without a fetch, until the next refresh is allowed.
 */
async function refreshJwks(url: string, fetchFn: typeof fetch, entry: JwksEntry): Promise<JwksEntry | null> {
  if (Date.now() - entry.fetchedAt < JWKS_REFRESH_INTERVAL_MS) return null
  return fetchJwks(url, fetchFn)
}

const ALGS = {
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' } },
} as const

export interface VerifyOptions {
  jwksUrl: string
  issuer: string
  /** Accepted audience(s); the token's `aud` must contain at least one. */
  audience: string | string[]
  fetch: typeof fetch
  /** Unix seconds. */
  now: number
  leewaySeconds?: number
}

export type JwtClaims = Record<string, unknown> & { iss?: string; aud?: string | string[]; exp?: number; nbf?: number }

export async function verifyJwt(token: string, opts: VerifyOptions): Promise<JwtClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new JwtError('malformed token')
  const [h, p, s] = parts as [string, string, string]
  let header: { alg?: string; kid?: string }
  let claims: JwtClaims
  try {
    header = JSON.parse(b64urlDecodeText(h))
    claims = JSON.parse(b64urlDecodeText(p))
  } catch {
    throw new JwtError('malformed token')
  }
  const alg = header.alg === 'RS256' || header.alg === 'ES256' ? ALGS[header.alg] : null
  if (!alg) throw new JwtError(`unsupported alg ${header.alg}`)

  const pick = (keys: Jwk[]) => keys.find((k) => (header.kid ? k.kid === header.kid : true) && (!k.alg || k.alg === header.alg))
  const entry = await getJwks(opts.jwksUrl, opts.fetch)
  let jwk = pick(entry.keys)
  if (!jwk) {
    // Possibly a key rotation; refreshed at most once per JWKS_REFRESH_INTERVAL_MS.
    const fresh = await refreshJwks(opts.jwksUrl, opts.fetch, entry)
    if (fresh) jwk = pick(fresh.keys)
  }
  if (!jwk) throw new JwtError('signing key not found')

  const { kid: _kid, alg: _alg, use: _use, key_ops: _ops, ...keyData } = jwk as Jwk & { use?: string }
  const key = await crypto.subtle.importKey('jwk', keyData, alg.import, false, ['verify'])
  const valid = await crypto.subtle.verify(alg.verify, key, b64urlDecode(s), encoder.encode(`${h}.${p}`))
  if (!valid) throw new JwtError('bad signature')

  const leeway = opts.leewaySeconds ?? 60
  if (claims.iss !== opts.issuer) throw new JwtError('wrong issuer')
  const accepted = Array.isArray(opts.audience) ? opts.audience : [opts.audience]
  const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : []
  if (!aud.some((a) => accepted.includes(a))) throw new JwtError('wrong audience')
  if (typeof claims.exp !== 'number' || claims.exp < opts.now - leeway) throw new JwtError('token expired')
  if (typeof claims.nbf === 'number' && claims.nbf > opts.now + leeway) throw new JwtError('token not yet valid')
  return claims
}

/** For tests: forget cached JWKS. */
export function clearJwksCache() {
  jwksCache.clear()
  jwksInFlight.clear()
}

/**
 * Whether an ID token says its email address is verified. A missing claim counts as unverified;
 * some providers send the claim as the string "true".
 */
export function emailVerified(claims: Record<string, unknown>): boolean {
  return claims.email_verified === true || claims.email_verified === 'true'
}
