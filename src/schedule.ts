import { Cron } from 'croner'
import type { PushMonitor } from './config.ts'

const cronCache = new Map<string, Cron>()

function cronFor(schedule: string, tz: string): Cron {
  const key = `${tz}\u0000${schedule}`
  let cron = cronCache.get(key)
  if (!cron) {
    // No callback + paused: croner never sets timers, it's used purely for date math.
    cron = new Cron(schedule, { timezone: tz, paused: true })
    cronCache.set(key, cron)
  }
  return cron
}

/** Next scheduled run strictly after `afterSec`, in unix seconds. */
export function nextCronRun(schedule: string, tz: string, afterSec: number): number | null {
  const next = cronFor(schedule, tz).nextRun(new Date(afterSec * 1000))
  return next ? Math.floor(next.getTime() / 1000) : null
}

/**
 * When the next ping is expected, given the reference time (the last ping, or the baseline
 * when the monitor has never been pinged / was just created or resumed).
 *
 * Cron mode tolerates slightly early pings: a ping a few seconds before 03:00 (clock skew)
 * counts as the 03:00 run instead of making 03:00 look missed.
 */
export function expectedAt(monitor: PushMonitor, referenceSec: number, referenceIsPing = true): number | null {
  if (monitor.period !== null) return referenceSec + monitor.period
  if (!monitor.schedule) return null
  const first = nextCronRun(monitor.schedule, monitor.tz, referenceSec)
  if (first === null) return null
  const second = nextCronRun(monitor.schedule, monitor.tz, first)
  const gap = second !== null ? second - first : 3600
  const tolerance = Math.min(monitor.grace, Math.floor(gap / 4), 300)
  if (referenceIsPing && first - referenceSec <= tolerance) {
    // The reference ping was (slightly) early for `first`; the next expected run is `second`.
    return second
  }
  return first
}
