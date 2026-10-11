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
  [
    `CREATE TABLE IF NOT EXISTS announcements (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      create_key   TEXT NOT NULL UNIQUE,
      title        TEXT NOT NULL,
      impact       TEXT NOT NULL CHECK (impact IN ('none', 'minor', 'major', 'maintenance')),
      status       TEXT NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
      monitors_json TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      resolved_at  INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS announcements_status_created ON announcements(status, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS announcement_updates (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      announcement_id INTEGER NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
      body            TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS announcement_updates_announcement ON announcement_updates(announcement_id, created_at DESC)`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS acknowledgements (
      incident_id INTEGER PRIMARY KEY,
      by          TEXT NOT NULL,
      at          INTEGER NOT NULL,
      via         TEXT NOT NULL CHECK (via IN ('alert-link', 'admin-page'))
    )`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      email TEXT NOT NULL,
      confirmed_at INTEGER,
      confirm_token_hash TEXT NOT NULL UNIQUE,
      unsubscribe_token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      UNIQUE(page_slug, email)
    )`,
    `CREATE INDEX IF NOT EXISTS subscribers_page_confirmed ON subscribers(page_slug, confirmed_at)`,
    `CREATE TABLE IF NOT EXISTS subscriber_rate_limits (
      bucket TEXT NOT NULL,
      window_at INTEGER NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY(bucket, window_at)
    )`,
    `CREATE TABLE IF NOT EXISTS subscriber_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscriber_id INTEGER NOT NULL,
      event_key TEXT NOT NULL,
      subject TEXT NOT NULL,
      text_body TEXT NOT NULL,
      html_body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sent_at INTEGER,
      ok INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      UNIQUE(subscriber_id, event_key)
    )`,
    `CREATE INDEX IF NOT EXISTS subscriber_outbox_pending ON subscriber_outbox(ok, created_at)`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS confirmation_results (
      monitor_id TEXT NOT NULL,
      tick_at    INTEGER NOT NULL,
      location   TEXT NOT NULL,
      ok         INTEGER CHECK (ok IN (0, 1)),
      error      TEXT,
      PRIMARY KEY (monitor_id, tick_at, location)
    )`,
    `CREATE INDEX IF NOT EXISTS confirmation_results_monitor_time ON confirmation_results(monitor_id, tick_at DESC)`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS admin_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at DESC)`,
    `CREATE TABLE IF NOT EXISTS admin_csrf (
      session_hash TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS admin_csrf_expires ON admin_csrf(expires_at)`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS ping_rate_limits (
      ip TEXT NOT NULL,
      window_at INTEGER NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (ip, window_at)
    )`,
    `CREATE INDEX IF NOT EXISTS ping_rate_limits_window ON ping_rate_limits(window_at)`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS announcement_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      announcement_update_id INTEGER NOT NULL,
      sink TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sent_at INTEGER,
      ok INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      UNIQUE (announcement_update_id, sink)
    )`,
    `CREATE INDEX IF NOT EXISTS announcement_notifications_pending ON announcement_notifications(ok, created_at)`,
  ],
  [
    // The update checker intentionally retains no manifest body, URL, credentials, or error
    // details—only its safe, compact outcome for the administrator UI.
    `CREATE TABLE IF NOT EXISTS update_checks (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      result TEXT NOT NULL CHECK (result IN ('available', 'current', 'incompatible', 'failed')),
      target_version TEXT,
      checked_at INTEGER NOT NULL
    )`,
  ],
  [
    // First-run setup. `pending` puts the whole site in setup mode; `complete` means the
    // wizard-written admin_config is authoritative. The code is the only value ever logged,
    // and only while setup is pending. previous_config_json keeps the config a reset replaced.
    `CREATE TABLE IF NOT EXISTS setup_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
      code TEXT,
      session_key TEXT,
      draft_json TEXT NOT NULL DEFAULT '{}',
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      previous_config_json TEXT,
      updated_at INTEGER NOT NULL
    )`,
    // Built-in email + password accounts created by the wizard (generated passwords only).
    `CREATE TABLE IF NOT EXISTS local_users (
      email TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    // Instance-generated keys, such as the session signing key when SESSION_SECRET is unset.
    `CREATE TABLE IF NOT EXISTS instance_secrets (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  ],
  [
    // MCP access tokens, created in Settings. Only a hash is stored; scopes is a JSON array.
    `CREATE TABLE IF NOT EXISTS api_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    )`,
  ],
  [
    // Every saved configuration, newest last; the newest 50 are kept. The id is the revision
    // number forms and If-Match compare against. yaml keeps the text an import was made from.
    `CREATE TABLE IF NOT EXISTS config_revisions (
      id INTEGER PRIMARY KEY,
      config_json TEXT NOT NULL,
      yaml TEXT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      at INTEGER NOT NULL
    )`,
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
