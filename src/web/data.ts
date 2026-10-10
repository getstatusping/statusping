import type { Monitor } from '../config.ts'
import type { Deps } from '../deps.ts'
import type { CheckResult } from '../evaluate/http.ts'
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
  /** Currently active non-outage incidents, shown as amber monitor warnings. */
  warnings: IncidentView[]
}

export interface StatusData {
  now: number
  lastTickAt: number | null
  groups: { name: string; monitors: MonitorView[] }[]
  counts: Record<Status, number>
  openIncidents: (IncidentView & { monitorId: string; monitorName: string })[]
  openWarnings: (IncidentView & { monitorId: string; monitorName: string })[]
}

interface MonitorRow {
  id: string
  created_at: number
}

function downSecondsBetween(incidents: IncidentView[], from: number, to: number, now: number): number {
  let total = 0
  for (const i of incidents) {
    if (i.severity !== 'outage') continue
    const start = Math.max(i.startedAt, from)
    const end = Math.min(i.resolvedAt ?? now, to)
    if (end > start) total += end - start
  }
  return total
}

function uptimeBetween(incidents: IncidentView[], createdAt: number, from: number, to: number, now: number) {
  const start = Math.max(from, createdAt)
  const end = Math.min(to, now)
  if (end <= start) return { uptime: null, down: 0 }
  const down = Math.min(end - start, downSecondsBetween(incidents, start, end, now))
  return { uptime: 1 - down / (end - start), down }
}

export async function lastTickAt(deps: Deps): Promise<number | null> {
  const row = await deps.db.first<{ t: number | null }>(`SELECT MAX(tick_at) AS t FROM tick_results`)
  return row?.t ?? null
}

/** Status for the given monitors (a page's monitors), in config order. */
export async function loadStatusData(deps: Deps, now: number, monitorIds?: readonly string[]): Promise<StatusData> {
  const { db, config } = deps
  const since = now - HISTORY_DAYS * DAY
  const [rows, states, incidentRows, tick] = await Promise.all([
    db.all<MonitorRow>(`SELECT id, created_at FROM monitors WHERE paused = 0`),
    db.all<MonitorStateRow>(`SELECT * FROM monitor_state`),
    db.all<{ id: number; monitor_id: string; reason: IncidentReason; severity: 'outage' | 'warning'; detail: string | null; started_at: number; resolved_at: number | null }>(
      `SELECT id, monitor_id, reason, severity, detail, started_at, resolved_at FROM incidents
       WHERE resolved_at IS NULL OR resolved_at >= ? ORDER BY started_at`,
      [since],
    ),
    lastTickAt(deps),
  ])
  const created = new Map(rows.map((r) => [r.id, r.created_at]))
  const stateById = new Map(states.map((s) => [s.monitor_id, s]))
  const incidentsBy = new Map<string, IncidentView[]>()
  for (const r of incidentRows) {
    const list = incidentsBy.get(r.monitor_id) ?? []
    list.push({ id: r.id, reason: r.reason, severity: r.severity, detail: r.detail, startedAt: r.started_at, resolvedAt: r.resolved_at })
    incidentsBy.set(r.monitor_id, list)
  }

  const todayStart = now - (now % DAY)
  const counts: Record<Status, number> = { new: 0, up: 0, late: 0, down: 0, paused: 0 }
  const groups: StatusData['groups'] = []
  const openIncidents: StatusData['openIncidents'] = []
  const openWarnings: StatusData['openWarnings'] = []

  const wanted = monitorIds ? new Set(monitorIds) : null
  for (const monitor of config.monitors) {
    if (wanted && !wanted.has(monitor.id)) continue
    const createdAt = created.get(monitor.id)
    const state = stateById.get(monitor.id)
    if (createdAt === undefined || !state || state.status === 'paused') continue
    const incidents = incidentsBy.get(monitor.id) ?? []
    const bars: DayBar[] = []
    for (let d = HISTORY_DAYS - 1; d >= 0; d--) {
      const from = todayStart - d * DAY
      const { uptime, down } = uptimeBetween(incidents, createdAt, from, from + DAY, now)
      bars.push({
        day: new Date(from * 1000).toISOString().slice(0, 10),
        uptime,
        downSeconds: down,
        outages: down > 0 ? outagesOn(incidents, from, from + DAY, now) : [],
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
      uptime90: uptimeBetween(incidents, createdAt, since, now, now).uptime,
      uptime24h: uptimeBetween(incidents, createdAt, now - DAY, now, now).uptime,
      warnings,
    })
  }
  return { now, lastTickAt: tick, groups, counts, openIncidents, openWarnings }
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
}

export async function loadMonitorDetail(deps: Deps, id: string, now: number): Promise<MonitorDetail | null> {
  const data = await loadStatusData(deps, now, [id])
  const view = data.groups.flatMap((g) => g.monitors).find((m) => m.monitor.id === id)
  if (!view) return null
  const [pings, ticks, incidents] = await Promise.all([
    view.monitor.kind === 'push'
      ? deps.db.all<PingView>(
          `SELECT id, kind, exit_code, duration_ms, body, source_ip, received_at FROM pings
           WHERE monitor_id = ? ORDER BY received_at DESC, id DESC LIMIT 120`,
          [id],
        )
      : Promise.resolve([]),
    view.monitor.kind === 'http'
      ? deps.db.all<{ tick_at: number; results_json: string }>(
          `SELECT tick_at, results_json FROM tick_results WHERE results_json <> '[]' ORDER BY tick_at DESC LIMIT 180`,
        )
      : Promise.resolve([]),
    deps.db.all<{ id: number; reason: IncidentReason; severity: 'outage' | 'warning'; detail: string | null; started_at: number; resolved_at: number | null }>(
      `SELECT id, reason, severity, detail, started_at, resolved_at FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT 20`,
      [id],
    ),
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
  }
}
