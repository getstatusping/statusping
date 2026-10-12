/**
 * A result from an expiry data source. Times are Unix seconds, matching the
 * rest of StatusPing's persisted timestamps.
 *
 * `unavailable` is a definitive "this registry/source does not provide this
 * data" result and may be cached. `unknown` is intentionally transient: the
 * next daily check should try again.
 */
export type ExpiryLookup =
  | { status: 'expiration'; expiresAt: number }
  | { status: 'unavailable'; reason: string }
  | { status: 'unknown'; error: string }

/** A runtime-specific direct certificate lookup (Node uses TLS; Workers use CT). */
/**
 * Reads a host's certificate directly. `address`, when given, is the vetted address to connect
 * to (the private-target guard checked it); the hostname is still used for SNI and verification.
 */
export type CertificateExpiryProvider = (hostname: string, port: number, options?: { address?: string }) => Promise<ExpiryLookup>

/** Dependencies shared by Worker-safe expiry providers. */
export interface ExpiryProviderOptions {
  fetch: typeof fetch
  /** Injectable for deterministic tests. Defaults to the current time. */
  now?: () => number
}

/** Normalizes a DNS hostname without relying on Node's URL or TLS modules. */
export function normalizeHostname(value: string): string | null {
  const hostname = value.trim().toLowerCase().replace(/\.$/, '')
  if (!hostname || hostname.length > 253 || hostname.includes('/') || hostname.includes(':')) return null
  const labels = hostname.split('.')
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null
  return hostname
}

export function toUnixSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}
