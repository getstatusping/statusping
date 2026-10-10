import type { Deps } from './deps.ts'
import { DAY } from './util/time.ts'

export const RETENTION = {
  tickResults: 7 * DAY,
  pingsMaxAge: 30 * DAY,
  /** Always keep at least this many pings per monitor, regardless of age. */
  pingsKeepMin: 100,
  /** Never keep more than this many pings per monitor (bounds DB size for chatty jobs). */
  pingsKeepMax: 1000,
  notifications: 90 * DAY,
  incidents: 400 * DAY,
  latencyHourly: 7 * DAY,
  latencyDaily: 90 * DAY,
}

/** Prunes old rows once per UTC day, on the first tick after 00:05. */
export async function maybeRunRetention(deps: Deps, now: number): Promise<boolean> {
  if (now % DAY < 300) return false
  const today = new Date(now * 1000).toISOString().slice(0, 10)
  const last = await deps.db.first<{ value: string }>(`SELECT value FROM meta WHERE key = 'retention_day'`)
  if (last?.value === today) return false
  await runRetention(deps, now)
  await deps.db.run(
    `INSERT INTO meta (key, value) VALUES ('retention_day', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [today],
  )
  return true
}

export async function runRetention(deps: Deps, now: number): Promise<void> {
  await deps.db.batch([
    { sql: `DELETE FROM tick_results WHERE tick_at < ?`, params: [now - RETENTION.tickResults] },
    { sql: `DELETE FROM latency_hourly WHERE hour < ?`, params: [now - RETENTION.latencyHourly] },
    { sql: `DELETE FROM latency_daily WHERE day < ?`, params: [now - RETENTION.latencyDaily] },
    {
      sql: `DELETE FROM pings WHERE id IN (
              SELECT id FROM (
                SELECT id, received_at,
                       ROW_NUMBER() OVER (PARTITION BY monitor_id ORDER BY received_at DESC, id DESC) AS rn
                FROM pings
              ) WHERE rn > ? OR (rn > ? AND received_at < ?)
            )`,
      params: [RETENTION.pingsKeepMax, RETENTION.pingsKeepMin, now - RETENTION.pingsMaxAge],
    },
    { sql: `DELETE FROM notifications WHERE created_at < ?`, params: [now - RETENTION.notifications] },
    // Fixed-rate windows are only useful for a few minutes; this bounds cardinality from rotating IPs.
    { sql: `DELETE FROM ping_rate_limits WHERE window_at < ?`, params: [now - 2 * 86_400] },
    {
      sql: `DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?`,
      params: [now - RETENTION.incidents],
    },
  ])
}
