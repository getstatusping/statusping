import type { Monitor } from '../config.ts'
import { listAnnouncements, type Announcement } from '../announcements.ts'
import type { Deps } from '../deps.ts'
import type { CheckResult } from '../evaluate/http.ts'
import { activeMaintenance as activeMaintenanceForMonitor, maintenanceOccurrences, type MaintenanceOccurrence } from '../maintenance.ts'
import type { IncidentReason, MonitorStateRow, Status } from '../state.ts'
import { DAY } from '../util/time.ts'

export const HISTORY_DAYS = 90

export interface DayBar {
  day: string
  /** null = no data (monitor didn't exist yet). */
  uptime: number | null
  downSeconds: number
  /** Outages overlapping this day (for the bar's popover). */
  outages: DayOutage[]
  /** Planned maintenance overlapping this day, including healthy maintenance. */
  maintenance: DayMaintenance[]
  /** The sample-weighted response-time mean for this UTC day, when rolled up. */
  avgLatencyMs: number | null
}

/** One closed hourly response-time bucket. A null average represents a genuine gap. */
export interface LatencyHour {
  hour: number
  avgMs: number | null
  p95Ms: number | null
  samples: number
}

export interface DayMaintenance {
  title: string
  start: number
  end: number
  /** Whether this window is excluded from uptime calculations. */
  excludeFromUptime: boolean
}

/** A planned window as it appears on a page, limited to the page's monitors. */
export interface MaintenanceView extends DayMaintenance {
  recurring: boolean
  monitorIds: string[]
  monitorNames: string[]
}

export interface DayOutage {
  monitorName: string | null
  reason: IncidentReason
  detail: string | null
  startedAt: number
  resolvedAt: number | null
}

function outagesOn(incidents: IncidentView[], from: number, to: number, now: number, monitorName: string | null = null): DayOutage[] {
  return incidents
    .filter((i) => i.severity === 'outage' && i.startedAt < to && (i.resolvedAt ?? now) > from)
    .map((i) => ({ monitorName, reason: i.reason, detail: i.detail, startedAt: i.startedAt, resolvedAt: i.resolvedAt }))
}

export interface IncidentView {
  id: number
  reason: IncidentReason
  /** Warnings are informational and never contribute to downtime or monitor state. */
  severity: 'outage' | 'warning'
  detail: string | null
  startedAt: number
  resolvedAt: number | null
}

export interface MonitorView {
  monitor: Monitor
  state: MonitorStateRow
  createdAt: number
  bars: DayBar[]
  uptime90: number | null
  uptime24h: number | null
  /** The last 24 closed UTC hours, oldest first. HTTP monitors only have samples. */
  latency24h: LatencyHour[]
  /** Currently active non-outage incidents, shown as amber monitor warnings. */
  warnings: IncidentView[]
  /** Windows currently affecting this monitor. */
  maintenance: MaintenanceView[]
}

export interface StatusData {
  now: number
  lastTickAt: number | null
  groups: { name: string; monitors: MonitorView[] }[]
  counts: Record<Status, number>
  openIncidents: (IncidentView & { monitorId: string; monitorName: string })[]
  openWarnings: (IncidentView & { monitorId: string; monitorName: string })[]
  /** Windows affecting one or more monitors displayed by this page right now. */
  activeMaintenance: MaintenanceView[]
  /** Future windows beginning in the next week. */
  upcomingMaintenance: MaintenanceView[]
  /** Manually posted incidents visible to this page's monitors. */
  announcements: Announcement[]
}

interface MonitorRow {
  id: string
  created_at: number
}

interface LatencyHourlyRow {
  monitor_id: string
  hour: number
  avg_ms: number
  p95_ms: number
  samples: number
}

interface LatencyDailyRow {
  monitor_id: string
  day: number
  avg_ms: number
  samples: number
}

function mergedSeconds(intervals: readonly { start: number; end: number }[], from: number, to: number): number {
  const clipped = intervals
    .map((interval) => ({ start: Math.max(from, interval.start), end: Math.min(to, interval.end) }))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  let total = 0
  let end = from
  for (const interval of clipped) {
    if (interval.end <= end) continue
    const start = Math.max(interval.start, end)
    total += interval.end - start
    end = interval.end
  }
  return total
}

/** Planned exclusion is intentionally applied to the denominator and outages separately. */
function uptimeBetween(
  incidents: IncidentView[],
  maintenance: readonly MaintenanceOccurrence[],
  createdAt: number,
  from: number,
  to: number,
  now: number,
) {
  const start = Math.max(from, createdAt)
  const end = Math.min(to, now)
  if (end <= start) return { uptime: null, down: 0 }
  const excluded = maintenance.filter((window) => (window.window as { excludeFromUptime?: boolean }).excludeFromUptime !== false)
  const excludedSeconds = mergedSeconds(excluded, start, end)
  const eligible = Math.max(0, end - start - excludedSeconds)
  if (eligible === 0) return { uptime: null, down: 0 }

  // Intersect every outage with the *complement* of the union of excluded windows. Splitting
  // avoids double-counting both overlapping incidents and overlapping maintenance windows.
  const excludedIntervals = excluded
    .map((window) => ({ start: Math.max(start, window.start), end: Math.min(end, window.end) }))
    .filter((window) => window.end > window.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const mergedExcluded: { start: number; end: number }[] = []
  for (const interval of excludedIntervals) {
    const last = mergedExcluded.at(-1)
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end)
    else mergedExcluded.push({ ...interval })
  }
  const outageIntervals: { start: number; end: number }[] = []
  for (const incident of incidents) {
    if (incident.severity !== 'outage') continue
    let cursor = Math.max(start, incident.startedAt)
    const outageEnd = Math.min(end, incident.resolvedAt ?? now)
    if (outageEnd <= cursor) continue
    for (const excludedInterval of mergedExcluded) {
      if (excludedInterval.end <= cursor) continue
      if (excludedInterval.start >= outageEnd) break
      if (excludedInterval.start > cursor) outageIntervals.push({ start: cursor, end: Math.min(outageEnd, excludedInterval.start) })
      cursor = Math.max(cursor, excludedInterval.end)
      if (cursor >= outageEnd) break
    }
    if (cursor < outageEnd) outageIntervals.push({ start: cursor, end: outageEnd })
  }
  const down = mergedSeconds(outageIntervals, start, end)
  return { uptime: 1 - down / eligible, down }
}

function maintenanceForDay(windows: readonly MaintenanceOccurrence[], from: number, to: number): DayMaintenance[] {
  return windows
    .filter((window) => window.start < to && window.end > from)
    .map((window) => ({
      title: window.title,
      start: window.start,
      end: window.end,
      excludeFromUptime: (window.window as { excludeFromUptime?: boolean }).excludeFromUptime !== false,
    }))
}

function pageMaintenance(
  occurrences: readonly MaintenanceOccurrence[],
  monitors: readonly Monitor[],
): MaintenanceView[] {
  const names = new Map(monitors.map((monitor) => [monitor.id, monitor.name]))
  const grouped = new Map<string, { occurrence: MaintenanceOccurrence; ids: Set<string> }>()
  for (const occurrence of occurrences) {
    const key = `${occurrence.start}\u0000${occurrence.end}\u0000${occurrence.title}\u0000${occurrence.recurring ? '1' : '0'}`
    let group = grouped.get(key)
    if (!group) grouped.set(key, (group = { occurrence, ids: new Set() }))
    for (const monitor of monitors) {
      if (occurrence.monitors === '*' || occurrence.monitors.includes(monitor.id)) group.ids.add(monitor.id)
    }
  }
  return [...grouped.values()].filter((group) => group.ids.size > 0).map(({ occurrence, ids }) => {
    const monitorIds = [...ids]
    return {
      title: occurrence.title,
      start: occurrence.start,
      end: occurrence.end,
      recurring: occurrence.recurring,
      excludeFromUptime: (occurrence.window as { excludeFromUptime?: boolean }).excludeFromUptime !== false,
      monitorIds,
      monitorNames: monitorIds.map((id) => names.get(id) ?? id),
    }
  })
}

export async function lastTickAt(deps: Deps): Promise<number | null> {
  const row = await deps.db.first<{ t: number | null }>(`SELECT MAX(tick_at) AS t FROM tick_results`)
  return row?.t ?? null
}

/** Status for the given monitors (a page's monitors), in config order. */
export async function loadStatusData(deps: Deps, now: number, monitorIds?: readonly string[]): Promise<StatusData> {
  const { db, config } = deps
  const since = now - HISTORY_DAYS * DAY
  const wanted = monitorIds ? new Set(monitorIds) : null
  const httpIds = config.monitors
    .filter((monitor): monitor is Extract<Monitor, { kind: 'http' }> => monitor.kind === 'http' && (!wanted || wanted.has(monitor.id)))
    .map((monitor) => monitor.id)
  const hourStart = Math.floor(now / 3600) * 3600 - 24 * 3600
  const todayStart = now - (now % DAY)
  const placeholders = httpIds.map(() => '?').join(', ')
  const latencyHourly = httpIds.length
    ? db.all<LatencyHourlyRow>(
        `SELECT monitor_id, hour, avg_ms, p95_ms, samples FROM latency_hourly
         WHERE monitor_id IN (${placeholders}) AND hour >= ? AND hour < ?`,
        [...httpIds, hourStart, hourStart + 24 * 3600],
      )
    : Promise.resolve([] as LatencyHourlyRow[])
  const latencyDaily = httpIds.length
    ? db.all<LatencyDailyRow>(
        `SELECT monitor_id, day, avg_ms, samples FROM latency_daily
         WHERE monitor_id IN (${placeholders}) AND day >= ? AND day < ?`,
        [...httpIds, todayStart - 90 * DAY, todayStart],
      )
    : Promise.resolve([] as LatencyDailyRow[])
  const [rows, states, incidentRows, tick, hourlyRows, dailyRows, announcements] = await Promise.all([
    db.all<MonitorRow>(`SELECT id, created_at FROM monitors WHERE paused = 0`),
    db.all<MonitorStateRow>(`SELECT * FROM monitor_state`),
    db.all<{ id: number; monitor_id: string; reason: IncidentReason; severity: 'outage' | 'warning'; detail: string | null; started_at: number; resolved_at: number | null }>(
      `SELECT id, monitor_id, reason, severity, detail, started_at, resolved_at FROM incidents
       WHERE resolved_at IS NULL OR resolved_at >= ? ORDER BY started_at`,
      [since],
    ),
    lastTickAt(deps),
    latencyHourly,
    latencyDaily,
    listAnnouncements(db),
  ])
  const created = new Map(rows.map((r) => [r.id, r.created_at]))
  const stateById = new Map(states.map((s) => [s.monitor_id, s]))
  const incidentsBy = new Map<string, IncidentView[]>()
  for (const r of incidentRows) {
    const list = incidentsBy.get(r.monitor_id) ?? []
    list.push({ id: r.id, reason: r.reason, severity: r.severity, detail: r.detail, startedAt: r.started_at, resolvedAt: r.resolved_at })
    incidentsBy.set(r.monitor_id, list)
  }

  const hourlyByMonitor = new Map<string, Map<number, LatencyHourlyRow>>()
  for (const row of hourlyRows) {
    const rows = hourlyByMonitor.get(row.monitor_id) ?? new Map<number, LatencyHourlyRow>()
    rows.set(row.hour, row)
    hourlyByMonitor.set(row.monitor_id, rows)
  }
  const dailyByMonitor = new Map<string, Map<number, LatencyDailyRow>>()
  for (const row of dailyRows) {
    const rows = dailyByMonitor.get(row.monitor_id) ?? new Map<number, LatencyDailyRow>()
    rows.set(row.day, row)
    dailyByMonitor.set(row.monitor_id, rows)
  }
  const counts: Record<Status, number> = { new: 0, up: 0, late: 0, down: 0, paused: 0 }
  const groups: StatusData['groups'] = []
  const openIncidents: StatusData['openIncidents'] = []
  const openWarnings: StatusData['openWarnings'] = []

  for (const monitor of config.monitors) {
    if (wanted && !wanted.has(monitor.id)) continue
    const createdAt = created.get(monitor.id)
    const state = stateById.get(monitor.id)
    if (createdAt === undefined || !state || state.status === 'paused') continue
    const incidents = incidentsBy.get(monitor.id) ?? []
    const historyMaintenance = maintenanceOccurrences(config.maintenance, since, now, monitor.id)
    const currentMaintenance = activeMaintenanceForMonitor(config.maintenance, monitor.id, now)
    const dailyLatency = dailyByMonitor.get(monitor.id)
    const bars: DayBar[] = []
    for (let d = HISTORY_DAYS - 1; d >= 0; d--) {
      const from = todayStart - d * DAY
      const { uptime, down } = uptimeBetween(incidents, historyMaintenance, createdAt, from, from + DAY, now)
      bars.push({
        day: new Date(from * 1000).toISOString().slice(0, 10),
        uptime,
        downSeconds: down,
        outages: down > 0 ? outagesOn(incidents, from, from + DAY, now) : [],
        maintenance: maintenanceForDay(historyMaintenance, from, from + DAY),
        avgLatencyMs: dailyLatency?.get(from)?.avg_ms ?? null,
      })
    }
    counts[state.status]++
    const warnings = incidents.filter((i) => i.severity === 'warning' && i.resolvedAt === null)
    for (const i of incidents) {
      if (i.resolvedAt !== null) continue
      const open = { ...i, monitorId: monitor.id, monitorName: monitor.name }
      if (i.severity === 'warning') openWarnings.push(open)
      else openIncidents.push(open)
    }
    let group = groups.find((g) => g.name === monitor.group)
    if (!group) groups.push((group = { name: monitor.group, monitors: [] }))
    group.monitors.push({
      monitor,
      state,
      createdAt,
      bars,
      uptime90: uptimeBetween(incidents, historyMaintenance, createdAt, since, now, now).uptime,
      uptime24h: uptimeBetween(incidents, historyMaintenance, createdAt, now - DAY, now, now).uptime,
      latency24h: Array.from({ length: 24 }, (_, index) => {
        const hour = hourStart + index * 3600
        const bucket = hourlyByMonitor.get(monitor.id)?.get(hour)
        return { hour, avgMs: bucket?.avg_ms ?? null, p95Ms: bucket?.p95_ms ?? null, samples: bucket?.samples ?? 0 }
      }),
      warnings,
      maintenance: pageMaintenance(currentMaintenance, [monitor]),
    })
  }
  const pageMonitors = groups.flatMap((group) => group.monitors.map((view) => view.monitor))
  const pageWindows = maintenanceOccurrences(config.maintenance, now, now + 7 * DAY)
  const activeMaintenance = pageMaintenance(pageWindows.filter((window) => window.start <= now && window.end > now), pageMonitors)
  const upcomingMaintenance = pageMaintenance(pageWindows.filter((window) => window.start > now), pageMonitors)
  const pageMonitorIds = new Set(pageMonitors.map((monitor) => monitor.id))
  const pageAnnouncements = announcements.filter((announcement) => announcement.monitors.some((id) => pageMonitorIds.has(id)))
  return { now, lastTickAt: tick, groups, counts, openIncidents, openWarnings, activeMaintenance, upcomingMaintenance, announcements: pageAnnouncements }
}

export type RunResult = 'success' | 'failed' | 'running' | 'hung' | 'unfinished' | 'log'

/** One job run: a `/start` paired with its finish signal, or a lone ping. */
export interface RunView {
  /** When the run started (`/start`), or null if the job only pinged at the end. */
  startedAt: number | null
  finishedAt: number | null
  result: RunResult
  exitCode: number | null
  /** Run time; for a run still in progress, the time so far. */
  durationMs: number | null
  log: string | null
}

const MAX_RUNS = 50

/**
 * Pairs pings into runs. `pings` may be in any order. A start followed by another start (with no
 * finish in between) "didn't finish"; the latest open start is "running", or "hung" past maxRuntime.
 */
export function groupRuns(pings: PingView[], now: number, maxRuntime: number | null): RunView[] {
  const asc = [...pings].sort((a, b) => a.received_at - b.received_at || a.id - b.id)
  const runs: RunView[] = []
  let open: RunView | null = null
  const appendLog = (run: RunView, body: string | null) => {
    if (body) run.log = run.log ? `${run.log}\n${body}` : body
  }
  for (const p of asc) {
    if (p.kind === 'start') {
      if (open) open.result = 'unfinished'
      open = { startedAt: p.received_at, finishedAt: null, result: 'running', exitCode: null, durationMs: null, log: null }
      appendLog(open, p.body)
      runs.push(open)
    } else if (p.kind === 'success' || p.kind === 'fail') {
      const result: RunResult = p.kind === 'success' ? 'success' : 'failed'
      if (open) {
        open.finishedAt = p.received_at
        open.result = result
        open.exitCode = p.exit_code
        open.durationMs = p.duration_ms ?? (p.received_at - open.startedAt!) * 1000
        appendLog(open, p.body)
        open = null
      } else {
        runs.push({ startedAt: null, finishedAt: p.received_at, result, exitCode: p.exit_code, durationMs: p.duration_ms, log: p.body })
      }
    } else if (p.kind === 'log') {
      if (open) appendLog(open, p.body)
      else runs.push({ startedAt: null, finishedAt: p.received_at, result: 'log', exitCode: null, durationMs: null, log: p.body })
    }
  }
  if (open && open.startedAt !== null) {
    const elapsed = now - open.startedAt
    open.durationMs = elapsed * 1000
    if (maxRuntime !== null && elapsed > maxRuntime) open.result = 'hung'
  }
  return runs.reverse().slice(0, MAX_RUNS)
}

export interface PingView {
  id: number
  kind: string
  exit_code: number | null
  duration_ms: number | null
  body: string | null
  source_ip: string | null
  received_at: number
}

export interface MonitorDetail {
  view: MonitorView
  lastTickAt: number | null
  pings: PingView[]
  checks: (CheckResult & { at: number })[]
  incidents: IncidentView[]
  announcements: Announcement[]
}

export async function loadMonitorDetail(deps: Deps, id: string, now: number): Promise<MonitorDetail | null> {
  const data = await loadStatusData(deps, now, [id])
  const view = data.groups.flatMap((g) => g.monitors).find((m) => m.monitor.id === id)
  if (!view) return null
  const [pings, ticks, incidents, announcements] = await Promise.all([
    view.monitor.kind === 'push'
      ? deps.db.all<PingView>(
          `SELECT id, kind, exit_code, duration_ms, body, source_ip, received_at FROM pings
           WHERE monitor_id = ? ORDER BY received_at DESC, id DESC LIMIT 120`,
          [id],
        )
      : Promise.resolve([]),
    view.monitor.kind !== 'push'
      ? deps.db.all<{ tick_at: number; results_json: string }>(
          `SELECT tick_at, results_json FROM tick_results WHERE results_json <> '[]' ORDER BY tick_at DESC LIMIT 180`,
        )
      : Promise.resolve([]),
    deps.db.all<{ id: number; reason: IncidentReason; severity: 'outage' | 'warning'; detail: string | null; started_at: number; resolved_at: number | null }>(
      `SELECT id, reason, severity, detail, started_at, resolved_at FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT 20`,
      [id],
    ),
    listAnnouncements(deps.db, { monitorId: id }),
  ])
  const checks: MonitorDetail['checks'] = []
  for (const t of ticks) {
    const r = (JSON.parse(t.results_json) as CheckResult[]).find((c) => c.id === id)
    if (r) checks.push({ ...r, at: t.tick_at })
    if (checks.length >= 120) break
  }
  return {
    view,
    lastTickAt: data.lastTickAt,
    pings,
    checks,
    incidents: incidents.map((r) => ({
      id: r.id,
      reason: r.reason,
      severity: r.severity,
      detail: r.detail,
      startedAt: r.started_at,
      resolvedAt: r.resolved_at,
    })),
    announcements,
  }
}
