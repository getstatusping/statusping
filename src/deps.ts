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
import type { CloudflareEmailSender } from './notify/sinks.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type Logger = (level: LogLevel, message: string, data?: Record<string, unknown>) => void

export interface Deps {
  db: Db
  config: NormalizedConfig
  role: Role
  getEnv: EnvGetter
  /** monitor id → ping token (secret), from the PING_TOKENS env var. */
  pingTokens: Record<string, string>
  fetch: typeof fetch
  /** Optional runtime-native certificate provider. Workers intentionally omit this. */
  certificateExpiry?: CertificateExpiryProvider
  /** Raw TCP connector supplied by the active runtime adapter. */
  tcpConnect?: TcpConnector
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
  return {
    db: opts.db,
    config,
    role: roleEnv,
    getEnv: opts.getEnv,
    pingTokens: parsePingTokens(opts.getEnv('PING_TOKENS')),
    // Bind: Workers throw "Illegal invocation" when fetch is called detached from globalThis.
    fetch: opts.fetch ?? fetch.bind(globalThis),
    certificateExpiry: opts.certificateExpiry,
    tcpConnect: opts.tcpConnect,
    cloudflareEmail: opts.cloudflareEmail,
    log: opts.log ?? consoleLogger,
  }
}
