import {
  type EnvGetter,
  type NormalizedConfig,
  type Role,
  type StatusPingConfig,
  normalizeConfig,
  parsePingTokens,
  resolveConfigEnv,
} from './config.ts'
import type { Db } from './db/types.ts'
import type { CertificateExpiryProvider } from './expiry/types.ts'
import type { TcpConnector } from './evaluate/tcp.ts'
import type { ConfirmationProbe } from './confirmation.ts'
import type { CloudflareEmailSender } from './notify/sinks.ts'
import { loadAdminConfig, seedAdminConfig } from './admin/service.ts'
import { validateAdminConfig } from './admin/security.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type Logger = (level: LogLevel, message: string, data?: Record<string, unknown>) => void

export interface Deps {
  db: Db
  config: NormalizedConfig
  /** Raw active config. Kept to seed and render the opt-in admin editor; never sent to visitors. */
  configInput: StatusPingConfig
  /** `admin: true` was supplied by config-as-code. False preserves config-as-code behaviour. */
  adminEnabled: boolean
  role: Role
  getEnv: EnvGetter
  /** monitor id → ping token (secret), from the PING_TOKENS env var. */
  pingTokens: Record<string, string>
  fetch: typeof fetch
  /** Optional runtime-native certificate provider. Workers intentionally omit this. */
  certificateExpiry?: CertificateExpiryProvider
  /** Raw TCP connector supplied by the active runtime adapter. */
  tcpConnect?: TcpConnector
  /** Optional second-vantage implementation. Required at runtime by monitors with `confirm`. */
  confirmationProbe?: ConfirmationProbe
  /** Display name for this scheduler location; adapters may set a truthful value. */
  location?: string
  /** Optional Cloudflare Email Routing binding adapter. */
  cloudflareEmail?: CloudflareEmailSender
  log: Logger
  /** Runs a promise after the response is sent where the platform supports it. */
  waitUntil?: (p: Promise<unknown>) => void
}

export interface CreateDepsOptions {
  db: Db
  config: StatusPingConfig
  getEnv: EnvGetter
  fetch?: typeof fetch
  log?: Logger
  certificateExpiry?: CertificateExpiryProvider
  tcpConnect?: TcpConnector
  confirmationProbe?: ConfirmationProbe
  location?: string
  cloudflareEmail?: CloudflareEmailSender
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
  const config = normalizeConfig(resolveConfigEnv(opts.config, opts.getEnv))
  if (config.monitors.some((monitor) => monitor.escalation) && !opts.getEnv('ACK_SECRET')) {
    throw new Error('ACK_SECRET must be set when escalation is configured')
  }
  if (config.subscribers && !opts.getEnv('SUBSCRIBER_TOKEN_SECRET')) {
    throw new Error('SUBSCRIBER_TOKEN_SECRET must be set when subscribers are configured')
  }
  return {
    db: opts.db,
    config,
    configInput: opts.config,
    adminEnabled: opts.config.admin === true,
    role: roleEnv,
    getEnv: opts.getEnv,
    pingTokens: parsePingTokens(opts.getEnv('PING_TOKENS')),
    // Bind: Workers throw "Illegal invocation" when fetch is called detached from globalThis.
    fetch: opts.fetch ?? fetch.bind(globalThis),
    certificateExpiry: opts.certificateExpiry,
    tcpConnect: opts.tcpConnect,
    confirmationProbe: opts.confirmationProbe,
    location: opts.location,
    cloudflareEmail: opts.cloudflareEmail,
    log: opts.log ?? consoleLogger,
  }
}

/**
 * Loads the one DB-backed configuration only when the operator explicitly enables admin mode.
 * In ordinary mode this is a no-op, leaving statusping.config.ts / STATUSPING_CONFIG authoritative.
 * Call after migrations, before work that reads `deps.config`.
 */
export async function refreshAdminConfig(deps: Deps, now: number): Promise<boolean> {
  if (!deps.adminEnabled) return false
  let stored = await loadAdminConfig(deps.db)
  if (!stored) {
    // Validate before persisting: literal credentials never enter admin_config or audit_log.
    const validated = validateAdminConfig({ ...deps.configInput, admin: true }, deps.getEnv)
    await seedAdminConfig(deps.db, validated.config, 'config-seed', now)
    stored = await loadAdminConfig(deps.db)
  }
  if (!stored) throw new Error('admin config seed was not stored')
  const validated = validateAdminConfig(stored.config, deps.getEnv)
  deps.config = validated.normalized
  deps.configInput = validated.config
  return true
}
