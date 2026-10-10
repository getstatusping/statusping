import { Cron } from 'croner'

/** A set of monitor ids affected by a maintenance window, or every monitor. */
export type MaintenanceMonitors = readonly string[] | '*'

interface MaintenanceBase {
  /** Human-readable reason shown on the status page. */
  title: string
  monitors: MaintenanceMonitors
}

/**
 * A one-off, half-open maintenance interval. Times are unix seconds, after
 * configuration has been normalised. A monitor is in maintenance when
 * `start <= now < end`.
 */
export interface OneOffMaintenanceWindow extends MaintenanceBase {
  kind: 'one-off'
  start: number
  end: number
}

/**
 * A recurring maintenance interval. `schedule` is evaluated in `tz`, and
 * `duration` is seconds. Croner owns timezone and daylight-saving conversion
 * so callers never need to convert local calendar times themselves.
 */
export interface RecurringMaintenanceWindow extends MaintenanceBase {
  kind: 'recurring'
  schedule: string
  tz: string
  duration: number
}

/** The normalised form consumed by evaluation, dispatch, and the web layer. */
export type MaintenanceWindow = OneOffMaintenanceWindow | RecurringMaintenanceWindow

/** A concrete, half-open maintenance interval. */
export interface MaintenanceOccurrence {
  title: string
  monitors: MaintenanceMonitors
  start: number
  end: number
  /** True when this occurrence was generated from a cron schedule. */
  recurring: boolean
  window: MaintenanceWindow
}

const cronCache = new Map<string, Cron>()
const MAX_OCCURRENCES = 10_000

function cronFor(schedule: string, tz: string): Cron {
  const key = `${tz}\u0000${schedule}`
  let cron = cronCache.get(key)
  if (!cron) {
    // No callback + paused means Croner is only used for timezone-aware date math.
    cron = new Cron(schedule, { timezone: tz, paused: true })
    cronCache.set(key, cron)
  }
  return cron
}

function appliesTo(window: MaintenanceWindow, monitorId: string | undefined): boolean {
  return monitorId === undefined || window.monitors === '*' || window.monitors.includes(monitorId)
}

function occurrence(window: MaintenanceWindow, start: number, end: number, recurring: boolean): MaintenanceOccurrence {
  return { title: window.title, monitors: window.monitors, start, end, recurring, window }
}

/** True when a monitor is affected by this window's declared scope. */
export function maintenanceAppliesTo(window: MaintenanceWindow, monitorId: string): boolean {
  return appliesTo(window, monitorId)
}

/**
 * Enumerate occurrences which overlap the half-open interval `[from, to)`.
 *
 * The search starts one duration before `from`, so a recurring occurrence
 * which began before the interval but remains active is included. A generous
 * hard cap avoids an accidental per-second cron expanding an unbounded range.
 */
export function maintenanceOccurrences(
  windows: readonly MaintenanceWindow[],
  from: number,
  to: number,
  monitorId?: string,
): MaintenanceOccurrence[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return []

  const result: MaintenanceOccurrence[] = []
  for (const window of windows) {
    if (!appliesTo(window, monitorId)) continue
    if (window.kind === 'one-off') {
      if (window.start < to && window.end > from) result.push(occurrence(window, window.start, window.end, false))
      continue
    }

    // `nextRun` is strictly after its argument. The one-second offset includes
    // a run exactly at `from - duration`, though that boundary is filtered out
    // below when its end equals `from`.
    let cursor = Math.floor(from - window.duration) - 1
    let count = 0
    while (true) {
      const next = cronFor(window.schedule, window.tz).nextRun(new Date(cursor * 1000))
      if (!next) break
      const start = Math.floor(next.getTime() / 1000)
      if (start >= to) break
      const end = start + window.duration
      if (end > from) result.push(occurrence(window, start, end, true))
      cursor = start
      count += 1
      if (count >= MAX_OCCURRENCES) {
        throw new Error(`maintenance schedule ${JSON.stringify(window.schedule)} produced more than ${MAX_OCCURRENCES} occurrences`)
      }
    }
  }
  return result.sort((a, b) => a.start - b.start || a.end - b.end || a.title.localeCompare(b.title))
}

/** Resolve every maintenance interval active for a monitor at a given second. */
export function activeMaintenance(
  windows: readonly MaintenanceWindow[],
  monitorId: string,
  at: number,
): MaintenanceOccurrence[] {
  return maintenanceOccurrences(windows, at, at + 1, monitorId)
    .filter((window) => window.start <= at && at < window.end)
}
