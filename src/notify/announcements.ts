import type { Announcement } from '../announcements.ts'
import type { Deps } from '../deps.ts'
import { createSink, type AlertMessage } from './sinks.ts'

const MAX_ATTEMPTS = 3
const RETRY_AFTER = 50

interface PendingAnnouncementNotification {
  id: number
  announcement_update_id: number
  sink: string
  attempts: number
  sent_at: number | null
  announcement_id: number
  title: string
  impact: string
  status: string
  monitors_json: string
  body: string
}

function monitors(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) && value.every((monitor) => typeof monitor === 'string') ? value : []
  } catch {
    return []
  }
}

function announcementMessage(row: PendingAnnouncementNotification, baseUrl: string): AlertMessage {
  const affected = monitors(row.monitors_json)
  return {
    kind: 'announcement',
    title: `📣 ${row.title}`,
    body: row.body,
    url: baseUrl,
    priority: 'normal',
    announcement: { id: row.announcement_id, status: row.status, impact: row.impact, monitors: affected },
  }
}

/**
 * Queue one outbox record per configured sink.  The update id and sink form the
 * idempotency key, so retries and duplicate after-response tasks cannot send twice.
 */
export async function enqueueAnnouncementNotifications(deps: Deps, announcement: Announcement, now: number): Promise<void> {
  const update = announcement.updates[0]
  if (!update) return
  for (const sink of deps.config.announcements.notify) {
    await deps.db.run(
      `INSERT INTO announcement_notifications (announcement_update_id, sink, created_at) VALUES (?, ?, ?)
       ON CONFLICT(announcement_update_id, sink) DO NOTHING`,
      [update.id, sink, now],
    )
  }
}

/** Durable announcement delivery using the same conditional-claim/retry model as incident alerts. */
export async function dispatchAnnouncementNotifications(deps: Deps, now: number): Promise<number> {
  if (!deps.config.announcements.notify.length) return 0
  const rows = await deps.db.all<PendingAnnouncementNotification>(
    `SELECT n.id, n.announcement_update_id, n.sink, n.attempts, n.sent_at,
            a.id AS announcement_id, a.title, a.impact, a.status, a.monitors_json, u.body
     FROM announcement_notifications n
     JOIN announcement_updates u ON u.id = n.announcement_update_id
     JOIN announcements a ON a.id = u.announcement_id
     WHERE n.ok = 0 AND n.attempts < ?
     ORDER BY n.id LIMIT 100`,
    [MAX_ATTEMPTS],
  )
  let sent = 0
  for (const row of rows) {
    if (row.sent_at && now - row.sent_at < RETRY_AFTER) continue
    const claim = await deps.db.run(
      `UPDATE announcement_notifications SET attempts = attempts + 1, sent_at = ?
       WHERE id = ? AND ok = 0 AND attempts < ? AND (sent_at IS NULL OR sent_at <= ?)`,
      [now, row.id, MAX_ATTEMPTS, now - RETRY_AFTER],
    )
    if (claim.changes !== 1) continue
    const sinkConfig = deps.config.sinks[row.sink]
    if (!sinkConfig) continue
    try {
      await createSink(row.sink, sinkConfig, deps.getEnv, deps.cloudflareEmail).send(announcementMessage(row, deps.config.baseUrl), deps.fetch)
      await deps.db.run('UPDATE announcement_notifications SET ok = 1, error = NULL WHERE id = ?', [row.id])
      sent++
    } catch (error) {
      const message = (error as Error).message ?? String(error)
      deps.log('warn', 'announcement notification failed', { sink: row.sink, announcement: row.announcement_id, error: message })
      await deps.db.run('UPDATE announcement_notifications SET error = ? WHERE id = ?', [message.slice(0, 500), row.id])
    }
  }
  return sent
}
