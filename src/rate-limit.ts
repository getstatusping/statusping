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
