import { activeMonitors, type HttpMonitor } from './config.ts'
import type { Statement } from './db/types.ts'
import type { Deps } from './deps.ts'
import { sha256Hex } from './util/crypto.ts'

/** Fields whose change should restart missed-ping measurement from "now". */
function scheduleKey(configJson: string): string {
  const c = JSON.parse(configJson) as Record<string, unknown>
  return JSON.stringify([c.period, c.schedule, c.tz, c.grace, c.maxRuntime])
}

/** Values that came from the environment are never written to the database. */
function withoutSecrets<T extends Pick<HttpMonitor, 'url' | 'headers' | 'secretUrl' | 'secretHeaders'>>(m: T): T {
  if (!m.secretUrl && !m.secretHeaders?.length) return m
  const headers = Object.fromEntries(Object.entries(m.headers).map(([key, value]) => [key, m.secretHeaders?.includes(key) ? '[secret]' : value]))
  return { ...m, url: m.secretUrl ? '[secret]' : m.url, headers }
}

/**
 * Upserts monitors from the config into the database. Runs on every tick but only writes when
 * the config (or the role / ping tokens) changed. Removed monitors are paused, never deleted.
 */
export async function syncConfig(deps: Deps, now: number): Promise<boolean> {
  const { db, config, role } = deps
  const tokenHashes: Record<string, string> = {}
  for (const m of config.monitors) {
    const token = deps.pingTokens[m.id]
    if (m.kind === 'push' && token) tokenHashes[m.id] = await sha256Hex(token)
  }
  const active = new Set(activeMonitors(config, role).map((m) => m.id))
  const hash = await sha256Hex(JSON.stringify({ v: 1, role, monitors: config.monitors, tokenHashes }))

  const current = await db.first<{ value: string }>(`SELECT value FROM meta WHERE key = 'config_hash'`)
  if (current?.value === hash) return false

  const existing = new Map(
    (await db.all<{ id: string; paused: number; config_json: string; ping_token_hash: string | null }>(`SELECT id, paused, config_json, ping_token_hash FROM monitors`)).map(
      (r) => [r.id, r],
    ),
  )
  const statements: Statement[] = []
  const resolveOpen = (id: string): Statement => ({
    sql: `UPDATE incidents SET resolved_at = ? WHERE monitor_id = ? AND resolved_at IS NULL`,
    params: [now, id],
  })

  for (const m of config.monitors) {
    const isActive = active.has(m.id)
    const { id, kind, name, group, order, ...rest } = m
    const configJson = JSON.stringify(m.kind === 'http' ? withoutSecrets(rest as Omit<HttpMonitor, 'id' | 'kind' | 'name' | 'group' | 'order'>) : rest)
    const prev = existing.get(id)
    statements.push(
      {
        sql: `INSERT INTO monitors (id, kind, name, group_name, sort_order, config_json, ping_token_hash, paused, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, name = excluded.name,
                group_name = excluded.group_name, sort_order = excluded.sort_order,
                -- A token generated in the app (setup or admin rotation) survives config changes;
                -- PING_TOKENS, when it has an entry, still wins. Non-push monitors never keep one.
                config_json = excluded.config_json,
                ping_token_hash = CASE WHEN excluded.kind = 'push' THEN COALESCE(excluded.ping_token_hash, monitors.ping_token_hash) ELSE NULL END,
                paused = excluded.paused`,
        params: [id, kind, name, group, order, configJson, tokenHashes[id] ?? null, isActive ? 0 : 1, now],
      },
      {
        sql: `INSERT INTO monitor_state (monitor_id, status, status_since, baseline_at, version)
              VALUES (?, ?, ?, ?, 0) ON CONFLICT (monitor_id) DO NOTHING`,
        params: [id, isActive ? 'new' : 'paused', now, now],
      },
    )
    if (!prev) continue
    if (prev.paused && isActive) {
      statements.push({
        sql: `UPDATE monitor_state SET status = 'new', status_since = ?, baseline_at = ?, consecutive_fail = 0,
                last_start_at = NULL, down_reason = NULL, version = version + 1 WHERE monitor_id = ?`,
        params: [now, now, id],
      })
    } else if (!prev.paused && !isActive) {
      statements.push(
        {
          sql: `UPDATE monitor_state SET status = 'paused', status_since = ?, down_reason = NULL, version = version + 1
                WHERE monitor_id = ?`,
          params: [now, id],
        },
        resolveOpen(id),
      )
    } else if (isActive && kind === 'push' && scheduleKey(prev.config_json) !== scheduleKey(configJson)) {
      statements.push({
        sql: `UPDATE monitor_state SET baseline_at = ?, version = version + 1 WHERE monitor_id = ?`,
        params: [now, id],
      })
    }
  }

  // While an earlier saved version stands in for a stored configuration that does not load (see
  // loadFallback), a monitor it lacks is paused but keeps its ping URL, so fixing the configuration
  // brings it back as it was. Once a configuration loads again, a deleted monitor's URL is dropped.
  const fallback = Boolean(deps.configFallback)
  for (const [id, prev] of existing) {
    if (config.monitors.some((m) => m.id === id)) continue
    if (prev.paused) {
      if (!fallback && prev.ping_token_hash) statements.push({ sql: `UPDATE monitors SET ping_token_hash = NULL WHERE id = ?`, params: [id] })
      continue
    }
    statements.push(
      { sql: fallback ? `UPDATE monitors SET paused = 1 WHERE id = ?` : `UPDATE monitors SET paused = 1, ping_token_hash = NULL WHERE id = ?`, params: [id] },
      {
        sql: `UPDATE monitor_state SET status = 'paused', status_since = ?, down_reason = NULL, version = version + 1
              WHERE monitor_id = ?`,
        params: [now, id],
      },
      resolveOpen(id),
    )
  }

  statements.push({
    sql: `INSERT INTO meta (key, value) VALUES ('config_hash', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    params: [hash],
  })
  await db.batch(statements)

  const missingTokens = config.monitors.filter((m) => m.kind === 'push' && active.has(m.id) && !tokenHashes[m.id])
  if (missingTokens.length) {
    deps.log('warn', 'push monitors without a ping URL yet (create one in Settings → Monitors, or add them to PING_TOKENS)', {
      monitors: missingTokens.map((m) => m.id),
    })
  }
  deps.log('info', 'config synced', { monitors: config.monitors.length, active: active.size, role })
  return true
}
