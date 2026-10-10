/** Minimal JWT (RS256 / ES256) verification against a JWKS, using WebCrypto only. */

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
const jwksCache = new Map<string, { keys: Jwk[]; expires: number }>()

async function getJwks(url: string, fetchFn: typeof fetch, force: boolean): Promise<Jwk[]> {
  const cached = jwksCache.get(url)
  if (cached && !force && cached.expires > Date.now()) return cached.keys
  const res = await fetchFn(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new JwtError(`JWKS fetch failed: HTTP ${res.status}`)
  const body = (await res.json()) as { keys?: Jwk[] }
  const keys = body.keys ?? []
  jwksCache.set(url, { keys, expires: Date.now() + JWKS_TTL_MS })
  return keys
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
  let jwk = pick(await getJwks(opts.jwksUrl, opts.fetch, false))
  if (!jwk) jwk = pick(await getJwks(opts.jwksUrl, opts.fetch, true)) // key rotation
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
}
