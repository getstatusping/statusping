import type { SmtpConnector } from './notify/smtp.ts'
import {
  type EnvGetter,
  type NormalizedConfig,
  type Role,
  type StatusPingConfig,
  normalizeConfig,
  parseJsonConfig,
  parsePingTokens,
  isEnvRef,
  resolveConfigEnv,
} from './config.ts'
import { isValidTimeZone } from './util/time.ts'
import { nullProtoRecord, own } from './util/own.ts'
import { canonicalJson } from './updates.ts'
import type { Db } from './db/types.ts'
import type { CertificateExpiryProvider } from './expiry/types.ts'
import type { TcpConnector } from './evaluate/tcp.ts'
import type { ConfirmationProbe } from './confirmation.ts'
import type { CloudflareEmailSender } from './notify/sinks.ts'
import { currentRevision, ensureBaselineRevision, KEEP_REVISIONS, loadAdminConfig, seedAdminConfig } from './admin/service.ts'
import { beginSetup, loadSetupState } from './setup/state.ts'
import { type AdminConfig, type AdminConfigValidation, validateAdminConfig } from './admin/security.ts'
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
  /**
   * Whether the Host of an incoming request can be trusted as this site's address. True on Workers
   * (Cloudflare only routes the site's own hostnames to it); on Node only behind a trusted reverse
   * proxy (STATUSPING_TRUST_PROXY=true), since a direct listener accepts any Host header. Rescue
   * mode uses the request origin as the site address only as a last resort, and only when true.
   */
  trustRequestOrigin: boolean
  /** Hosted tenant plan policy from STATUSPING_TENANT (plan 005); undefined when self-hosted. */
  tenant?: TenantPolicy
  /** The newest saved configuration revision (0 before the first). */
  configRevision: number
  /** What the last refreshAdminConfig() saw; an unchanged stamp skips reloading and re-validating. */
  configStamp?: string
  configLoaded: boolean
  /**
   * Set while the stored configuration cannot be loaded. `revision` is the earlier saved version in
   * use instead, or null when none loads either: then only the sign-in settings are in use and the
   * tick runs no checks, so the owner can still sign in to Settings (or reset) and fix it.
   */
  configFallback?: ConfigFallback
  /** What loading the configuration in use dropped or clamped (see NormalizeOptions.warnings). */
  configWarnings: string[]
  /** A deployed site: configured only through its database. */
  fromDatabase: boolean
  /** Reads an old statusping.config.ts, if the repository still has one (migration source only). */
  legacyConfig?: () => Promise<StatusPingConfig | undefined>
}

export interface ConfigFallback {
  /** Why the stored configuration was refused (validation problems; never secret values). */
  problem: string
  /** The earlier revision in use, or null when only the sign-in settings could be loaded. */
  revision: number | null
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
  /** See Deps.trustRequestOrigin; default true. */
  trustRequestOrigin?: boolean
}

export const consoleLogger: Logger = (level, message, data) => {
  const line = data ? `${message} ${JSON.stringify(data)}` : message
  if (level === 'error') console.error(`[statusping] ${line}`)
  else if (level === 'warn') console.warn(`[statusping] ${line}`)
  else if (level === 'info') console.log(`[statusping] ${line}`)
}

export function createDeps(opts: CreateDepsOptions): Deps {
  // Strings only: an environment object that inherits Object.prototype would otherwise answer
  // "toString" or "constructor" with a native function.
  const rawGetEnv = opts.getEnv
  opts = { ...opts, getEnv: (name) => { const value = rawGetEnv(name); return typeof value === 'string' ? value : undefined } }
  const roleEnv = opts.getEnv('STATUSPING_ROLE') ?? 'primary'
  if (roleEnv !== 'primary' && roleEnv !== 'watchdog') {
    throw new Error(`STATUSPING_ROLE must be "primary" or "watchdog", got "${roleEnv}"`)
  }
  // Read from the real environment only: a tenant can never store or override its own policy.
  const tenant = parseTenantPolicy(opts.getEnv(TENANT_ENV))
  const input = opts.config ?? UNCONFIGURED
  const normalized = normalizeConfig(resolveConfigEnv(input, opts.getEnv))
  const config = tenant ? clampToTenantPolicy(normalized, tenant) : normalized
  // Escalation needs no ACK_SECRET: acknowledgement links fall back to a key the site generates
  // and stores (acknowledgeSecret), the same way for an injected and a stored configuration.
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
    getEnv: (name) => opts.getEnv(name) ?? (isStorableEnv(name) ? own(deps.storedEnv, name) : undefined),
    hasRealEnv: (name) => opts.getEnv(name) !== undefined,
    storedEnv: nullProtoRecord<string>(),
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
    trustRequestOrigin: opts.trustRequestOrigin ?? true,
    log: opts.log ?? consoleLogger,
    tenant,
    configRevision: 0,
    configLoaded: false,
    configWarnings: [],
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
  const stored = nullProtoRecord<string>()
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
export async function refreshAdminConfig(deps: Deps, now: number, origin?: string): Promise<boolean> {
  const { stamp, revision } = await configStamp(deps)
  if (stamp === deps.configStamp) return deps.configLoaded
  deps.configRevision = revision
  const loaded = await loadAdminState(deps, now, origin)
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

async function loadAdminState(deps: Deps, now: number, origin?: string): Promise<{ loaded: boolean; wrote: boolean }> {
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
  if (deps.configRevision === 0 && stored) {
    await ensureBaselineRevision(deps.db)
    wrote = true
  }
  let validated: AdminConfigValidation
  try {
    // A row that is not a JSON object loads as null (and the seed above cannot replace it).
    if (!stored) throw new Error('The stored configuration is not a JSON object.')
    validated = validateAdminConfig(stored.config, deps.getEnv, 'load')
  } catch (error) {
    // Never let a stored configuration take the whole site down (this runs in front of every
    // request and at the top of every tick): fall back, and keep Settings and reset reachable.
    await loadFallback(deps, stored?.config, (error as Error).message, origin)
    return { loaded: true, wrote }
  }
  useConfig(deps, validated)
  deps.configFallback = undefined
  return { loaded: true, wrote }
}

function useConfig(deps: Deps, validated: AdminConfigValidation): void {
  deps.config = validated.normalized
  deps.configInput = validated.config
  deps.configWarnings = validated.warnings
  if (validated.warnings.length) deps.log('warn', 'The stored configuration loaded with settings left out or adjusted. Saving it in Settings shows what to fix.', { warnings: validated.warnings })
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

const httpUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}

/** The stored title when rescue mode would use it: a non-empty string. */
const storedTitle = (stored: Record<string, unknown> | null) =>
  typeof stored?.title === 'string' && stored.title.trim() ? stored.title : undefined

/** The origin of the stored base URL, when it is an http(s) URL. */
function storedOrigin(stored: Record<string, unknown> | null): string | undefined {
  return httpUrl(stored?.baseUrl) ? new URL(stored.baseUrl).origin : undefined
}

/** The stored monitors by id; entries that cannot be read are skipped. */
function storedMonitors(config: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const monitors = new Map<string, Record<string, unknown>>()
  for (const group of Array.isArray(config.groups) ? config.groups : []) {
    const list = record(group)?.monitors
    for (const value of Array.isArray(list) ? list : []) {
      const monitor = record(value)
      if (monitor && typeof monitor.id === 'string' && !monitors.has(monitor.id)) monitors.set(monitor.id, monitor)
    }
  }
  return monitors
}

const headerValue = (value: unknown) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || isEnvRef(value)

/**
 * A monitor from the older version, connecting where the stored monitor of the same id does (url,
 * headers, host, port) whenever the stored value is well-formed: the older version may point at a
 * host, or send credentials, that the site no longer uses.
 */
function withStoredTarget(monitor: Record<string, unknown>, stored: Record<string, unknown>): Record<string, unknown> {
  const next = { ...monitor }
  if (typeof stored.url === 'string' ? httpUrl(stored.url) : isEnvRef(stored.url)) next.url = stored.url
  if (stored.headers === undefined) delete next.headers
  else {
    const headers = record(stored.headers)
    if (headers && Object.values(headers).every(headerValue)) next.headers = headers
  }
  if (typeof stored.host === 'string' && stored.host.trim()) next.host = stored.host
  if (typeof stored.port === 'number' && Number.isInteger(stored.port) && stored.port >= 1 && stored.port <= 65535) next.port = stored.port
  return next
}

/**
 * An earlier saved version, made safe to run in place of a stored configuration that does not
 * load. It fails closed:
 * - Who may sign in and see what (`access`, the pages with their access rules, and `home`) comes
 *   from the stored configuration, never from the older version, the same way a restore keeps
 *   today's sign-in method.
 * - So do `title`, `baseUrl` and `timezone` whenever the stored value is valid (the rule rescue
 *   mode uses). `baseUrl` decides the sign-in redirect, secure cookies, which origins count as this
 *   site, and the host in ping and acknowledgement links.
 * - `updates` and `peer` come from the stored configuration when their blocks are well-formed, and
 *   are otherwise left at their defaults (off); the older version's never come back.
 * - Nothing deleted or changed since comes back: only monitors the stored configuration still
 *   defines, with the same kind, are kept, and they connect where the stored one does; an alert
 *   channel is kept only when it is exactly the stored one. Pages show no monitor targets.
 * The result is validated like any configuration; if it does not load, rescue mode applies.
 */
export function fallbackFromRevision(revision: AdminConfig, stored: Record<string, unknown>): AdminConfig {
  const current = storedMonitors(stored)
  const groups = (revision.groups ?? [])
    .map((group) => ({
      ...group,
      monitors: (group.monitors ?? []).flatMap((monitor) => {
        const now = current.get(monitor.id)
        if (!now || now.kind !== monitor.kind) return []
        return [withStoredTarget(monitor as unknown as Record<string, unknown>, now) as unknown as typeof monitor]
      }),
    }))
    .filter((group) => group.monitors.length > 0)
  const ids = new Set(groups.flatMap((group) => group.monitors.map((monitor) => monitor.id)))
  const groupNames = new Set(groups.map((group) => group.name))
  const known = (selector: unknown) => typeof selector === 'string'
    && (selector === '*' || (selector.startsWith('group:') ? groupNames.has(selector.slice(6)) : ids.has(selector)))

  const next: Record<string, unknown> = { ...revision, admin: true, groups }
  const title = storedTitle(stored)
  if (title !== undefined) next.title = title
  if (httpUrl(stored.baseUrl)) next.baseUrl = stored.baseUrl
  if (stored.timezone === undefined) delete next.timezone
  else if (typeof stored.timezone === 'string' && isValidTimeZone(stored.timezone)) next.timezone = stored.timezone
  for (const key of ['access', 'pages', 'home'] as const) delete next[key]
  if (stored.access !== undefined) next.access = stored.access
  if (stored.home !== undefined) next.home = stored.home
  if (stored.pages !== undefined) {
    // The stored pages, listing only the monitors this version has, and never their targets.
    next.pages = Array.isArray(stored.pages)
      ? stored.pages.map((page) => {
          const p = record(page)
          if (!p) return page
          const out: Record<string, unknown> = { ...p }
          if (Array.isArray(p.monitors)) out.monitors = p.monitors.filter(known)
          if (Array.isArray(p.show)) out.show = p.show.filter((item) => item !== 'target')
          return out
        })
      : stored.pages
  }
  const storedSinks = record(stored.sinks)
  if (revision.sinks) {
    next.sinks = Object.fromEntries(Object.entries(revision.sinks).filter(([name, sink]) =>
      storedSinks !== null && Object.hasOwn(storedSinks, name) && canonicalJson(storedSinks[name]) === canonicalJson(sink)))
  }
  if (Array.isArray(revision.maintenance)) {
    next.maintenance = revision.maintenance
      .map((window) => (Array.isArray(window.monitors) ? { ...window, monitors: window.monitors.filter((id) => ids.has(id)) } : window))
      .filter((window) => window.monitors === '*' || window.monitors.length > 0)
  }
  // Update checks and the watchdog pairing come from the stored configuration when its block is
  // well-formed; otherwise they fall back to the defaults (off), never to the older version's.
  delete next.updates
  delete next.peer
  const updates = storedUpdates(stored.updates)
  if (updates) next.updates = updates
  const peer = storedPeer(stored.peer)
  if (peer) {
    if (typeof peer.heartbeatMonitor === 'string' && !ids.has(peer.heartbeatMonitor)) delete peer.heartbeatMonitor
    if (typeof peer.healthMonitor === 'string' && !ids.has(peer.healthMonitor)) delete peer.healthMonitor
    next.peer = peer
  }
  return next as unknown as AdminConfig
}

/** The stored `updates` block when every field it has is valid (see normalizeConfig), else null. */
function storedUpdates(value: unknown): Record<string, unknown> | null {
  const updates = record(value)
  if (!updates) return null
  const { enabled, manifestUrl, publicKey } = updates
  if (enabled !== undefined && typeof enabled !== 'boolean') return null
  if (manifestUrl !== undefined) {
    if (typeof manifestUrl !== 'string') return null
    try {
      const url = new URL(manifestUrl)
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
    } catch { return null }
  }
  if (publicKey !== undefined) {
    if (typeof publicKey !== 'string') return null
    try { if (Uint8Array.from(atob(publicKey), (char) => char.charCodeAt(0)).byteLength !== 32) return null } catch { return null }
  }
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(manifestUrl !== undefined ? { manifestUrl } : {}),
    ...(publicKey !== undefined ? { publicKey } : {}),
  }
}

/** The stored `peer` block when every field it has is well-formed, else null. */
function storedPeer(value: unknown): Record<string, unknown> | null {
  const peer = record(value)
  if (!peer) return null
  const { pingUrl, heartbeatMonitor, healthMonitor } = peer
  if (pingUrl !== undefined && !(typeof pingUrl === 'string' ? httpUrl(pingUrl) : isEnvRef(pingUrl))) return null
  if (heartbeatMonitor !== undefined && typeof heartbeatMonitor !== 'string') return null
  if (healthMonitor !== undefined && typeof healthMonitor !== 'string') return null
  return {
    ...(pingUrl !== undefined ? { pingUrl } : {}),
    ...(heartbeatMonitor !== undefined ? { heartbeatMonitor } : {}),
    ...(healthMonitor !== undefined ? { healthMonitor } : {}),
  }
}

/**
 * The stored configuration failed to load. Use the newest earlier revision that still loads, with
 * the stored configuration's access rules (see fallbackFromRevision); if none does, keep only the
 * sign-in settings (title, address, access) so an administrator can sign in and fix or import a
 * configuration, while the tick runs no checks (see tick()). A stored row that is not even an
 * object says nothing about who may see what, so it goes straight to that rescue mode.
 */
async function loadFallback(deps: Deps, stored: AdminConfig | undefined, problem: string, origin?: string): Promise<void> {
  const current = record(stored)
  if (current) {
    const rows = await deps.db.all<{ id: number; config_json: string }>(`SELECT id, config_json FROM config_revisions ORDER BY id DESC LIMIT ?`, [KEEP_REVISIONS])
    for (const row of rows) {
      let revision: AdminConfigValidation
      let validated: AdminConfigValidation
      try {
        revision = validateAdminConfig(JSON.parse(row.config_json), deps.getEnv, 'load')
        validated = validateAdminConfig(fallbackFromRevision(revision.config, current), deps.getEnv, 'load')
      } catch { continue }
      useConfig(deps, validated)
      deps.configFallback = { problem, revision: row.id }
      deps.log('error', `The stored configuration could not be loaded. Using saved version ${row.id}, with the stored access rules and without monitors or channels deleted since, until it is fixed in Settings → Configuration.`, { problem })
      return
    }
  }
  deps.configFallback = { problem, revision: null }
  deps.log('error', 'The stored configuration could not be loaded and no earlier version loads with its access rules. Only sign-in settings are in use and no checks run until it is fixed in Settings → Configuration (or the site is reset).', { problem })
  // The stored address's origin whenever it parses (a bad path or trailing junk must not throw it
  // away); the address the site was opened at only as a last resort, and only where the Host
  // header is trustworthy (see Deps.trustRequestOrigin).
  const safeBaseUrl = storedOrigin(current) ?? (deps.trustRequestOrigin && httpUrl(origin) ? new URL(origin).origin : UNCONFIGURED.baseUrl)
  const attempts: Record<string, unknown>[] = current
    ? [
        { title: current.title, baseUrl: current.baseUrl, timezone: current.timezone, access: current.access, groups: [], admin: true },
        // A bad timezone or address must not lock the owner out as well.
        { title: typeof current.title === 'string' && current.title.trim() ? current.title : UNCONFIGURED.title, baseUrl: safeBaseUrl, timezone: 'UTC', access: current.access, groups: [], admin: true },
      ]
    : []
  let lastProblem = 'The stored configuration is not a JSON object.'
  for (const rescue of attempts) {
    try {
      useConfig(deps, validateAdminConfig(rescue, deps.getEnv, 'load'))
      return
    } catch (error) {
      lastProblem = (error as Error).message
    }
  }
  // /setup/recover cannot help here: it checks the email against the administrators of the loaded
  // sign-in settings, and there are none. Reading them from the stored row instead would let a
  // recovery session change the sign-in method on top of a configuration that does not load.
  deps.log('error', 'The sign-in settings could not be loaded either, so nobody can sign in and /setup/recover cannot be used. Reset the site at /setup/reset, or repair the stored configuration in the database.', { problem: lastProblem })
  // Fail closed: no sign-in method, no monitors, nothing from an earlier configuration.
  useConfig(deps, validateAdminConfig({ title: UNCONFIGURED.title, baseUrl: safeBaseUrl, groups: [], admin: true }, deps.getEnv, 'load'))
}
