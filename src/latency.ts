import type { HttpMonitor } from './config.ts'
import type { Db } from './db/types.ts'
import type { CheckResult } from './evaluate/http.ts'
import { DAY } from './util/time.ts'

const HOUR = 3600
const HOURLY_CURSOR = 'latency_hourly_cursor'
const DAILY_CURSOR = 'latency_daily_cursor'
/** Bound delayed-scheduler recovery while still clearing a short outage in one tick. */
const MAX_HOURLY_BUCKETS_PER_TICK = 6
const MAX_DAILY_BUCKETS_PER_TICK = 1

export interface LatencyHourlyRow {
  monitor_id: string
  hour: number
  avg_ms: number
  p95_ms: number
  samples: number
}

export interface LatencyDailyRow {
  monitor_id: string
  day: number
  avg_ms: number
  samples: number
}

interface TickResultRow {
  tick_at: number
  results_json: string
}

/**
 * The nearest-rank percentile. Keeping this explicit makes low-sample windows
 * predictable: one sample's p95 is that sample, and two samples' p95 is the
 * slower result.
 */
export function p95(samples: readonly number[]): number {
  if (!samples.length) throw new Error('p95 requires at least one sample')
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!
}

function average(samples: readonly number[]): number {
  return samples.reduce((sum, sample) => sum + sample, 0) / samples.length
}

async function readCursor(db: Db, key: string): Promise<number | null> {
  const row = await db.first<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key])
  if (!row) return null
  const value = Number(row.value)
  return Number.isInteger(value) && value >= 0 ? value : null
}

const saveCursor = (key: string, value: number) => ({
  sql: `INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  params: [key, String(value)],
})

/**
 * Rolls closed UTC hours from minute results. A cursor catches up after a
 * scheduler outage, in bounded batches. On first install it starts with only
 * the latest closed hour: this avoids an expensive and potentially incomplete
 * backfill over raw rows that predate the feature.
 */
export async function rollupHourly(db: Db, monitors: readonly HttpMonitor[], now: number): Promise<number> {
  const latestClosedHour = Math.floor(now / HOUR) * HOUR - HOUR
  if (latestClosedHour < 0) return 0
  const cursor = await readCursor(db, HOURLY_CURSOR)
  const start = cursor ?? latestClosedHour
  if (start > latestClosedHour) return 0
  const end = Math.min(start + MAX_HOURLY_BUCKETS_PER_TICK * HOUR, latestClosedHour + HOUR)
  const monitorIds = new Set(monitors.map((monitor) => monitor.id))
  if (monitorIds.size === 0) {
    const statement = saveCursor(HOURLY_CURSOR, end)
    await db.run(statement.sql, statement.params)
    return 0
  }
  const rows = await db.all<TickResultRow>(
    `SELECT tick_at, results_json FROM tick_results WHERE tick_at >= ? AND tick_at < ? ORDER BY tick_at ASC`,
    [start, end],
  )
  const samples = new Map<string, Map<number, number[]>>()
  for (const row of rows) {
    let results: CheckResult[]
    try {
      results = JSON.parse(row.results_json) as CheckResult[]
    } catch {
      continue // Historical rows are best-effort; a malformed result must not break ticks.
    }
    for (const result of results) {
      // A duration means the remote endpoint answered, even if its asserted
      // content or status made the check fail. Timeouts have no latency sample.
      if (!monitorIds.has(result.id) || result.ms === null || !Number.isFinite(result.ms)) continue
      const hour = Math.floor(row.tick_at / HOUR) * HOUR
      const byHour = samples.get(result.id) ?? new Map<number, number[]>()
      const values = byHour.get(hour) ?? []
      values.push(result.ms)
      byHour.set(hour, values)
      samples.set(result.id, byHour)
    }
  }

  const statements = [...samples].flatMap(([monitorId, byHour]) =>
    [...byHour].map(([hour, values]) => ({
      sql: `INSERT INTO latency_hourly (monitor_id, hour, avg_ms, p95_ms, samples)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT (monitor_id, hour) DO NOTHING`,
      params: [monitorId, hour, average(values), p95(values), values.length],
    })),
  )
  const writes = await db.batch([...statements, saveCursor(HOURLY_CURSOR, end)])
  return writes.slice(0, statements.length).reduce((total, result) => total + result.changes, 0)
}

/**
 * Rolls closed UTC days from hourly aggregates. Its mean is weighted by each
 * hour's sample count, not an unweighted mean of hourly means. The hourly
 * cursor prevents a daily bucket from being written before all of its hourly
 * windows have been considered.
 */
export async function rollupDaily(db: Db, now: number): Promise<number> {
  const closedDay = Math.floor(now / DAY) * DAY - DAY
  if (closedDay < 0) return 0
  const cursor = await readCursor(db, DAILY_CURSOR)
  // Do not manufacture a partial historical daily average on a new install.
  if (cursor === null) {
    const statement = saveCursor(DAILY_CURSOR, closedDay + DAY)
    await db.run(statement.sql, statement.params)
    return 0
  }
  if (cursor > closedDay) return 0
  const hourlyCursor = await readCursor(db, HOURLY_CURSOR)
  if (hourlyCursor === null || hourlyCursor < cursor + DAY) return 0
  const end = Math.min(cursor + MAX_DAILY_BUCKETS_PER_TICK * DAY, closedDay + DAY, hourlyCursor)
  const rows = await db.all<LatencyHourlyRow>(
    `SELECT monitor_id, hour, avg_ms, p95_ms, samples FROM latency_hourly WHERE hour >= ? AND hour < ?`,
    [cursor, end],
  )
  const byMonitor = new Map<string, Map<number, { weightedTotal: number; samples: number }>>()
  for (const row of rows) {
    const day = Math.floor(row.hour / DAY) * DAY
    const byDay = byMonitor.get(row.monitor_id) ?? new Map<number, { weightedTotal: number; samples: number }>()
    const current = byDay.get(day) ?? { weightedTotal: 0, samples: 0 }
    current.weightedTotal += row.avg_ms * row.samples
    current.samples += row.samples
    byDay.set(day, current)
    byMonitor.set(row.monitor_id, byDay)
  }
  const statements = [...byMonitor].flatMap(([monitorId, byDay]) =>
    [...byDay]
      .filter(([, values]) => values.samples > 0)
      .map(([day, values]) => ({
        sql: `INSERT INTO latency_daily (monitor_id, day, avg_ms, samples)
              VALUES (?, ?, ?, ?) ON CONFLICT (monitor_id, day) DO NOTHING`,
        params: [monitorId, day, values.weightedTotal / values.samples, values.samples],
      })),
  )
  const writes = await db.batch([...statements, saveCursor(DAILY_CURSOR, end)])
  return writes.slice(0, statements.length).reduce((total, result) => total + result.changes, 0)
}

/**
 * Runs the two rollups after a tick has persisted its check results. Cursors
 * make this safe to call every minute: normal ticks only read the cursor, while
 * a delayed scheduler resumes bounded historical catch-up immediately.
 */
export async function rollupLatency(db: Db, monitors: readonly HttpMonitor[], now: number): Promise<{ hourly: number; daily: number }> {
  const hourly = await rollupHourly(db, monitors, now)
  const daily = await rollupDaily(db, now)
  return { hourly, daily }
}
