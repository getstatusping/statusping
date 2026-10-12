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

const DAY = 86_400
const MAX_OCCURRENCES = 10_000
/** Recurring windows whose runs are closer together than this are refused on save. */
export const MIN_RECURRING_GAP_SECONDS = 3600
/** Runs checked for the minimum gap; enough to cover two full matching days of an hourly schedule. */
const CADENCE_SAMPLE = 50
/**
 * Days whose surroundings (by this margin) keep one UTC offset are expanded with a fixed-offset
 * cron, which is about 40x cheaper than Croner's timezone path. The margin covers the largest
 * daylight-saving shift in use (2h, Antarctica/Troll) plus slack.
 */
const OFFSET_MARGIN = 3 * 3600
const DAY_CACHE_LIMIT = 4096
/** Each Croner instance retains tens of kilobytes, so compiled schedules are kept LRU-bounded. */
export const CRON_CACHE_LIMIT = 1024

/** Thrown when a recurring window expands to more occurrences than one range may hold. */
export class MaintenanceOverflowError extends Error {
  readonly schedule: string
  constructor(schedule: string) {
    super(`maintenance schedule ${JSON.stringify(schedule)} produced more than ${MAX_OCCURRENCES} occurrences`)
    this.name = 'MaintenanceOverflowError'
    this.schedule = schedule
  }
}

/**
 * A cron expression with its whitespace collapsed. Croner reads every whitespace variant the
 * same way, so this is what is stored and what caches are keyed on.
 */
export function normalizeSchedule(schedule: string): string {
  return schedule.trim().split(/\s+/).join(' ')
}

const cronCache = new Map<string, Cron>()

function cachedCron(key: string, make: () => Cron): Cron {
  let cron = cronCache.get(key)
  if (cron) {
    cronCache.delete(key)
  } else {
    cron = make()
    if (cronCache.size >= CRON_CACHE_LIMIT) cronCache.delete(cronCache.keys().next().value!)
  }
  cronCache.set(key, cron)
  return cron
}

/** Entries in the compiled-schedule cache (for tests). */
export function cronCacheSize(): number {
  return cronCache.size
}

/** No callback + paused means Croner is only used for timezone-aware date math. */
function zonedCron(schedule: string, tz: string): Cron {
  const normalized = normalizeSchedule(schedule)
  return cachedCron(`z\u0000${tz}\u0000${normalized}`, () => new Cron(normalized, { timezone: tz, paused: true }))
}

function fixedCron(schedule: string, offsetMinutes: number): Cron {
  const normalized = normalizeSchedule(schedule)
  return cachedCron(`o\u0000${offsetMinutes}\u0000${normalized}`, () => new Cron(normalized, { utcOffset: offsetMinutes, paused: true }))
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>()

/** The zone's UTC offset in whole minutes east of UTC at `second`, or null if it has none. */
function utcOffsetMinutes(tz: string, second: number): number | null {
  let format = zoneFormats.get(tz)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    })
    zoneFormats.set(tz, format)
  }
  const parts: Record<string, number> = {}
  for (const part of format.formatToParts(new Date(second * 1000))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  const local = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) / 1000
  const offset = (local - second) / 60
  return Number.isInteger(offset) ? offset : null
}

const dayCache = new Map<string, readonly number[]>()

/**
 * Run starts of a schedule within one UTC day, `[day * DAY, (day + 1) * DAY)`. A past day's runs
 * never change, so results are kept in a bounded, isolate-wide cache: rendering 90 days of
 * history only expands the days it has not seen yet.
 */
function startsOnDay(schedule: string, tz: string, day: number, budget: number): readonly number[] {
  const key = `${tz}\u0000${normalizeSchedule(schedule)}\u0000${day}`
  const cached = dayCache.get(key)
  if (cached) {
    dayCache.delete(key)
    dayCache.set(key, cached)
    if (cached.length > budget) throw new MaintenanceOverflowError(schedule)
    return cached
  }
  const dayStart = day * DAY
  const dayEnd = dayStart + DAY
  const before = utcOffsetMinutes(tz, dayStart - OFFSET_MARGIN)
  const after = utcOffsetMinutes(tz, dayEnd + OFFSET_MARGIN)
  // A daylight-saving transition near this day goes through Croner's timezone path, which owns
  // the gap and overlap semantics; every other day has a single offset and is exact with it.
  const fixed = before !== null && before === after
  const cron = fixed ? fixedCron(schedule, before) : zonedCron(schedule, tz)
  const starts: number[] = []
  // Croner resolves an ambiguous local time relative to where the search starts, so near a
  // transition start before it, as a continuous enumeration would.
  let cursor = fixed ? dayStart - 1 : dayStart - OFFSET_MARGIN - 1
  while (true) {
    const next = cron.nextRun(new Date(cursor * 1000))
    if (!next) break
    const start = Math.floor(next.getTime() / 1000)
    if (start >= dayEnd) break
    cursor = start
    if (start < dayStart) continue
    starts.push(start)
    if (starts.length > budget) {
      // A day that alone exceeds the cap (a seconds-field schedule) is remembered as such, so
      // later renders skip it without expanding it again.
      if (budget >= MAX_OCCURRENCES) remember(key, starts)
      throw new MaintenanceOverflowError(schedule)
    }
  }
  remember(key, starts)
  return starts
}

function remember(key: string, starts: readonly number[]): void {
  dayCache.set(key, starts)
  if (dayCache.size > DAY_CACHE_LIMIT) dayCache.delete(dayCache.keys().next().value!)
}

/**
 * Why a recurring schedule cannot be saved, or null. Seconds-field expressions and schedules
 * whose consecutive runs are closer than an hour would expand to thousands of occurrences on
 * every status-page render. Already-stored windows are not rejected on load; rendering skips
 * a window that overflows instead.
 */
export function recurringScheduleProblem(schedule: string, tz: string, now = Date.now()): string | null {
  const trimmed = schedule.trim()
  if (!trimmed.startsWith('@') && trimmed.split(/\s+/).length !== 5) {
    return 'must have five fields (minute hour day month weekday); a seconds field is not supported'
  }
  let runs: Date[]
  try {
    runs = new Cron(trimmed, { timezone: tz, paused: true }).nextRuns(CADENCE_SAMPLE, new Date(now))
  } catch {
    return null // syntax is reported separately
  }
  for (let i = 1; i < runs.length; i++) {
    if (runs[i]!.getTime() - runs[i - 1]!.getTime() < MIN_RECURRING_GAP_SECONDS * 1000) {
      return 'runs more often than once an hour; recurring maintenance must be at least an hour apart'
    }
  }
  return null
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
 * One window's occurrences which overlap the half-open interval `[from, to)`, in start order.
 * Throws MaintenanceOverflowError when a recurring window expands past the hard cap.
 */
export function windowOccurrences(window: MaintenanceWindow, from: number, to: number): MaintenanceOccurrence[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return []
  if (window.kind === 'one-off') {
    return window.start < to && window.end > from ? [occurrence(window, window.start, window.end, false)] : []
  }
  // The search starts one duration before `from`, so a recurring occurrence which began before
  // the interval but remains active is included. A run that ends exactly at `from` is not.
  const searchFrom = Math.floor(from - window.duration)
  const result: MaintenanceOccurrence[] = []
  let count = 0
  for (let day = Math.floor(searchFrom / DAY); day * DAY < to; day++) {
    for (const start of startsOnDay(window.schedule, window.tz, day, MAX_OCCURRENCES - count)) {
      if (start < searchFrom) continue
      if (start >= to) break
      count += 1
      const end = start + window.duration
      if (end > from) result.push(occurrence(window, start, end, true))
    }
  }
  return result
}

function byStart(a: MaintenanceOccurrence, b: MaintenanceOccurrence): number {
  return a.start - b.start || a.end - b.end || a.title.localeCompare(b.title)
}

/**
 * Enumerate occurrences which overlap the half-open interval `[from, to)`. A generous hard cap
 * avoids an accidental per-second cron expanding an unbounded range; past it this throws.
 */
export function maintenanceOccurrences(
  windows: readonly MaintenanceWindow[],
  from: number,
  to: number,
  monitorId?: string,
): MaintenanceOccurrence[] {
  const result: MaintenanceOccurrence[] = []
  for (const window of windows) {
    if (appliesTo(window, monitorId)) result.push(...windowOccurrences(window, from, to))
  }
  return result.sort(byStart)
}

const warned = new Set<string>()

/**
 * Like maintenanceOccurrences, but a window which overflows the cap is skipped with a logged
 * warning, so one bad stored schedule never takes a status page or a tick down.
 */
export function maintenanceOccurrencesLenient(
  windows: readonly MaintenanceWindow[],
  from: number,
  to: number,
  monitorId?: string,
): MaintenanceOccurrence[] {
  const result: MaintenanceOccurrence[] = []
  for (const window of windows) {
    if (!appliesTo(window, monitorId)) continue
    try {
      result.push(...windowOccurrences(window, from, to))
    } catch (error) {
      if (!(error instanceof MaintenanceOverflowError)) throw error
      if (warned.size < 100 && !warned.has(error.schedule)) {
        warned.add(error.schedule)
        console.warn(`statusping: skipping maintenance window ${JSON.stringify(window.title)}: ${error.message}`)
      }
    }
  }
  return result.sort(byStart)
}

/** Resolve every maintenance interval active for a monitor at a given second. */
export function activeMaintenance(
  windows: readonly MaintenanceWindow[],
  monitorId: string,
  at: number,
): MaintenanceOccurrence[] {
  return maintenanceOccurrencesLenient(windows, at, at + 1, monitorId)
    .filter((window) => window.start <= at && at < window.end)
}

/** A stored recurring window that breaks the cadence rule enforced on save. */
export interface CadenceViolation { title: string; schedule: string; tz: string; problem: string }

const loggedViolations = new Set<string>()

/**
 * Stored recurring windows that would be refused if saved today (saved before the cadence rule).
 * Status-page history may skip them while ticks still apply them, so the admin is told to fix or
 * remove them. Each is logged once per isolate.
 */
export function cadenceViolations(windows: readonly MaintenanceWindow[], now = Date.now()): CadenceViolation[] {
  const result: CadenceViolation[] = []
  for (const window of windows) {
    if (window.kind !== 'recurring') continue
    const problem = recurringScheduleProblem(window.schedule, window.tz, now)
    if (!problem) continue
    result.push({ title: window.title, schedule: window.schedule, tz: window.tz, problem })
    const key = `${window.tz}\u0000${normalizeSchedule(window.schedule)}`
    if (loggedViolations.size < 100 && !loggedViolations.has(key)) {
      loggedViolations.add(key)
      console.warn(`statusping: maintenance window ${JSON.stringify(window.title)} (${JSON.stringify(window.schedule)}) ${problem}; fix or remove it in the admin configuration`)
    }
  }
  return result
}
