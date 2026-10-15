import { type HttpMonitor, type TcpMonitor, activeMonitors, resolveSecret } from './config.ts'
import { refreshAdminConfig, type Deps } from './deps.ts'
import { type CheckResult, USER_AGENT, isDue, runHttpCheck, runPool } from './evaluate/http.ts'
import { runTcpCheck } from './evaluate/tcp.ts'
import { targetFetch, targetTcpConnect } from './util/private-targets.ts'
import { evaluatePush } from './evaluate/push.ts'
import { runExpiryChecks } from './expiry/run.ts'
import { dispatchNotifications } from './notify/dispatch.ts'
import { dispatchAnnouncementNotifications } from './notify/announcements.ts'
import { dispatchSubscriberOutbox, enqueueIncidentSubscribers } from './subscribers.ts'
import { activeMaintenance } from './maintenance.ts'
import { rollupLatency } from './latency.ts'
import { confirmFailure } from './confirmation.ts'
import { maybeRunRetention } from './retention.ts'
import { ensureSchema } from './schema.ts'
import { type MonitorStateRow, applyTransition, loadStates } from './state.ts'
import { syncConfig } from './sync.ts'
import { nowSeconds } from './util/time.ts'
import { loadSetupState } from './setup/state.ts'
import { MAX_CHECK_ERROR, clipText } from './util/text.ts'

// A scheduled tick has no request host, and a configured baseUrl may be stale (setup is where
// it gets set), so the log names the path rather than guessing the site address.
async function logSetupCode(deps: Deps): Promise<void> {
  const state = await loadSetupState(deps.db)
  if (deps.getEnv('STATUSPING_SETUP_TOKEN')) deps.log('info', 'Setup pending. Open /setup on this site and enter the STATUSPING_SETUP_TOKEN value.')
  else if (state?.code) deps.log('info', `Setup code: ${state.code}. Open /setup on this site to finish setup.`)
}

export interface TickSummary {
  tickAt: number
  duplicate: boolean
  transitions: number
  checks: number
  skippedChecks: string[]
  notifications: number
  /**
   * Phases that failed this tick (logged, then skipped so the rest still ran). 'config' means the
   * stored configuration could not be loaded: checks ran on an earlier saved version, or (with
   * only the sign-in settings loadable) none ran. Non-empty means an unhealthy tick.
   */
  failedPhases: string[]
  /** Hosted tenant suspended by the platform: no checks or alerts ran. */
  suspended?: boolean
}

/**
 * Every check error is bounded here, before anything stores it (`last_error`, incident detail,
 * `tick_results`) or a status page loads it back: an error can quote a target's response (a JSON
 * assertion, a probe's message), and no error source may grow a row without bound.
 */
function boundedResult(r: CheckResult): CheckResult {
  return typeof r.err === 'string' && r.err.length > MAX_CHECK_ERROR ? { ...r, err: clipText(r.err, MAX_CHECK_ERROR) } : r
}

/**
 * Runs one tick phase; a failure is logged, recorded in the summary's failedPhases, and never skips
 * the phases after it.
 */
async function phase<T>(deps: Deps, summary: TickSummary, name: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    deps.log('error', `tick: ${name} failed`, { error: (e as Error)?.message ?? String(e) })
    summary.failedPhases.push(name)
    return fallback
  }
}

async function applyCheckResult(deps: Deps, m: HttpMonitor | TcpMonitor, s: MonitorStateRow, checked: CheckResult, now: number, allowDown = true) {
  const r = boundedResult(checked)
  if (r.ok) {
    if (s.status === 'up' && s.consecutive_fail === 0) return false
    return applyTransition(deps.db, {
      monitorId: m.id,
      fromVersion: s.version,
      to: 'up',
      at: now,
      maintenance: activeMaintenance(deps.config.maintenance, m.id, now).length > 0,
      set: { consecutive_fail: 0, last_error: null },
    })
  }
  if (s.status === 'down') return false // already down; save the write
  const fails = s.consecutive_fail + 1
  if (fails > m.retries && allowDown) {
    return applyTransition(deps.db, {
      monitorId: m.id,
      fromVersion: s.version,
      to: 'down',
      reason: 'check_failed',
      detail: r.err,
      at: now,
      maintenance: activeMaintenance(deps.config.maintenance, m.id, now).length > 0,
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
  const summary: TickSummary = { tickAt, duplicate: false, transitions: 0, checks: 0, skippedChecks: [], notifications: 0, failedPhases: [] }

  await ensureSchema(deps.db)
  await refreshAdminConfig(deps, now)
  if (deps.setupPending) {
    // No checks until setup finishes. The code is the only thing logged, and only now.
    await logSetupCode(deps)
    return summary
  }
  if (deps.configFallback?.revision === null) {
    // No saved configuration loads: only the sign-in settings are in use. Syncing that would pause
    // every monitor, so nothing runs until an administrator fixes the configuration.
    deps.log('error', 'tick: no checks ran because the stored configuration could not be loaded', { problem: deps.configFallback.problem })
    summary.failedPhases.push('config')
    return summary
  }
  if (deps.configFallback) {
    // An earlier saved version is in use (with the stored access rules): checks run, but the tick
    // is reported as failed so the owner and the hosted control plane see that it needs fixing.
    deps.log('error', `tick: the stored configuration could not be loaded; running saved version ${deps.configFallback.revision}`, { problem: deps.configFallback.problem })
    summary.failedPhases.push('config')
  }
  await syncConfig(deps, now)
  if (deps.tenant?.suspended) {
    // Plan 005: a suspended tenant keeps its status page but runs no checks and sends no alerts.
    summary.suspended = true
    return summary
  }

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
      ...(decision.kind === 'late'
        ? { to: 'late' as const }
        : {
            to: 'down' as const,
            reason: decision.reason,
            detail: decision.detail,
            maintenance: activeMaintenance(deps.config.maintenance, m.id, now).length > 0,
          }),
    })
    if (applied) summary.transitions++
  }

  // Active HTTP and TCP checks.
  const due = monitors.filter(
    (m): m is HttpMonitor | TcpMonitor => m.kind !== 'push' && states.get(m.id)?.status !== 'paused' && isDue(m, tickAt / 60),
  )
  const overCap = due.splice(deps.config.limits.maxChecksPerTick)
  const httpFetch = targetFetch(deps)
  const tcpConnect = targetTcpConnect(deps)
  const { results: raw, skipped } = await runPool(due, deps.config.limits.checkConcurrency, startedMs + deps.config.limits.tickBudgetMs, (m) => {
    if (m.kind === 'http') return runHttpCheck(m, httpFetch)
    if (!tcpConnect) return Promise.resolve({ id: m.id, ok: false, ms: null, code: null, err: 'TCP checks are unavailable in this runtime' })
    return runTcpCheck(m, tcpConnect)
  })
  const results = raw.map(boundedResult)
  summary.checks = results.length
  summary.skippedChecks = [...overCap, ...skipped].map((m) => m.id)
  if (summary.skippedChecks.length) {
    deps.log('warn', 'checks skipped this tick (cap or time budget)', { monitors: summary.skippedChecks })
  }
  const byId = new Map(due.map((m) => [m.id, m]))
  let confirmationsRemaining = deps.config.limits.maxConfirmationsPerTick
  for (const r of results) {
    const m = byId.get(r.id)!
    const s = states.get(r.id)
    if (!s) continue
    // Retries remain local and free. Confirmation is only paid for once a failure
    // would otherwise transition this monitor to down.
    if (!r.ok && s.status !== 'down' && m.confirm && s.consecutive_fail + 1 > m.retries) {
      const regions = Math.min(m.confirm.regions, Math.max(0, confirmationsRemaining))
      confirmationsRemaining -= regions
      const outcome = await confirmFailure(
        deps.db,
        regions > 0 ? deps.confirmationProbe : undefined,
        m,
        tickAt,
        deps.location ?? 'scheduler',
        r.err,
        regions,
        m.confirm.quorum,
      )
      const confirmedResult = { ...r, err: `${r.err ?? 'check failed'} — ${outcome.detail}` }
      // An unconfirmed result may update the retry bookkeeping and audit table,
      // but it cannot open an incident or mutate the monitor's visible status.
      if (await applyCheckResult(deps, m, s, confirmedResult, now, outcome.confirmed)) summary.transitions++
      continue
    }
    if (await applyCheckResult(deps, m, s, r, now)) summary.transitions++
  }
  if (results.length) {
    await phase(deps, summary, 'check results', undefined, async () => {
      await deps.db.run(`UPDATE tick_results SET results_json = ? WHERE tick_at = ?`, [JSON.stringify(results), tickAt])
    })
  }

  // From here on each phase is independent: one that throws (a database error, a bad channel)
  // is logged and the rest still run, so a failure can never silently cost the alerts after it.
  await phase(deps, summary, 'latency rollup', undefined, () => rollupLatency(
    deps.db,
    monitors.filter((m): m is HttpMonitor => m.kind === 'http'),
    now,
  ))

  await pingPeer(deps)
  summary.notifications = await phase(deps, summary, 'notifications', 0, () => dispatchNotifications(deps, now))
  summary.notifications += await phase(deps, summary, 'announcement notifications', 0, () => dispatchAnnouncementNotifications(deps, now))
  await phase(deps, summary, 'subscriber enqueue', undefined, () => enqueueIncidentSubscribers(deps, now))
  await phase(deps, summary, 'subscriber delivery', undefined, () => dispatchSubscriberOutbox(deps, now))
  // Expiry lookups call third parties (crt.sh, RDAP) that can be slow, so they run only after this
  // tick's alerts are out. A new expiry warning is notified by the next tick's dispatch.
  await phase(deps, summary, 'expiry checks', undefined, () => runExpiryChecks(deps, now))
  await phase(deps, summary, 'retention', undefined, () => maybeRunRetention(deps, now))
  return summary
}
