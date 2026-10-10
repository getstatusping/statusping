import { errorMessage, normalizeHostname, toUnixSeconds, type ExpiryLookup, type ExpiryProviderOptions } from './types.ts'

const CRT_SH_URL = 'https://crt.sh/'

interface CrtShCertificate {
  not_after?: unknown
}

/**
 * Finds the furthest still-valid certificate expiry reported by crt.sh.
 *
 * Certificate Transparency is an issuance view rather than a direct TLS
 * connection, making this safe to run in a Cloudflare Worker. It deliberately
 * treats an empty or malformed response as unknown rather than an expiry
 * warning: crt.sh is an advisory, community-operated source.
 */
export async function lookupCertificateExpiry(hostname: string, options: ExpiryProviderOptions): Promise<ExpiryLookup> {
  const host = normalizeHostname(hostname)
  if (!host) return { status: 'unavailable', reason: 'invalid hostname' }

  let response: Response
  try {
    response = await options.fetch(`${CRT_SH_URL}?q=${encodeURIComponent(host)}&output=json`, {
      headers: { accept: 'application/json' },
    })
  } catch (error) {
    return { status: 'unknown', error: `crt.sh request failed: ${errorMessage(error)}` }
  }
  if (!response.ok) return { status: 'unknown', error: `crt.sh returned HTTP ${response.status}` }

  let records: unknown
  try {
    records = await response.json()
  } catch (error) {
    return { status: 'unknown', error: `crt.sh returned invalid JSON: ${errorMessage(error)}` }
  }
  if (!Array.isArray(records)) return { status: 'unknown', error: 'crt.sh returned an unexpected response' }

  const now = Math.floor((options.now?.() ?? Date.now()) / 1000)
  let furthest: number | null = null
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    const expiry = toUnixSeconds((record as CrtShCertificate).not_after)
    // Old CT entries must not create a warning for an already-replaced cert.
    if (expiry === null || expiry <= now) continue
    if (furthest === null || expiry > furthest) furthest = expiry
  }
  return furthest === null
    ? { status: 'unknown', error: 'crt.sh returned no currently valid certificate expiry' }
    : { status: 'expiration', expiresAt: furthest }
}
