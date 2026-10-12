import { normalizeClientIp } from '../../src/rate-limit.ts'

/**
 * The client address behind one trusted reverse proxy (STATUSPING_TRUST_PROXY=true). Proxies
 * append the address they saw to X-Forwarded-For, so earlier entries come from the client and
 * can be anything; only the last entry was written by the proxy in front of StatusPing.
 */
export function forwardedClientIp(header: string | null | undefined): string | null {
  if (!header) return null
  const entries = header.split(',')
  return normalizeClientIp(entries[entries.length - 1] ?? null)
}
