import { type HttpMonitor, activeMonitors, resolveSecret } from './config.ts'
import type { Deps } from './deps.ts'
import { type CheckResult, USER_AGENT, isDue, runHttpCheck, runPool } from './evaluate/http.ts'
import { evaluatePush } from './evaluate/push.ts'
import { dispatchNotifications } from './notify/dispatch.ts'
import { maybeRunRetention } from './retention.ts'
import { ensureSchema } from './schema.ts'
import { type MonitorStateRow, applyTransition, loadStates } from './state.ts'
import { syncConfig } from './sync.ts'
import { nowSeconds } from './util/time.ts'

export interface TickSummary {
  tickAt: number
  duplicate: boolean
  transitions: number
  checks: number
  skippedChecks: string[]
  notifications: number
}

const HTTP_CONCURRENCY = 5 // Workers allow 6 simultaneous outbound connections.

async function applyHttpResult(deps: Deps, m: HttpMonitor, s: MonitorStateRow, r: CheckResult, now: number) {
  if (r.ok) {
    if (s.status === 'up' && s.consecutive_fail === 0) return false
    return applyTransition(deps.db, {
      monitorId: m.id,
      fromVersion: s.version,
      to: 'up',
      at: now,
      set: { consecutive_fail: 0, last_error: null },
    })
  }
  if (s.status === 'down') return false // already down; save the write
  const fails = s.consecutive_fail + 1
  if (fails > m.retries) {
    return applyTransition(deps.db, {
      monitorId: m.id,
      fromVersion: s.version,
      to: 'down',
      reason: 'check_failed',
      detail: r.err,
      at: now,
      set: { consecutive_fail: fails, last_error: r.err },
    })
  }
  await applyTransition(deps.db, {
    monitorId: m.id,
    fromVersion: s.version,
    at: now,
    set: { consecutive_fail: fails, last_error: r.err },
  })
  return false
}

async function pingPeer(deps: Deps): Promise<void> {
  const { pingUrl } = deps.config.peer
  if (!pingUrl) return
  let url: string | undefined
  try {
    url = resolveSecret(pingUrl, deps.getEnv)
    if (!url) return
    const res = await deps.fetch(url, {
      method: 'POST',
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(5000),
    })
    res.body?.cancel().catch(() => {})
    if (!res.ok) deps.log('warn', 'peer heartbeat rejected', { status: res.status })
  } catch (e) {
    deps.log('warn', 'peer heartbeat failed', { error: (e as Error).message })
  }
}

/**
 * One evaluation cycle. Called every minute by the platform scheduler. Idempotent per minute:
 * a duplicate delivery of the same minute is detected by claiming the `tick_results` row.
 */
export async function tick(deps: Deps, nowMs: number = Date.now()): Promise<TickSummary> {
  const startedMs = Date.now()
  const now = nowSeconds(nowMs)
  const tickAt = now - (now % 60)
  const summary: TickSummary = { tickAt, duplicate: false, transitions: 0, checks: 0, skippedChecks: [], notifications: 0 }

  await ensureSchema(deps.db)
  await syncConfig(deps, now)

  const claim = await deps.db.run(
    `INSERT INTO tick_results (tick_at, results_json) VALUES (?, '[]') ON CONFLICT (tick_at) DO NOTHING`,
    [tickAt],
  )
  if (claim.changes === 0) {
    summary.duplicate = true
    return summary
  }

  const monitors = activeMonitors(deps.config, deps.role)
  const states = await loadStates(deps.db)

  // Push monitors: late / missed / hung.
  for (const m of monitors) {
    if (m.kind !== 'push') continue
    const s = states.get(m.id)
    if (!s) continue
    const decision = evaluatePush(m, s, now, deps.config.timezone)
    if (decision.kind === 'none') continue
    const applied = await applyTransition(deps.db, {
      monitorId: m.id,
      fromVersion: s.version,
      at: now,
      ...(decision.kind === 'late' ? { to: 'late' as const } : { to: 'down' as const, reason: decision.reason, detail: decision.detail }),
    })
    if (applied) summary.transitions++
  }

  // Active HTTP checks.
  const due = monitors.filter(
    (m): m is HttpMonitor => m.kind === 'http' && states.get(m.id)?.status !== 'paused' && isDue(m, tickAt / 60),
  )
  const overCap = due.splice(deps.config.limits.maxChecksPerTick)
  const { results, skipped } = await runPool(due, HTTP_CONCURRENCY, startedMs + deps.config.limits.tickBudgetMs, (m) =>
    runHttpCheck(m, deps.fetch),
  )
  summary.checks = results.length
  summary.skippedChecks = [...overCap, ...skipped].map((m) => m.id)
  if (summary.skippedChecks.length) {
    deps.log('warn', 'checks skipped this tick (cap or time budget)', { monitors: summary.skippedChecks })
  }
  const byId = new Map(due.map((m) => [m.id, m]))
  for (const r of results) {
    const m = byId.get(r.id)!
    const s = states.get(r.id)
    if (s && (await applyHttpResult(deps, m, s, r, now))) summary.transitions++
  }
  if (results.length) {
    await deps.db.run(`UPDATE tick_results SET results_json = ? WHERE tick_at = ?`, [JSON.stringify(results), tickAt])
  }

  await pingPeer(deps)
  summary.notifications = await dispatchNotifications(deps, now)
  await maybeRunRetention(deps, now)
  return summary
}
