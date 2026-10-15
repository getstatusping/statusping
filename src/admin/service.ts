import type { Runtime, StatusPingConfig } from '../config.ts'
import type { Db, Statement } from '../db/types.ts'
import { createSink, type SinkRuntime } from '../notify/sinks.ts'
import { randomToken, sha256Hex } from '../util/crypto.ts'
import { own } from '../util/own.ts'
import { type AdminConfig, validateAdminConfig } from './security.ts'
import { ChannelCredentialError, channelBindingStatements, channelNameProblems } from './channel-credentials.ts'
import { parseAdminYaml } from './yaml.ts'
import { pruneLocalUsersStatement } from '../auth/local-users.ts'

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
  const [result] = await db.batch([
    {
      sql: `INSERT INTO admin_config (id, config_json, updated_at, updated_by) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      params: [configJson(config), now, actor],
    },
    { sql: `INSERT OR IGNORE INTO config_revisions (id, config_json, yaml, actor, action, at)
            SELECT 1, config_json, NULL, updated_by, 'config.seed', updated_at FROM admin_config WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM config_revisions)` },
  ])
  return result!.changes === 1
}

// ── Revisions ───────────────────────────────────────────────────────────────────────────────

/** How many saved configurations are kept. */
export const KEEP_REVISIONS = 50

export interface RevisionSummary { id: number; actor: string; action: string; at: number }
export interface Revision extends RevisionSummary { config: AdminConfig; yaml: string | null }

/** Thrown when a save was based on a revision that is no longer the newest. */
export class RevisionConflict extends Error {
  readonly current: number
  constructor(current: number) { super('The configuration was changed by someone else since it was loaded.'); this.current = current }
}

/** The newest revision number; 0 when nothing has been saved since revisions were introduced. */
export async function currentRevision(db: Db): Promise<number> {
  return (await db.first<{ id: number | null }>(`SELECT MAX(id) AS id FROM config_revisions`))?.id ?? 0
}

/** Records an existing configuration as revision 1, so the first change made afterwards can be undone. */
export async function ensureBaselineRevision(db: Db): Promise<void> {
  await db.run(`INSERT OR IGNORE INTO config_revisions (id, config_json, yaml, actor, action, at)
    SELECT 1, config_json, NULL, updated_by, 'config.baseline', updated_at FROM admin_config WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM config_revisions)`)
}

/**
 * Statements that store a configuration as a new revision. With `base`, the new revision is
 * exactly base + 1: a concurrent save that got there first makes the primary key collide, which
 * rolls back the whole batch.
 */
export function revisionStatements(config: AdminConfig, actor: string, now: number, opts: { action: string; yaml?: string | null; base?: number }): Statement[] {
  const id = opts.base === undefined ? '(SELECT COALESCE(MAX(id), 0) + 1 FROM config_revisions)' : '?'
  return [
    {
      sql: `INSERT INTO config_revisions (id, config_json, yaml, actor, action, at) VALUES (${id}, ?, ?, ?, ?, ?)`,
      params: [...(opts.base === undefined ? [] : [opts.base + 1]), configJson(config), opts.yaml ?? null, actor, opts.action, now],
    },
    { sql: `DELETE FROM config_revisions WHERE id <= (SELECT MAX(id) FROM config_revisions) - ?`, params: [KEEP_REVISIONS] },
  ]
}

export async function listRevisions(db: Db): Promise<RevisionSummary[]> {
  return db.all<RevisionSummary>(`SELECT id, actor, action, at FROM config_revisions ORDER BY id DESC LIMIT ?`, [KEEP_REVISIONS])
}

export async function loadRevision(db: Db, id: number): Promise<Revision | null> {
  const row = await db.first<{ id: number; actor: string; action: string; at: number; config_json: string; yaml: string | null }>(
    `SELECT id, actor, action, at, config_json, yaml FROM config_revisions WHERE id = ?`, [id],
  )
  const config = row ? parseConfig(row.config_json) : null
  return row && config ? { id: row.id, actor: row.actor, action: row.action, at: row.at, config, yaml: row.yaml } : null
}

/** The YAML text the current configuration was saved from, when it was saved from YAML. */
export async function currentYamlText(db: Db): Promise<string | null> {
  const row = await db.first<{ yaml: string | null; same: number }>(
    `SELECT r.yaml, r.config_json = c.config_json AS same FROM config_revisions r, admin_config c WHERE c.id = 1 ORDER BY r.id DESC LIMIT 1`,
  )
  return row?.yaml && row.same ? row.yaml : null
}

/** Key-order-independent JSON, ignoring the admin flag. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).filter((k) => k !== 'admin').sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v
  return JSON.stringify(sort(value))
}

/** Keeps YAML text only when it describes exactly what is saved (an import may keep the old sign-in method). */
function matchingYaml(yaml: string | null | undefined, config: AdminConfig): string | null {
  if (!yaml) return null
  try { return canonical(parseAdminYaml(yaml)) === canonical(config) ? yaml : null } catch { return null }
}

const isConflict = (error: unknown) => /UNIQUE|PRIMARY KEY|constraint/i.test(error instanceof Error ? error.message : String(error))

export async function loadAdminConfig(db: Db): Promise<StoredAdminConfig | null> {
  const row = await db.first<{ config_json: string; updated_at: number; updated_by: string }>(
    `SELECT config_json, updated_at, updated_by FROM admin_config WHERE id = 1`,
  )
  if (!row) return null
  const config = parseConfig(row.config_json)
  return config ? { config, updatedAt: row.updated_at, updatedBy: row.updated_by } : null
}

/** An audit row as a statement, for writing in the same transaction as the change; values redacted like {@link appendAudit}. */
export function auditStatement(entry: Omit<AuditEntry, 'id'>): Statement {
  return {
    sql: `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, ?, ?, ?, ?, ?)`,
    params: [entry.actor, entry.action, entry.target, entry.before === null ? null : JSON.stringify(redactAdminValue(entry.before)), entry.after === null ? null : JSON.stringify(redactAdminValue(entry.after)), entry.at],
  }
}

export async function appendAudit(db: Db, entry: Omit<AuditEntry, 'id'>): Promise<void> {
  const { sql, params } = auditStatement(entry)
  await db.run(sql, params)
}

export async function listAudit(db: Db, limit = 100): Promise<AuditEntry[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))
  const rows = await db.all<{ id: number; actor: string; action: string; target: string; before_json: string | null; after_json: string | null; at: number }>(
    `SELECT id, actor, action, target, before_json, after_json, at FROM audit_log ORDER BY id DESC LIMIT ?`, [safeLimit],
  )
  const parse = (raw: string | null) => { try { return raw === null ? null : JSON.parse(raw) } catch { return null } }
  return rows.map((row) => ({ id: row.id, actor: row.actor, action: row.action, target: row.target, before: parse(row.before_json), after: parse(row.after_json), at: row.at }))
}

export interface SaveOptions {
  /** The revision the change was made on; a newer one means someone else saved in between. */
  base?: number
  /** The YAML text the change came from, kept so comments and ordering survive. */
  yaml?: string | null
  action?: string
  /** SINK_ credentials entered with this save; they are bound to their channel's destination. */
  entered?: readonly string[]
  /** Whether a name is a real Worker secret / environment variable (unbound), not a stored value. */
  hasRealEnv?: (name: string) => boolean
  /**
   * SINK_ credentials typed in with this save. They are checked as if stored and written in the
   * same batch as the configuration, so a refused or failed save stores nothing.
   */
  secrets?: ReadonlyArray<{ name: string; value: string }>
  /** More statements that must be written in the same transaction as the configuration. */
  extra?: readonly Statement[]
  /** Where the site runs; it sets the check limits a save may use. Default 'workers'. */
  runtime?: Runtime
}

/** Atomically validates, records, and stores an admin-managed config as a new revision. */
export async function saveAdminConfig(
  db: Db,
  value: unknown,
  actor: string,
  now: number,
  getEnv: (name: string) => string | undefined,
  opts: SaveOptions = {},
): Promise<StoredAdminConfig & { revision: number }> {
  // A value entered for a name that is also a real Worker secret / environment variable is not
  // stored: the real one wins, and a stale stored copy would silently take over if the operator
  // later deleted the Worker secret.
  const secrets = (opts.secrets ?? []).filter((s) => !opts.hasRealEnv?.(s.name))
  const pending = new Map(secrets.map((s) => [s.name, s.value]))
  const env = pending.size
    ? (name: string) => (opts.hasRealEnv?.(name) ? getEnv(name) : pending.get(name) ?? getEnv(name))
    : getEnv
  const { config, normalized } = validateAdminConfig(value, env, 'save', opts.runtime)
  if (config.admin !== true) throw new Error('admin: cannot disable admin mode through the admin API')
  const before = await loadAdminConfig(db)
  const nameProblems = channelNameProblems(config, before?.config)
  if (nameProblems.length) throw new ChannelCredentialError(nameProblems)
  const bindings = await channelBindingStatements(db, config, before?.config, { getEnv: env, hasRealEnv: opts.hasRealEnv, entered: opts.entered, pending, now })
  if (opts.base !== undefined) {
    const current = await currentRevision(db)
    if (current !== opts.base) throw new RevisionConflict(current)
  }
  const action = opts.action ?? 'config.save'
  try {
    await db.batch([
      ...secrets.map(({ name, value }) => ({
        sql: `INSERT INTO instance_secrets (name, value, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
        params: [`env:${name}`, value, now],
      })),
      ...secrets.map(({ name }) => ({
        sql: `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, 'setting.store', ?, NULL, NULL, ?)`,
        params: [actor, name, now],
      })),
      ...revisionStatements(config, actor, now, { action, yaml: matchingYaml(opts.yaml, config), base: opts.base }),
      {
        sql: `INSERT INTO admin_config (id, config_json, updated_at, updated_by) VALUES (1, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        params: [configJson(config), now, actor],
      },
      {
        sql: `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, ?, 'config', ?, ?, ?)`,
        // Activity keeps its long-standing config.save, except for whole-file replacements.
        params: [actor, action === 'config.import' || action === 'config.restore' ? action : 'config.save', before ? JSON.stringify(redactAdminValue(before.config)) : null, JSON.stringify(redactAdminValue(config)), now],
      },
      ...bindings,
      ...(opts.extra ?? []),
      // Passwords stored in the site belong to administrators: those of anyone this configuration
      // does not make an administrator (all of them when it does not use email + password) go in
      // the same transaction, whichever path changed the administrators (v0.3.20).
      pruneLocalUsersStatement(normalized.access),
    ])
  } catch (error) {
    if (opts.base !== undefined && isConflict(error)) throw new RevisionConflict(await currentRevision(db))
    throw error
  }
  return { config, updatedAt: now, updatedBy: actor, revision: await currentRevision(db) }
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
  runtime: SinkRuntime = {},
): Promise<void> {
  const sinkConfig = own(config.sinks, name)
  if (!sinkConfig) throw new Error(`unknown sink "${name}"`)
  const sink = createSink(name, sinkConfig, getEnv, runtime)
  await sink.send({
    kind: 'test',
    title: 'StatusPing test alert',
    body: 'This is a test alert requested from StatusPing administration.',
    url: config.baseUrl.replace(/\/+$/, ''),
    priority: 'normal',
  }, fetchFn)
}

