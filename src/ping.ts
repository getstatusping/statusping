import type { Deps } from './deps.ts'
import { type MonitorStateRow, type Status, type Transition, applyTransition, truncate } from './state.ts'
import { sha256Hex } from './util/crypto.ts'

export const MAX_PING_BODY = 10_000

export type PingSignal =
  | { kind: 'success'; exitCode: number | null }
  | { kind: 'fail'; exitCode: number | null }
  | { kind: 'start' }
  | { kind: 'log' }

/** Parses the optional path suffix: `/start`, `/fail`, `/log`, `/<exit-code>`. */
export function parseSignal(action: string | undefined): PingSignal | null {
  if (action === undefined || action === '') return { kind: 'success', exitCode: null }
  if (action === 'start') return { kind: 'start' }
  if (action === 'fail') return { kind: 'fail', exitCode: null }
  if (action === 'log') return { kind: 'log' }
  if (/^\d{1,3}$/.test(action)) {
    const code = Number(action)
    if (code > 255) return null
    return code === 0 ? { kind: 'success', exitCode: 0 } : { kind: 'fail', exitCode: code }
  }
  return null
}

export interface PingMeta {
  body: string | null
  ip: string | null
  userAgent: string | null
}

export type PingOutcome =
  | { status: 404 | 400 }
  | { status: 200; monitorId: string; from: Status; to: Status }

type Row = MonitorStateRow & { id: string; kind: string; paused: number }

function failureDetail(exitCode: number | null, body: string | null): string {
  const head = exitCode !== null ? `exit code ${exitCode}` : 'failure signal received'
  const excerpt = body?.trim() ? truncate(body.trim(), 300) : null
  return excerpt ? `${head}: ${excerpt}` : head
}

/** Records a push signal. Retries on concurrent updates (optimistic concurrency). */
export async function handlePing(
  deps: Deps,
  token: string,
  signal: PingSignal,
  meta: PingMeta,
  now: number,
): Promise<PingOutcome> {
  if (token.length < 16 || token.length > 128) return { status: 404 }
  const tokenHash = await sha256Hex(token)
  const body = meta.body ? meta.body.slice(0, MAX_PING_BODY) : null

  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await deps.db.first<Row>(
      `SELECT m.id, m.kind, m.paused, s.*
       FROM monitors m JOIN monitor_state s ON s.monitor_id = m.id
       WHERE m.ping_token_hash = ?`,
      [tokenHash],
    )
    if (!row || row.kind !== 'push' || row.paused) return { status: 404 }

    const durationMs =
      signal.kind === 'success' || signal.kind === 'fail'
        ? row.last_start_at !== null
          ? (now - row.last_start_at) * 1000
          : null
        : null

    const t: Transition = {
      monitorId: row.id,
      fromVersion: row.version,
      at: now,
      extra: (guard) => [
        {
          sql: `INSERT INTO pings (monitor_id, kind, exit_code, duration_ms, body, source_ip, user_agent, received_at)
                SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
          params: [
            row.id,
            signal.kind,
            'exitCode' in signal ? signal.exitCode : null,
            durationMs,
            body,
            meta.ip,
            meta.userAgent ? meta.userAgent.slice(0, 200) : null,
            now,
            ...guard.params,
          ],
        },
      ],
    }

    let to: Status = row.status
    switch (signal.kind) {
      case 'start':
        t.set = { last_start_at: now }
        break
      case 'log':
        break
      case 'success':
        to = 'up'
        t.to = 'up'
        t.set = { last_ping_at: now, last_start_at: null, ...(durationMs !== null ? { last_duration_ms: durationMs } : {}) }
        break
      case 'fail':
        to = 'down'
        t.to = 'down'
        t.reason = 'failed'
        t.detail = failureDetail(signal.exitCode, body)
        t.set = { last_ping_at: now, last_start_at: null, ...(durationMs !== null ? { last_duration_ms: durationMs } : {}) }
        break
    }

    if (await applyTransition(deps.db, t)) {
      return { status: 200, monitorId: row.id, from: row.status, to }
    }
  }
  throw new Error('ping: too much write contention, giving up')
}
