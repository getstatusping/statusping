import type { Db } from './db/types.ts'

/**
 * Ordered migrations. Each entry is a list of single statements (D1's exec() splits on
 * newlines, so we never rely on multi-statement strings). Append only; never edit.
 */
export const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS monitors (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      name            TEXT NOT NULL,
      group_name      TEXT,
      sort_order      INTEGER NOT NULL DEFAULT 0,
      config_json     TEXT NOT NULL,
      ping_token_hash TEXT UNIQUE,
      paused          INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS monitor_state (
      monitor_id       TEXT PRIMARY KEY,
      status           TEXT NOT NULL,
      status_since     INTEGER NOT NULL,
      baseline_at      INTEGER NOT NULL,
      down_reason      TEXT,
      last_ping_at     INTEGER,
      last_start_at    INTEGER,
      last_duration_ms INTEGER,
      consecutive_fail INTEGER NOT NULL DEFAULT 0,
      last_error       TEXT,
      version          INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS pings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id  TEXT NOT NULL,
      kind        TEXT NOT NULL,
      exit_code   INTEGER,
      duration_ms INTEGER,
      body        TEXT,
      source_ip   TEXT,
      user_agent  TEXT,
      received_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS pings_monitor_time ON pings(monitor_id, received_at)`,
    `CREATE TABLE IF NOT EXISTS tick_results (
      tick_at      INTEGER PRIMARY KEY,
      results_json TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS incidents (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id  TEXT NOT NULL,
      reason      TEXT NOT NULL,
      detail      TEXT,
      started_at  INTEGER NOT NULL,
      resolved_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS incidents_monitor ON incidents(monitor_id, started_at)`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL,
      event       TEXT NOT NULL,
      sink        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      sent_at     INTEGER,
      ok          INTEGER NOT NULL DEFAULT 0,
      attempts    INTEGER NOT NULL DEFAULT 0,
      error       TEXT,
      UNIQUE (incident_id, event, sink)
    )`,
  ],
  [
    `ALTER TABLE incidents ADD COLUMN severity TEXT NOT NULL DEFAULT 'outage' CHECK (severity IN ('outage', 'warning'))`,
    `CREATE TABLE IF NOT EXISTS expiry_checks (
      monitor_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('ssl', 'domain')),
      expires_at INTEGER,
      checked_at INTEGER NOT NULL,
      error TEXT,
      PRIMARY KEY (monitor_id, kind)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS incidents_one_open_per_reason
      ON incidents(monitor_id, reason) WHERE resolved_at IS NULL`,
  ],
  [
    `ALTER TABLE incidents ADD COLUMN maintenance INTEGER NOT NULL DEFAULT 0`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS latency_hourly (
      monitor_id TEXT NOT NULL,
      hour       INTEGER NOT NULL,
      avg_ms     REAL NOT NULL,
      p95_ms     INTEGER NOT NULL,
      samples    INTEGER NOT NULL,
      PRIMARY KEY (monitor_id, hour)
    )`,
    `CREATE INDEX IF NOT EXISTS latency_hourly_hour ON latency_hourly(hour)`,
    `CREATE TABLE IF NOT EXISTS latency_daily (
      monitor_id TEXT NOT NULL,
      day        INTEGER NOT NULL,
      avg_ms     REAL NOT NULL,
      samples    INTEGER NOT NULL,
      PRIMARY KEY (monitor_id, day)
    )`,
    `CREATE INDEX IF NOT EXISTS latency_daily_day ON latency_daily(day)`,
  ],
]

export const SCHEMA_VERSION = MIGRATIONS.length

async function currentVersion(db: Db): Promise<number> {
  try {
    const row = await db.first<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`)
    return row ? Number(row.value) : 0
  } catch {
    return 0 // meta table does not exist yet
  }
}

/** Applies pending migrations. Safe to call concurrently: every statement is idempotent. */
export async function migrate(db: Db): Promise<number> {
  const from = await currentVersion(db)
  for (let v = from; v < MIGRATIONS.length; v++) {
    await db.batch([
      ...MIGRATIONS[v]!.map((sql) => ({ sql })),
      {
        sql: `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
              ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        params: [String(v + 1)],
      },
    ])
  }
  return MIGRATIONS.length - from
}

const migrated = new WeakSet<Db>()

/** Runs migrations at most once per isolate per Db instance. */
export async function ensureSchema(db: Db): Promise<void> {
  if (migrated.has(db)) return
  await migrate(db)
  migrated.add(db)
}
