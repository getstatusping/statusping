import type { SmtpConnector } from './notify/smtp.ts'
import {
  type EnvGetter,
  type NormalizedConfig,
  type Role,
  type StatusPingConfig,
  normalizeConfig,
  parseJsonConfig,
  parsePingTokens,
  resolveConfigEnv,
} from './config.ts'
import type { Db } from './db/types.ts'
import type { CertificateExpiryProvider } from './expiry/types.ts'
import type { TcpConnector } from './evaluate/tcp.ts'
import type { ConfirmationProbe } from './confirmation.ts'
import type { CloudflareEmailSender } from './notify/sinks.ts'
import { currentRevision, ensureBaselineRevision, loadAdminConfig, seedAdminConfig } from './admin/service.ts'
import { beginSetup, loadSetupState } from './setup/state.ts'
import { validateAdminConfig } from './admin/security.ts'
import { normalizeClientIp } from './rate-limit.ts'
import { type TenantPolicy, TENANT_ENV, clampToTenantPolicy, parseTenantPolicy } from './platform.ts'
import { type HostResolver, type TargetGuard, blockPrivateTargets, privateTargetGuard } from './util/private-targets.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type Logger = (level: LogLevel, message: string, data?: Record<string, unknown>) => void

export interface Deps {
  db: Db
  config: NormalizedConfig
  /** Raw active config. Kept to seed and render the opt-in admin editor; never sent to visitors. */
  configInput: StatusPingConfig
  /** `admin: true` was supplied by config-as-code, or setup finished. False preserves config-as-code behaviour. */
  adminEnabled: boolean
  /** The instance is in first-run setup mode: only /healthz and /setup respond, and ticks run no checks. */
  setupPending: boolean
  role: Role
  /** Environment first, then the values setup stored in the DB (see STORABLE_ENV). */
  getEnv: EnvGetter
  /** Whether a name is set in the real environment (not a stored value). */
  hasRealEnv: (name: string) => boolean
  /** Values setup stored in the DB for STORABLE_ENV names; reloaded on every refresh. */
  storedEnv: Record<string, string>
  /** monitor id → ping token (secret), from the PING_TOKENS env var. */
  pingTokens: Record<string, string>
  fetch: typeof fetch
  /** Optional runtime-native certificate provider. Workers intentionally omit this. */
  certificateExpiry?: CertificateExpiryProvider
  /** Raw TCP connector supplied by the active runtime adapter. */
  tcpConnect?: TcpConnector
  /**
   * Set when STATUSPING_BLOCK_PRIVATE_TARGETS=true or in hosted tenant mode: refuses monitor and
   * OIDC targets on private addresses. Use targetFetch/targetTcpConnect rather than calling it.
   */
  targetGuard?: TargetGuard
  /** Optional second-vantage implementation. Required at runtime by monitors with `confirm`. */
  confirmationProbe?: ConfirmationProbe
  /** Display name for this scheduler location; adapters may set a truthful value. */
  location?: string
  /** Optional Cloudflare Email Routing binding adapter. */
  cloudflareEmail?: CloudflareEmailSender
  /** Opens SMTP connections for email channels that use your own mail server. */
  smtpConnect?: SmtpConnector
  log: Logger
  /** Runs a promise after the response is sent where the platform supports it. */
  waitUntil?: (p: Promise<unknown>) => void
  /** Adapter-owned resolver. Core never trusts forwarding headers itself. */
  clientIp: (request: Request) => string | null
  /** Hosted tenant plan policy from STATUSPING_TENANT (plan 005); undefined when self-hosted. */
  tenant?: TenantPolicy
  /** The newest saved configuration revision (0 before the first). */
  configRevision: number
  /** What the last refreshAdminConfig() saw; an unchanged stamp skips reloading and re-validating. */
  configStamp?: string
  configLoaded: boolean
  /** A deployed site: configured only through its database. */
  fromDatabase: boolean
  /** Reads an old statusping.config.ts, if the repository still has one (migration source only). */
  legacyConfig?: () => Promise<StatusPingConfig | undefined>
}

/** What a site serves before setup or a migration has stored its configuration. */
const UNCONFIGURED: StatusPingConfig = { title: 'StatusPing', baseUrl: 'http://localhost', groups: [] }

/** The copy of a config-as-code site's configuration that v0.2.26/v0.2.27 saved; adopted once on first run. */
export const LEGACY_CONFIG_KEY = 'legacy_config'

export interface CreateDepsOptions {
  db: Db
  /**
   * Tests only. A deployed site passes nothing and runs from its database: the setup wizard,
   * Settings, and the YAML API are the only ways to configure it (plan 011).
   */
  config?: StatusPingConfig
  /** Adapters pass a reader for an old statusping.config.ts; it is used once, to migrate. */
  legacyConfig?: () => Promise<StatusPingConfig | undefined>
  getEnv: EnvGetter
  fetch?: typeof fetch
  log?: Logger
  certificateExpiry?: CertificateExpiryProvider
  tcpConnect?: TcpConnector
  /** Runtime DNS lookup (all addresses) used by the private-target guard. Workers omit it. */
  resolveHost?: HostResolver
  confirmationProbe?: ConfirmationProbe
  location?: string
  cloudflareEmail?: CloudflareEmailSender
  smtpConnect?: SmtpConnector
  clientIp?: (request: Request) => string | null
}

export const consoleLogger: Logger = (level, message, data) => {
  const line = data ? `${message} ${JSON.stringify(data)}` : message
  if (level === 'error') console.error(`[statusping] ${line}`)
  else if (level === 'warn') console.warn(`[statusping] ${line}`)
  else if (level === 'info') console.log(`[statusping] ${line}`)
}

export function createDeps(opts: CreateDepsOptions): Deps {
  const roleEnv = opts.getEnv('STATUSPING_ROLE') ?? 'primary'
  if (roleEnv !== 'primary' && roleEnv !== 'watchdog') {
    throw new Error(`STATUSPING_ROLE must be "primary" or "watchdog", got "${roleEnv}"`)
  }
  // Read from the real environment only: a tenant can never store or override its own policy.
  const tenant = parseTenantPolicy(opts.getEnv(TENANT_ENV))
  const input = opts.config ?? UNCONFIGURED
  const normalized = normalizeConfig(resolveConfigEnv(input, opts.getEnv))
  const config = tenant ? clampToTenantPolicy(normalized, tenant) : normalized
  if (config.monitors.some((monitor) => monitor.escalation) && !opts.getEnv('ACK_SECRET')) {
    throw new Error('ACK_SECRET must be set when escalation is configured')
  }
  if (config.subscribers && !opts.getEnv('SUBSCRIBER_TOKEN_SECRET')) {
    throw new Error('SUBSCRIBER_TOKEN_SECRET must be set when subscribers are configured')
  }
  const deps: Deps = {
    db: opts.db,
    config,
    configInput: input,
    adminEnabled: opts.config === undefined || opts.config.admin === true,
    fromDatabase: opts.config === undefined,
    legacyConfig: opts.legacyConfig,
    setupPending: false,
    role: roleEnv,
    // A Worker secret or env var always wins over a value stored by setup.
    getEnv: (name) => opts.getEnv(name) ?? (isStorableEnv(name) ? deps.storedEnv[name] : undefined),
    hasRealEnv: (name) => opts.getEnv(name) !== undefined,
    storedEnv: {},
    pingTokens: parsePingTokens(opts.getEnv('PING_TOKENS')),
    // Bind: Workers throw "Illegal invocation" when fetch is called detached from globalThis.
    fetch: opts.fetch ?? fetch.bind(globalThis),
    certificateExpiry: opts.certificateExpiry,
    tcpConnect: opts.tcpConnect,
    targetGuard: blockPrivateTargets(opts.getEnv, tenant) ? privateTargetGuard(opts.resolveHost) : undefined,
    confirmationProbe: opts.confirmationProbe,
    location: opts.location,
    cloudflareEmail: opts.cloudflareEmail,
    smtpConnect: opts.smtpConnect,
    clientIp: opts.clientIp ?? (() => null),
    log: opts.log ?? consoleLogger,
    tenant,
    configRevision: 0,
    configLoaded: false,
  }
  return deps
}

/**
 * Settings the setup wizard may store in the DB instead of the environment. A Worker secret is
 * write-only; a DB value is readable by anyone with database access, so the environment always
 * takes precedence and the UI never shows a stored value back.
 */
export const STORABLE_ENV = ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'CF_ACCESS_AUD']
/** Alert-channel credentials entered in the admin are stored under SINK_<CHANNEL>_<FIELD>. */
const SINK_ENV = /^SINK_[A-Z0-9_]{1,100}$/
export const isStorableEnv = (name: string) => STORABLE_ENV.includes(name) || SINK_ENV.test(name)
export const storedEnvKey = (name: string) => `env:${name}`

async function loadStoredEnv(deps: Deps): Promise<void> {
  const rows = await deps.db.all<{ name: string; value: string }>(`SELECT name, value FROM instance_secrets WHERE name LIKE 'env:%'`)
  const stored: Record<string, string> = {}
  for (const row of rows) {
    const name = row.name.slice(4)
    if (isStorableEnv(name)) stored[name] = row.value
  }
  deps.storedEnv = stored
}

/** One cheap read that changes whenever the configuration, setup state, or stored settings do. */
async function configStamp(deps: Deps): Promise<{ stamp: string; revision: number }> {
  const row = await deps.db.first<{ rev: number; setup: string | null; cfg: string | null; env: string }>(
    `SELECT (SELECT COALESCE(MAX(id), 0) FROM config_revisions) AS rev,
            (SELECT status || ':' || updated_at FROM setup_state WHERE id = 1) AS setup,
            (SELECT updated_at || ':' || updated_by || ':' || length(config_json) FROM admin_config WHERE id = 1) AS cfg,
            (SELECT COUNT(*) || ':' || COALESCE(MAX(created_at), 0) || ':' || COALESCE(SUM(length(value)), 0) FROM instance_secrets WHERE substr(name, 1, 4) = 'env:') AS env`,
  )
  return { stamp: JSON.stringify([row?.rev, row?.setup, row?.cfg, row?.env, deps.adminEnabled]), revision: row?.rev ?? 0 }
}

/**
 * Applies the instance's setup state, then loads the configuration from the database. While setup
 * is pending, nothing is loaded; a fresh database first adopts an old configuration or starts setup
 * (see firstRun). Tests that inject a config without `admin: true` keep it as is. Call after migrations, before work that reads `deps.config`. Nothing is reloaded
 * or re-validated while the revision, setup state and stored settings are unchanged.
 */
export async function refreshAdminConfig(deps: Deps, now: number): Promise<boolean> {
  const { stamp, revision } = await configStamp(deps)
  if (stamp === deps.configStamp) return deps.configLoaded
  deps.configRevision = revision
  const loaded = await loadAdminState(deps, now)
  deps.configLoaded = loaded.loaded
  if (loaded.wrote) deps.configRevision = await currentRevision(deps.db)
  // A refresh that wrote (a seed, a baseline revision) is read again next time.
  deps.configStamp = loaded.wrote ? undefined : stamp
  return loaded.loaded
}

/**
 * v0.3 dropped config-as-code. On the first start of an empty database the site adopts, once, the
 * copy v0.2.26/v0.2.27 saved, else an old statusping.config.ts still in the repository, else
 * STATUSPING_CONFIG. No intermediate release is needed. The configuration keeps monitor
 * IDs, history and ping URLs. With a sign-in method and administrators the site carries on as
 * before; without, setup opens with the configuration already imported. Otherwise setup starts
 * from scratch. Hosted tenants always start in setup (plan 005).
 */
async function firstRun(deps: Deps, now: number): Promise<void> {
  let legacy: StatusPingConfig | undefined
  if (!deps.tenant) {
    const saved = (await deps.db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = ?`, [LEGACY_CONFIG_KEY]))?.value
    try {
      const raw = saved ? JSON.parse(saved)
        : (await deps.legacyConfig?.().catch(() => undefined))
          ?? (deps.hasRealEnv('STATUSPING_CONFIG') ? parseJsonConfig(deps.getEnv('STATUSPING_CONFIG')!) : undefined)
      if (raw) legacy = validateAdminConfig({ ...raw, admin: true }, deps.getEnv, 'load').config
    } catch (error) {
      deps.log('warn', 'The old configuration could not be moved to the database; starting setup instead. Import it in the setup wizard after fixing it.', { problem: (error as Error).message })
    }
  }
  if (!legacy) {
    await beginSetup(deps.db, deps.tenant ? 'platform' : 'first-run', now)
    return
  }
  const admins = legacy.access?.admins
  if (legacy.access?.provider && (admins?.emails?.length || admins?.teams?.length)) {
    await seedAdminConfig(deps.db, legacy, 'migration', now)
    await deps.db.batch([
      { sql: `INSERT INTO setup_state (id, status, code, session_key, draft_json, failed_attempts, previous_config_json, updated_at) VALUES (1, 'complete', NULL, NULL, '{}', 0, NULL, ?) ON CONFLICT(id) DO NOTHING`, params: [now] },
      { sql: `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES ('migration', 'config.migrate', 'config', NULL, NULL, ?)`, params: [now] },
      { sql: `DELETE FROM instance_secrets WHERE name = ?`, params: [LEGACY_CONFIG_KEY] },
    ])
    deps.log('info', 'Moved the configuration from statusping.config.ts / STATUSPING_CONFIG into the database. Edit it in Settings from now on.')
    return
  }
  await beginSetup(deps.db, 'migration', now)
  const draft = { imported: legacy, title: legacy.title, description: legacy.description, baseUrl: legacy.baseUrl, timezone: legacy.timezone }
  await deps.db.batch([
    { sql: `UPDATE setup_state SET draft_json = ? WHERE id = 1`, params: [JSON.stringify(draft)] },
    { sql: `DELETE FROM instance_secrets WHERE name = ?`, params: [LEGACY_CONFIG_KEY] },
  ])
  deps.log('info', 'The old configuration has no administrators. Open /setup to choose how to sign in; your monitors are already imported.')
}

async function loadAdminState(deps: Deps, now: number): Promise<{ loaded: boolean; wrote: boolean }> {
  await loadStoredEnv(deps)
  let setup = await loadSetupState(deps.db)
  let wrote = false
  if (!setup && deps.fromDatabase && !(await loadAdminConfig(deps.db))) {
    // First run of this database: adopt a config-as-code site's configuration, or start setup.
    // (A site configured with `admin: true` before setup existed has a config row and no setup row.)
    await firstRun(deps, now)
    setup = await loadSetupState(deps.db)
    wrote = true
  }
  deps.setupPending = setup?.status === 'pending'
  if (deps.setupPending) return { loaded: false, wrote }
  if (setup?.status === 'complete') deps.adminEnabled = true
  if (!deps.adminEnabled) return { loaded: false, wrote }
  let stored = await loadAdminConfig(deps.db)
  if (!stored) {
    // Validate before persisting: literal credentials never enter admin_config or audit_log.
    const validated = validateAdminConfig({ ...deps.configInput, admin: true }, deps.getEnv, 'load')
    await seedAdminConfig(deps.db, validated.config, 'config-seed', now)
    stored = await loadAdminConfig(deps.db)
    wrote = true
  }
  if (!stored) throw new Error('admin config seed was not stored')
  if (deps.configRevision === 0) {
    await ensureBaselineRevision(deps.db)
    wrote = true
  }
  const validated = validateAdminConfig(stored.config, deps.getEnv, 'load')
  deps.config = validated.normalized
  deps.configInput = validated.config
  return { loaded: true, wrote }
}
