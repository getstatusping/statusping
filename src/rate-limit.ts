import type { Db } from './db/types.ts'

/**
 * Consumes one fixed-window ping allowance. The conditional UPSERT is the
 * decision: SQLite/D1 serializes competing writers, so it cannot overshoot
 * `limit` when several requests for one address arrive together.
 */
export async function consumePingRateLimit(db: Db, ip: string, now: number, limit: number): Promise<boolean> {
  const windowAt = now - (now % 60)
  const result = await db.run(
    `INSERT INTO ping_rate_limits (ip, window_at, count) VALUES (?, ?, 1)
     ON CONFLICT(ip, window_at) DO UPDATE SET count = count + 1 WHERE count < ?`,
    [ip, windowAt, limit],
  )
  return result.changes === 1
}

/** A conservative parser for adapter-provided, literal IPv4/IPv6 addresses. */
export function normalizeClientIp(value: string | null | undefined): string | null {
  if (!value) return null
  const ip = value.trim()
  if (ip.length === 0 || ip.length > 45) return null
  const v4 = ip.split('.')
  if (v4.length === 4 && v4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return v4.map(Number).join('.')
  // Cloudflare supplies a literal IPv6 address. Keep a strict, bounded form
  // here rather than allowing an arbitrary header string into the DB key.
  if (!ip.includes(':') || !/^[0-9a-fA-F:.]+$/.test(ip) || ip.includes(':::')) return null
  const halves = ip.split('::')
  if (halves.length > 2) return null
  const words = (half: string) => half === '' ? [] : half.split(':')
  const left = words(halves[0] ?? '')
  const right = words(halves[1] ?? '')
  const all = [...left, ...right]
  const ipv4 = all.findIndex((part) => part.includes('.'))
  if (ipv4 >= 0 && (ipv4 !== all.length - 1 || !normalizeClientIp(all[ipv4]))) return null
  if (all.some((part, i) => part.includes('.') ? i !== all.length - 1 : !/^[0-9a-fA-F]{1,4}$/.test(part))) return null
  const units = all.reduce((n, part) => n + (part.includes('.') ? 2 : 1), 0)
  if ((halves.length === 1 && units !== 8) || (halves.length === 2 && units >= 8)) return null
  return ip.toLowerCase()
}

/**
 * The bucket for a sign-in-style attempt (password, setup code, reset or recovery token):
 * per client address, or, when the adapter cannot tell addresses apart (Node without
 * STATUSPING_TRUST_PROXY), one bucket shared by every client with a somewhat higher limit.
 * An unknown address is never a reason to skip the limit.
 */
export function attemptBucket(prefix: string, ip: string | null, limit: number, unknownLimit: number): { key: string; limit: number } {
  return ip === null ? { key: `${prefix}:unknown`, limit: unknownLimit } : { key: `${prefix}:${ip}`, limit }
}

/** Consumes one attempt from the client's bucket ({@link attemptBucket}); false when it is used up. */
export async function consumeAttempt(db: Db, prefix: string, ip: string | null, now: number, limit: number, unknownLimit: number): Promise<boolean> {
  const bucket = attemptBucket(prefix, ip, limit, unknownLimit)
  return consumePingRateLimit(db, bucket.key, now, bucket.limit)
}

/**
 * True when `key` has used up `limit` in the current minute, without consuming anything. For
 * limits that count failures only: check first, then {@link consumePingRateLimit} on a failure.
 */
export async function rateLimitExhausted(db: Db, key: string, now: number, limit: number): Promise<boolean> {
  const row = await db.first<{ count: number }>(`SELECT count FROM ping_rate_limits WHERE ip = ? AND window_at = ?`, [key, now - (now % 60)])
  return (row?.count ?? 0) >= limit
}
