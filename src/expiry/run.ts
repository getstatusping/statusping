import type { HttpMonitor } from '../config.ts'
import type { Deps } from '../deps.ts'
import { truncate } from '../state.ts'
import { lookupCertificateExpiry } from './ct.ts'
import { lookupDomainExpiry } from './rdap.ts'
import type { CertificateExpiryProvider, ExpiryLookup } from './types.ts'

type Kind = 'ssl' | 'domain'
interface CheckRow { monitor_id: string; kind: Kind; checked_at: number; error: string | null }

/** Stable daily minute slot; spreads checks without a random value persisted in the DB. */
export function expirySlot(id: string, kind: Kind): number {
  let hash = 2166136261
  for (const char of `${id}:${kind}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return (hash >>> 0) % 1440
}

function warningReason(kind: Kind) { return kind === 'ssl' ? 'ssl_expiring' : 'domain_expiring' }
function description(kind: Kind, expiresAt: number) {
  const date = new Date(expiresAt * 1000).toISOString().slice(0, 10)
  return `${kind === 'ssl' ? 'Certificate' : 'Domain registration'} expires on ${date}`
}

async function saveResult(deps: Deps, monitor: HttpMonitor, kind: Kind, lookup: ExpiryLookup, now: number): Promise<void> {
  const existing = await deps.db.first<{ id: number }>(
    `SELECT id FROM incidents WHERE monitor_id = ? AND reason = ? AND resolved_at IS NULL`, [monitor.id, warningReason(kind)],
  )
  if (lookup.status === 'unknown') {
    await deps.db.run(
      `INSERT INTO expiry_checks (monitor_id, kind, expires_at, checked_at, error) VALUES (?, ?, NULL, ?, ?)
       ON CONFLICT (monitor_id, kind) DO UPDATE SET checked_at = excluded.checked_at, error = excluded.error`,
      [monitor.id, kind, now, truncate(lookup.error, 500)],
    )
    return
  }
  if (lookup.status === 'unavailable') {
    await deps.db.run(
      `INSERT INTO expiry_checks (monitor_id, kind, expires_at, checked_at, error) VALUES (?, ?, NULL, ?, ?)
       ON CONFLICT (monitor_id, kind) DO UPDATE SET checked_at = excluded.checked_at, error = excluded.error`,
      [monitor.id, kind, now, truncate(`Not available: ${lookup.reason}`, 500)],
    )
    if (existing) await deps.db.run(`UPDATE incidents SET resolved_at = ? WHERE id = ?`, [now, existing.id])
    return
  }
  await deps.db.run(
    `INSERT INTO expiry_checks (monitor_id, kind, expires_at, checked_at, error) VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (monitor_id, kind) DO UPDATE SET expires_at = excluded.expires_at, checked_at = excluded.checked_at, error = NULL`,
    [monitor.id, kind, lookup.expiresAt, now],
  )
  const warnDays = kind === 'ssl' ? monitor.sslWarnDays! : monitor.domainWarnDays!
  const secondsLeft = lookup.expiresAt - now
  if (secondsLeft <= Math.max(...warnDays) * 86400) {
    if (!existing) await deps.db.run(
      `INSERT INTO incidents (monitor_id, reason, detail, started_at, severity) VALUES (?, ?, ?, ?, 'warning')`,
      [monitor.id, warningReason(kind), description(kind, lookup.expiresAt), now],
    )
  } else if (existing) {
    await deps.db.run(`UPDATE incidents SET resolved_at = ? WHERE id = ?`, [now, existing.id])
  }
}

/**
 * Connects to the monitored host itself (Node), so the private-target guard applies: a refused
 * host is never probed, and the connection goes to the address the guard checked.
 */
async function probeCertificate(deps: Deps, provider: CertificateExpiryProvider, host: string, port: number): Promise<ExpiryLookup> {
  if (!deps.targetGuard) return provider(host, port)
  let address: string | undefined
  try { [address] = await deps.targetGuard(host) } catch (error) {
    return { status: 'unknown', error: `Certificate not checked: ${(error as Error).message}` }
  }
  return provider(host, port, address ? { address } : undefined)
}

/** Performs at most one due expiry lookup each tick, preserving Worker subrequest headroom. */
export async function runExpiryChecks(deps: Deps, now: number): Promise<number> {
  const minute = Math.floor(now / 60) % 1440
  const dayStart = now - (now % 86400)
  const rows = await deps.db.all<CheckRow>(`SELECT monitor_id, kind, checked_at, error FROM expiry_checks`)
  const previous = new Map(rows.map((row) => [`${row.monitor_id}:${row.kind}`, row]))
  for (const monitor of deps.config.monitors) {
    if (monitor.kind !== 'http') continue
    for (const kind of ['ssl', 'domain'] as const) {
      if (kind === 'ssl' ? !monitor.sslWarnDays : !monitor.domainWarnDays) continue
      const row = previous.get(`${monitor.id}:${kind}`)
      if (row?.error?.startsWith('Not available:')) continue
      if (minute < expirySlot(monitor.id, kind) || (row && row.checked_at >= dayStart)) continue
      const target = new URL(monitor.url)
      const host = target.hostname
      const lookup = kind === 'ssl'
        ? await (deps.certificateExpiry ? probeCertificate(deps, deps.certificateExpiry, host, Number(target.port) || 443) : lookupCertificateExpiry(host, { fetch: deps.fetch }))
        : await lookupDomainExpiry(host, { fetch: deps.fetch })
      await saveResult(deps, monitor, kind, lookup, now)
      return 1
    }
  }
  return 0
}
