import type { Deps } from '../deps.ts'
import type { IncidentReason, MonitorStateRow } from '../state.ts'
import { activeMaintenance } from '../maintenance.ts'
import { formatDuration } from '../util/time.ts'
import { type AlertMessage, createSink } from './sinks.ts'

const MAX_ATTEMPTS = 3
/** Don't start a new attempt for the same notification within this window (in-flight guard). */
const RETRY_AFTER = 50
/** Recovery messages are sent for incidents resolved within this window. */
const RECENT_RESOLVED = 3600

interface IncidentRow {
  id: number
  monitor_id: string
  reason: IncidentReason
  detail: string | null
  started_at: number
  resolved_at: number | null
  severity: 'outage' | 'warning'
}

interface NotificationRow {
  incident_id: number
  event: string
  sink: string
  ok: number
  attempts: number
  sent_at: number | null
}

const TITLES: Record<IncidentReason, string> = {
  missed: 'missed a ping',
  failed: 'reported a failure',
  hung: "started but didn't finish",
  check_failed: 'is down',
  ssl_expiring: 'certificate is expiring',
  domain_expiring: 'domain registration is expiring',
}

/**
 * Link for alerts: the page containing the monitor that shows the most detail (restricted
 * pages usually show errors and logs), falling back to the site root.
 */
export function monitorLink(deps: Deps, monitorId: string): string {
  const candidates = deps.config.pages.filter((p) => p.monitorIds.includes(monitorId))
  const best = candidates.sort((a, b) => b.show.length - a.show.length)[0]
  return best ? `${deps.config.baseUrl}/pages/${best.slug}/m/${encodeURIComponent(monitorId)}` : deps.config.baseUrl
}

export function buildMessage(
  deps: Deps,
  monitorName: string,
  monitorId: string,
  incident: IncidentRow,
  event: 'down' | 'up' | 'renotify' | 'warning',
  now = incident.resolved_at ?? incident.started_at,
): AlertMessage {
  const prefix = deps.role === 'watchdog' ? '[watchdog] ' : ''
  const url = monitorLink(deps, monitorId)
  if (event === 'down') {
    return {
      kind: 'down',
      title: `${prefix}🔴 ${monitorName} ${TITLES[incident.reason]}`,
      body: incident.detail ?? '',
      url,
      priority: 'high',
      monitor: { id: monitorId, name: monitorName },
      incident: {
        reason: incident.reason,
        detail: incident.detail,
        startedAt: incident.started_at,
        resolvedAt: incident.resolved_at,
      },
    }
  }
  if (event === 'warning') {
    return {
      kind: 'warning',
      title: `${prefix}🟠 ${monitorName} ${TITLES[incident.reason]}`,
      body: incident.detail ?? '',
      url,
      priority: 'normal',
      monitor: { id: monitorId, name: monitorName },
      incident: { reason: incident.reason, detail: incident.detail, startedAt: incident.started_at, resolvedAt: incident.resolved_at },
    }
  }
  if (event === 'renotify') {
    return {
      kind: 'renotify',
      title: `${prefix}🔴 ${monitorName} still down after ${formatDuration(now - incident.started_at)}`,
      body: `${TITLES[incident.reason]}${incident.detail ? `: ${incident.detail}` : ''}`,
      url,
      priority: 'high',
      monitor: { id: monitorId, name: monitorName },
      incident: {
        reason: incident.reason,
        detail: incident.detail,
        startedAt: incident.started_at,
        resolvedAt: incident.resolved_at,
      },
    }
  }
  const downFor = formatDuration((incident.resolved_at ?? incident.started_at) - incident.started_at)
  return {
    kind: 'up',
    title: `${prefix}✅ ${monitorName} ${incident.severity === 'warning' ? 'warning resolved' : 'recovered'}`,
    body: `${incident.severity === 'warning' ? 'Resolved' : `Back up after ${downFor}`} (${TITLES[incident.reason]}${incident.detail ? `: ${incident.detail}` : ''})`,
    url,
    priority: 'normal',
    monitor: { id: monitorId, name: monitorName },
    incident: {
      reason: incident.reason,
      detail: incident.detail,
      startedAt: incident.started_at,
      resolvedAt: incident.resolved_at,
    },
  }
}

/**
 * Watchdog only: the primary is considered healthy while its heartbeat monitor is not down
 * and its /healthz monitor (if configured) is not down. While healthy, the watchdog stays
 * silent about everything except the peer monitors themselves.
 */
function primaryHealthy(deps: Deps, states: Map<string, Pick<MonitorStateRow, 'status'>>): boolean {
  const { heartbeatMonitor, healthMonitor } = deps.config.peer
  const isDown = (id: string | null) => (id ? states.get(id)?.status === 'down' : false)
  if (!heartbeatMonitor && !healthMonitor) return false
  return !isDown(heartbeatMonitor) && !isDown(healthMonitor)
}

/**
 * Outbox-style delivery: derives pending notifications from incident state, so a duplicate or
 * concurrent run can never send twice (claimed via a conditional UPDATE), and failures are
 * retried on later ticks up to MAX_ATTEMPTS.
 */
export async function dispatchNotifications(deps: Deps, now: number, onlyMonitorId?: string): Promise<number> {
  const { db, config } = deps
  const since = now - RECENT_RESOLVED
  const filter = onlyMonitorId ? 'AND i.monitor_id = ?' : ''
  const incidentParams = onlyMonitorId ? [since, onlyMonitorId] : [since]
  const incidents = await db.all<IncidentRow>(
    `SELECT i.id, i.monitor_id, i.reason, i.detail, i.started_at, i.resolved_at, i.severity
     FROM incidents i JOIN monitors m ON m.id = i.monitor_id
     WHERE m.paused = 0 AND (i.resolved_at IS NULL OR i.resolved_at >= ?) ${filter}`,
    incidentParams,
  )
  if (incidents.length === 0) return 0

  const existing = await db.all<NotificationRow>(
    `SELECT n.incident_id, n.event, n.sink, n.ok, n.attempts, n.sent_at
     FROM notifications n JOIN incidents i ON i.id = n.incident_id
     WHERE (i.resolved_at IS NULL OR i.resolved_at >= ?) ${filter}`,
    incidentParams,
  )
  const key = (incidentId: number, event: string, sink: string) => `${incidentId}|${event}|${sink}`
  const known = new Map(existing.map((n) => [key(n.incident_id, n.event, n.sink), n]))

  let suppressNonPeer = false
  const peerIds = new Set([config.peer.heartbeatMonitor, config.peer.healthMonitor].filter(Boolean) as string[])
  if (deps.role === 'watchdog') {
    const states = await db.all<{ monitor_id: string; status: MonitorStateRow['status'] }>(
      `SELECT monitor_id, status FROM monitor_state`,
    )
    suppressNonPeer = primaryHealthy(deps, new Map(states.map((s) => [s.monitor_id, s])))
  }

  const monitorsById = new Map(config.monitors.map((m) => [m.id, m]))
  let sent = 0

  for (const incident of incidents) {
    const monitor = monitorsById.get(incident.monitor_id)
    if (!monitor) continue
    if (suppressNonPeer && !peerIds.has(monitor.id)) continue
    // Muting is evaluated at the event time. A recovery that happened during a
    // window must not be delivered later when the scheduler runs after it ends.
    const eventAt = incident.resolved_at ?? now
    if (activeMaintenance(config.maintenance, monitor.id, eventAt).length) continue

    for (const sinkName of monitor.notify) {
      const sinkConfig = config.sinks[sinkName]
      if (!sinkConfig) continue
      // Open incident → "down", then numbered re-notifications. Resolved → "up", but
      // only where the original down alert was delivered.
      let event: string | null
      if (incident.resolved_at === null) {
        const initialEvent = incident.severity === 'warning' ? 'warning' : 'down'
        const down = known.get(key(incident.id, initialEvent, sinkName))
        if (!down?.ok) {
          event = initialEvent
        } else if (incident.severity === 'outage' && monitor.renotifyEvery !== null) {
          const repeats = existing.filter(
            (n) => n.incident_id === incident.id && n.sink === sinkName && n.event.startsWith('renotify:'),
          )
          const successful = repeats.filter((n) => n.ok)
          const lastSent = [down, ...successful].reduce((latest, notification) =>
            Math.max(latest, notification.sent_at ?? 0), 0)
          if (monitor.renotifyMax !== null && successful.length >= monitor.renotifyMax) event = null
          else if (now - lastSent >= monitor.renotifyEvery) event = `renotify:${successful.length + 1}`
          else event = null
        } else {
          event = null
        }
      }
      else if (known.get(key(incident.id, incident.severity === 'warning' ? 'warning' : 'down', sinkName))?.ok) event = 'up'
      else continue

      if (!event) continue

      const prev = known.get(key(incident.id, event, sinkName))
      if (prev && (prev.ok || prev.attempts >= MAX_ATTEMPTS)) continue
      if (prev?.sent_at && now - prev.sent_at < RETRY_AFTER) continue

      const [, claim] = await db.batch([
        {
          sql: `INSERT INTO notifications (incident_id, event, sink, created_at) VALUES (?, ?, ?, ?)
                ON CONFLICT (incident_id, event, sink) DO NOTHING`,
          params: [incident.id, event, sinkName, now],
        },
        {
          sql: `UPDATE notifications SET attempts = attempts + 1, sent_at = ?
                WHERE incident_id = ? AND event = ? AND sink = ? AND ok = 0 AND attempts < ?
                  AND (sent_at IS NULL OR sent_at <= ?)`,
          params: [now, incident.id, event, sinkName, MAX_ATTEMPTS, now - RETRY_AFTER],
        },
      ])
      if (claim?.changes !== 1) continue // someone else is sending it

      const message = buildMessage(deps, monitor.name, monitor.id, incident, event === 'up' ? 'up' : event === 'down' ? 'down' : event === 'warning' ? 'warning' : 'renotify', now)
      try {
        await createSink(sinkName, sinkConfig, deps.getEnv, deps.cloudflareEmail).send(message, deps.fetch)
        await db.run(`UPDATE notifications SET ok = 1, error = NULL WHERE incident_id = ? AND event = ? AND sink = ?`, [
          incident.id,
          event,
          sinkName,
        ])
        sent++
      } catch (e) {
        const error = (e as Error).message ?? String(e)
        deps.log('warn', 'notification failed', { sink: sinkName, monitor: monitor.id, event, error })
        await db.run(`UPDATE notifications SET error = ? WHERE incident_id = ? AND event = ? AND sink = ?`, [
          error.slice(0, 500),
          incident.id,
          event,
          sinkName,
        ])
      }
    }
  }
  return sent
}
