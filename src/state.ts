import type { Db, SqlValue, Statement } from './db/types.ts'

export type Status = 'new' | 'up' | 'late' | 'down' | 'paused'
export type IncidentReason = 'missed' | 'failed' | 'hung' | 'check_failed' | 'ssl_expiring' | 'domain_expiring'

export interface MonitorStateRow {
  monitor_id: string
  status: Status
  status_since: number
  baseline_at: number
  down_reason: IncidentReason | null
  last_ping_at: number | null
  last_start_at: number | null
  last_duration_ms: number | null
  consecutive_fail: number
  last_error: string | null
  version: number
}

type Settable = Pick<
  MonitorStateRow,
  'last_ping_at' | 'last_start_at' | 'last_duration_ms' | 'consecutive_fail' | 'last_error'
>

export interface Transition {
  monitorId: string
  /** Version read before deciding; the update only applies if it is still current. */
  fromVersion: number
  /** New status; omit to only update fields. */
  to?: Status
  at: number
  /** Required when `to === 'down'`. */
  reason?: IncidentReason
  detail?: string | null
  /** The outage began inside an active maintenance window. */
  maintenance?: boolean
  set?: Partial<Settable>
  /**
   * Extra statements committed atomically with the transition, and only if it applied.
   * Use `guard` (below) in their WHERE clause.
   */
  extra?: (guard: { sql: string; params: SqlValue[] }) => Statement[]
}

const SETTABLE: (keyof Settable)[] = [
  'last_ping_at',
  'last_start_at',
  'last_duration_ms',
  'consecutive_fail',
  'last_error',
]

/**
 * Applies a state change with optimistic concurrency. Incident bookkeeping happens in the
 * same transaction: entering `down` opens an incident (if none is open); leaving `down`
 * resolves it. Returns false if another writer got there first (caller should re-read).
 */
export async function applyTransition(db: Db, t: Transition): Promise<boolean> {
  const sets: string[] = []
  const params: SqlValue[] = []
  for (const key of SETTABLE) {
    if (t.set && key in t.set) {
      sets.push(`${key} = ?`)
      params.push((t.set[key] ?? null) as SqlValue)
    }
  }
  if (t.to) {
    sets.push(`status_since = CASE WHEN status = ? THEN status_since ELSE ? END`, `status = ?`)
    params.push(t.to, t.at, t.to)
    if (t.to === 'down') {
      sets.push(`down_reason = COALESCE(CASE WHEN status = 'down' THEN down_reason END, ?)`)
      params.push(t.reason ?? 'missed')
    } else {
      sets.push(`down_reason = NULL`)
    }
  }
  sets.push('version = version + 1')

  const newVersion = t.fromVersion + 1
  const guard = {
    sql: `EXISTS (SELECT 1 FROM monitor_state WHERE monitor_id = ? AND version = ?)`,
    params: [t.monitorId, newVersion] as SqlValue[],
  }

  const statements: Statement[] = [
    {
      sql: `UPDATE monitor_state SET ${sets.join(', ')} WHERE monitor_id = ? AND version = ?`,
      params: [...params, t.monitorId, t.fromVersion],
    },
  ]

  if (t.to === 'down') {
    statements.push({
      sql: `INSERT INTO incidents (monitor_id, reason, detail, started_at, maintenance)
            SELECT ?, ?, ?, ?, ?
            WHERE ${guard.sql}
              AND NOT EXISTS (SELECT 1 FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL AND severity = 'outage')`,
      params: [t.monitorId, t.reason ?? 'missed', truncate(t.detail ?? null, 1000), t.at, t.maintenance ? 1 : 0, ...guard.params, t.monitorId],
    })
  } else if (t.to) {
    statements.push({
      sql: `UPDATE incidents SET resolved_at = ?
            WHERE monitor_id = ? AND resolved_at IS NULL AND severity = 'outage' AND ${guard.sql}`,
      params: [t.at, t.monitorId, ...guard.params],
    })
  }

  if (t.extra) statements.push(...t.extra(guard))

  const [first] = await db.batch(statements)
  return first?.changes === 1
}

export function truncate(value: string | null, max: number): string | null {
  if (value === null) return null
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export async function loadStates(db: Db): Promise<Map<string, MonitorStateRow>> {
  const rows = await db.all<MonitorStateRow>(`SELECT * FROM monitor_state`)
  return new Map(rows.map((r) => [r.monitor_id, r]))
}
