import type { PushMonitor } from '../config.ts'
import { expectedAt } from '../schedule.ts'
import type { IncidentReason, MonitorStateRow } from '../state.ts'
import { formatDuration, formatTime } from '../util/time.ts'

export type PushDecision =
  | { kind: 'none' }
  | { kind: 'late'; expectedAt: number }
  | { kind: 'down'; reason: Extract<IncidentReason, 'missed' | 'hung'>; detail: string }

/**
 * Decides whether a push monitor is late or down at `now`, from its stored state.
 * Pure function: no I/O. Push monitors only *recover* through a success ping, never here.
 */
export function evaluatePush(
  monitor: PushMonitor,
  state: MonitorStateRow,
  now: number,
  displayTz: string,
): PushDecision {
  if (state.status === 'paused' || state.status === 'down') return { kind: 'none' }

  if (state.last_start_at !== null && monitor.maxRuntime !== null && now > state.last_start_at + monitor.maxRuntime) {
    return {
      kind: 'down',
      reason: 'hung',
      detail: `The job started but didn't finish within its ${formatDuration(monitor.maxRuntime)} maximum runtime.`,
    }
  }

  const refIsPing = state.last_ping_at !== null && state.last_ping_at >= state.baseline_at
  const reference = refIsPing ? state.last_ping_at! : state.baseline_at
  const expected = expectedAt(monitor, reference, refIsPing)
  if (expected === null) return { kind: 'none' }

  if (now > expected + monitor.grace) {
    // Stored text must not go stale or depend on the viewer's timezone: describe the expectation,
    // not absolute or relative times (the page shows those, localized).
    const grace = monitor.grace ? ` (${formatDuration(monitor.grace)} grace)` : ''
    const expectation = monitor.schedule
      ? `missed its ${formatTime(expected, monitor.tz).slice(11)} run (${monitor.schedule}, ${monitor.tz})`
      : `expected a ping every ${formatDuration(monitor.period ?? 0)}${grace}`
    const never = state.last_ping_at === null ? '; it has never pinged' : ''
    return { kind: 'down', reason: 'missed', detail: `${expectation.charAt(0).toUpperCase()}${expectation.slice(1)}${never}.` }
  }

  if (now > expected && state.status !== 'late') return { kind: 'late', expectedAt: expected }
  return { kind: 'none' }
}
