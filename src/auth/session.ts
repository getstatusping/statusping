import { b64urlDecode, b64urlDecodeText, b64urlEncode } from './jwt.ts'

const encoder = new TextEncoder()
const keyCache = new Map<string, Promise<CryptoKey>>()

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret)
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    keyCache.set(secret, key)
  }
  return key
}

/** Signs a JSON payload (must include `exp`, unix seconds) into a cookie-safe string. */
export async function sign(payload: { exp: number } & Record<string, unknown>, secret: string): Promise<string> {
  const body = b64urlEncode(JSON.stringify(payload))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body)))
  return `${body}.${b64urlEncode(sig)}`
}

/** Verifies and decodes a value from `sign`; null if tampered or expired. */
export async function unsign<T extends { exp: number }>(value: string | undefined, secret: string, now: number): Promise<T | null> {
  if (!value) return null
  const [body, sig] = value.split('.')
  if (!body || !sig) return null
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(sig), encoder.encode(body))
    if (!ok) return null
    const payload = JSON.parse(b64urlDecodeText(body)) as T
    return typeof payload.exp === 'number' && payload.exp > now ? payload : null
  } catch {
    return null
  }
}
