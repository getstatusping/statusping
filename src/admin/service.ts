import type { StatusPingConfig } from '../config.ts'
import type { Db } from '../db/types.ts'
import { createSink, type CloudflareEmailSender } from '../notify/sinks.ts'
import { randomToken, sha256Hex } from '../util/crypto.ts'
import { type AdminConfig, validateAdminConfig } from './security.ts'

export interface StoredAdminConfig {
  config: AdminConfig
  updatedAt: number
  updatedBy: string
}

export interface AuditEntry {
  id: number
  actor: string
  action: string
  target: string
  before: unknown | null
  after: unknown | null
  at: number
}

const redactKey = /(?:token|secret|password|credential|authorization|cookie|api[-_]?key)/i

/** Returns a presentation-safe copy: env names remain visible; values never do. */
export function redactAdminValue(value: unknown, key = ''): unknown {
  if (key && redactKey.test(key)) return '[environment reference]'
  if (Array.isArray(value)) return value.map((item) => redactAdminValue(item))
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.$env === 'string') return { $env: obj.$env, set: false }
    return Object.fromEntries(Object.entries(obj).map(([name, item]) => [name, redactAdminValue(item, name)]))
  }
  return value
}

function configJson(config: AdminConfig): string {
  return JSON.stringify(config)
}

function parseConfig(json: string): AdminConfig | null {
  try {
    const value = JSON.parse(json)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as AdminConfig : null
  } catch { return null }
}

/** Seeds the DB once; a caller must only use this when admin mode is enabled. */
export async function seedAdminConfig(db: Db, config: AdminConfig, actor: string, now: number): Promise<boolean> {
  const result = await db.run(
    `INSERT INTO admin_config (id, config_json, updated_at, updated_by) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    [configJson(config), now, actor],
  )
  return result.changes === 1
}

export async function loadAdminConfig(db: Db): Promise<StoredAdminConfig | null> {
  const row = await db.first<{ config_json: string; updated_at: number; updated_by: string }>(
    `SELECT config_json, updated_at, updated_by FROM admin_config WHERE id = 1`,
  )
  if (!row) return null
  const config = parseConfig(row.config_json)
  return config ? { config, updatedAt: row.updated_at, updatedBy: row.updated_by } : null
}

export async function appendAudit(db: Db, entry: Omit<AuditEntry, 'id'>): Promise<void> {
  await db.run(
    `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, ?, ?, ?, ?, ?)`,
    [entry.actor, entry.action, entry.target, entry.before === null ? null : JSON.stringify(redactAdminValue(entry.before)), entry.after === null ? null : JSON.stringify(redactAdminValue(entry.after)), entry.at],
  )
}

export async function listAudit(db: Db, limit = 100): Promise<AuditEntry[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))
  const rows = await db.all<{ id: number; actor: string; action: string; target: string; before_json: string | null; after_json: string | null; at: number }>(
    `SELECT id, actor, action, target, before_json, after_json, at FROM audit_log ORDER BY id DESC LIMIT ?`, [safeLimit],
  )
  const parse = (raw: string | null) => { try { return raw === null ? null : JSON.parse(raw) } catch { return null } }
  return rows.map((row) => ({ id: row.id, actor: row.actor, action: row.action, target: row.target, before: parse(row.before_json), after: parse(row.after_json), at: row.at }))
}

/** Atomically validates, records, and stores an admin-managed config. */
export async function saveAdminConfig(
  db: Db,
  value: unknown,
  actor: string,
  now: number,
  getEnv: (name: string) => string | undefined,
): Promise<StoredAdminConfig> {
  const { config } = validateAdminConfig(value, getEnv)
  if (config.admin !== true) throw new Error('admin: cannot disable admin mode through the admin API')
  const before = await loadAdminConfig(db)
  await db.batch([
    {
      sql: `INSERT INTO admin_config (id, config_json, updated_at, updated_by) VALUES (1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      params: [configJson(config), now, actor],
    },
    {
      sql: `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, 'config.save', 'config', ?, ?, ?)`,
      params: [actor, before ? JSON.stringify(redactAdminValue(before.config)) : null, JSON.stringify(redactAdminValue(config)), now],
    },
  ])
  return { config, updatedAt: now, updatedBy: actor }
}

/** Creates an unpredictable ping token and replaces the hash atomically. Plaintext is returned once. */
export async function rotatePingToken(db: Db, monitorId: string, actor: string, now: number): Promise<string | null> {
  const monitor = await db.first<{ id: string; kind: string }>(`SELECT id, kind FROM monitors WHERE id = ?`, [monitorId])
  if (!monitor || monitor.kind !== 'push') return null
  const token = randomToken(40)
  const hash = await sha256Hex(token)
  await db.batch([
    { sql: `UPDATE monitors SET ping_token_hash = ? WHERE id = ?`, params: [hash, monitorId] },
    { sql: `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, 'ping-token.rotate', ?, NULL, NULL, ?)`, params: [actor, `monitor:${monitorId}`, now] },
  ])
  return token
}

/** Produces a config-as-code seed without leaking values into audit/UI responses. */
export function seedConfig(config: StatusPingConfig): AdminConfig {
  return { ...config, admin: true }
}

/** Sends exactly one explicitly requested test notification; it is never queued or retried. */
export async function sendSinkTest(
  name: string,
  config: AdminConfig,
  getEnv: (name: string) => string | undefined,
  fetchFn: typeof fetch,
  cloudflareEmail?: CloudflareEmailSender,
): Promise<void> {
  const sinkConfig = config.sinks?.[name]
  if (!sinkConfig) throw new Error(`unknown sink "${name}"`)
  const sink = createSink(name, sinkConfig, getEnv, cloudflareEmail)
  await sink.send({
    kind: 'test',
    title: 'StatusPing test alert',
    body: 'This is a test alert requested from StatusPing administration.',
    url: config.baseUrl.replace(/\/+$/, ''),
    priority: 'normal',
  }, fetchFn)
}

