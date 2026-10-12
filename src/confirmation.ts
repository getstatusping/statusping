import type { HttpMonitor, TcpMonitor } from './config.ts'
import type { Db, SqlValue } from './db/types.ts'
import { MAX_CHECK_ERROR, clipText } from './util/text.ts'

/** A result reported by one remote vantage point. `unavailable` never counts toward quorum. */
export interface ConfirmationObservation {
  /** A human-readable, actual location such as a Cloudflare colo. */
  location: string
  /** Whether the target was reachable from this location. */
  ok: boolean
  /** Probe infrastructure failed before it could evaluate the target. */
  unavailable?: boolean
  err?: string | null
}

/** Platform seam: Node tests/watchdogs and Workers Durable Objects implement this. */
export interface ConfirmationProbe {
  confirm(monitor: HttpMonitor | TcpMonitor, regions: number): Promise<ConfirmationObservation[]>
}

export interface ConfirmationOutcome {
  confirmed: boolean
  detail: string
  observations: ConfirmationObservation[]
}

function cleanLocation(value: string, fallback: string): string {
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 80) : fallback
}

/** Compact detail is deliberately suitable for both incident cards and alert bodies. */
export function confirmationDetail(observations: readonly ConfirmationObservation[], quorum: number): string {
  const failed = observations.filter((item) => !item.ok && !item.unavailable).map((item) => item.location)
  const ok = observations.filter((item) => item.ok).map((item) => item.location)
  const unavailable = observations.filter((item) => item.unavailable).map((item) => item.location)
  const parts = [`Regional confirmation: ${failed.length}/${quorum} failed locations required.`]
  if (failed.length) parts.push(`Failed from ${failed.join(', ')}.`)
  if (ok.length) parts.push(`OK from ${ok.join(', ')}.`)
  if (unavailable.length) parts.push(`Unavailable probes: ${unavailable.join(', ')}.`)
  return parts.join(' ')
}

/**
 * Persists every location-specific result even when quorum is not met, so a
 * later UI can explain a suppressed false positive without relying on logs.
 */
export async function confirmFailure(
  db: Db,
  probe: ConfirmationProbe | undefined,
  monitor: HttpMonitor | TcpMonitor,
  tickAt: number,
  primaryLocation: string,
  primaryError: string | null,
  regions: number,
  quorum: number,
): Promise<ConfirmationOutcome> {
  const primary: ConfirmationObservation = { location: cleanLocation(primaryLocation, 'scheduler'), ok: false, err: primaryError }
  let remote: ConfirmationObservation[] = []
  if (!probe) {
    remote = [{ location: 'regional probes', ok: false, unavailable: true, err: 'regional probes are not configured in this runtime' }]
  } else {
    try {
      remote = await probe.confirm(monitor, regions)
    } catch (error) {
      remote = [{ location: 'regional probes', ok: false, unavailable: true, err: error instanceof Error ? error.message : String(error) }]
    }
  }
  // A probe may only count once. This is especially important when a provider
  // returns the same actual colo for two location hints.
  const seen = new Set<string>()
  const observations = [primary, ...remote]
    .map((item, index) => ({
      ...item,
      location: cleanLocation(item.location, index === 0 ? 'scheduler' : 'unknown'),
      // A remote probe's error is as unbounded as the primary's; store a bounded excerpt.
      err: typeof item.err === 'string' ? clipText(item.err, MAX_CHECK_ERROR) : null,
    }))
    .filter((item) => {
      const key = item.location.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  await db.batch(
    observations.map((item) => ({
      sql: `INSERT INTO confirmation_results (monitor_id, tick_at, location, ok, error)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(monitor_id, tick_at, location) DO UPDATE SET ok = excluded.ok, error = excluded.error`,
      params: [monitor.id, tickAt, item.location, item.unavailable ? null : item.ok ? 1 : 0, item.err] as SqlValue[],
    })),
  )
  const failed = observations.filter((item) => !item.ok && !item.unavailable).length
  return { confirmed: failed >= quorum, detail: confirmationDetail(observations, quorum), observations }
}
