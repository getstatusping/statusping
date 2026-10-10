import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { canAcknowledge, type Viewer } from '../auth/viewer.ts'
import { type EnvGetter, type EnvRef, type NormalizedConfig, normalizeConfig, resolveConfigEnv, type StatusPingConfig } from '../config.ts'
import type { Db } from '../db/types.ts'
import { randomToken, sha256Hex, timingSafeEqual } from '../util/crypto.ts'

/** Configuration accepted by the browser admin.  It is opt-in on purpose. */
export type AdminConfig = StatusPingConfig & { admin?: boolean }

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/
const SENSITIVE_NAME = /(?:authorization|cookie|api[-_]?key|token|secret|password|credential)/i

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function envRef(value: unknown, path: string, problems: string[]): value is EnvRef {
  const ref = record(value)
  if (!ref || typeof ref.$env !== 'string' || !ENV_NAME.test(ref.$env) || Object.keys(ref).some((key) => key !== '$env' && key !== 'optional')) {
    problems.push(`${path}: must be an env(NAME) reference when edited through admin`)
    return false
  }
  if (ref.optional !== undefined && typeof ref.optional !== 'boolean') problems.push(`${path}.optional: must be a boolean`)
  return true
}

/**
 * The browser never receives a secret value.  This deliberately narrows the editable surface:
 * credentials must be EnvRef objects, and arbitrary webhook headers/credential-bearing URLs are
 * config-as-code only.  That is safer than trying to guess whether a text box contains a secret.
 */
export function validateAdminSecrets(value: unknown): string[] {
  const problems: string[] = []
  const config = record(value)
  if (!config) return ['config: must be an object']
  const sinks = record(config.sinks)
  if (config.sinks !== undefined && !sinks) problems.push('sinks: must be an object')
  for (const [name, raw] of Object.entries(sinks ?? {})) {
    const sink = record(raw)
    if (!sink || typeof sink.type !== 'string') { problems.push(`sinks.${name}: must be an object`); continue }
    const ref = (key: string) => envRef(sink[key], `sinks.${name}.${key}`, problems)
    switch (sink.type) {
      case 'pushover': ref('appToken'); ref('userKey'); break
      case 'ntfy':
        ref('topic')
        if (sink.token !== undefined) ref('token')
        break
      case 'telegram': ref('botToken'); ref('chatId'); break
      case 'discord': ref('webhookUrl'); break
      case 'slack': ref('webhookUrl'); break
      case 'email': {
        const via = sink.via
        if (via && typeof via === 'object' && !Array.isArray(via) && (via as Record<string, unknown>).provider === 'resend') {
          envRef((via as Record<string, unknown>).apiKey, `sinks.${name}.via.apiKey`, problems)
        }
        break
      }
      case 'webhook': {
        // `url` and custom headers can carry credentials.  Keep them config-as-code until the
        // runtime has a dedicated secret reference type for webhook URLs and header values.
        if (sink.headers !== undefined) problems.push(`sinks.${name}.headers: arbitrary webhook headers are not editable in admin`)
        if (typeof sink.url !== 'string') problems.push(`sinks.${name}.url: must be a URL string`)
        else {
          try {
            const url = new URL(sink.url)
            if (url.username || url.password || [...url.searchParams.keys()].some((key) => SENSITIVE_NAME.test(key))) {
              problems.push(`sinks.${name}.url: credential-bearing URLs are not editable in admin`)
            }
          } catch { /* normalizeConfig provides the ordinary URL error */ }
        }
        if (sink.secret !== undefined) envRef(sink.secret, `sinks.${name}.secret`, problems)
        break
      }
    }
  }
  const subscribers = record(config.subscribers)
  if (subscribers?.provider === 'resend') envRef(subscribers.apiKey, 'subscribers.apiKey', problems)
  const access = record(config.access)
  const provider = record(access?.provider)
  if (provider?.type === 'cloudflare-access') envRef(provider.audience, 'access.provider.audience', problems)
  if (provider?.type === 'oidc') envRef(provider.clientSecret, 'access.provider.clientSecret', problems)
  const peer = record(config.peer)
  if (peer?.pingUrl !== undefined && peer.pingUrl !== null) envRef(peer.pingUrl, 'peer.pingUrl', problems)
  for (const [groupIndex, groupValue] of (Array.isArray(config.groups) ? config.groups : []).entries()) {
    const group = record(groupValue)
    for (const [monitorIndex, monitorValue] of (Array.isArray(group?.monitors) ? group!.monitors : []).entries()) {
      const monitor = record(monitorValue)
      if (!monitor) continue
      if (monitor.kind === 'http') {
        const headers = record(monitor.headers)
        for (const [header] of Object.entries(headers ?? {})) {
          if (SENSITIVE_NAME.test(header)) problems.push(`groups.${groupIndex}.monitors.${monitorIndex}.headers.${header}: credential-bearing headers are not editable in admin`)
        }
        if (typeof monitor.url === 'string') {
          try {
            const url = new URL(monitor.url)
            if (url.username || url.password || [...url.searchParams.keys()].some((key) => SENSITIVE_NAME.test(key))) {
              problems.push(`groups.${groupIndex}.monitors.${monitorIndex}.url: credential-bearing URLs are not editable in admin`)
            }
          } catch { /* normal validation below */ }
        }
      }
    }
  }
  return problems
}

export interface AdminConfigValidation {
  config: AdminConfig
  normalized: NormalizedConfig
}

/** Validates a JSON-shaped admin config without resolving or returning secret values. */
export function validateAdminConfig(value: unknown, getEnv: EnvGetter): AdminConfigValidation {
  const config = record(value)
  if (!config) throw new Error('config: must be an object')
  const admin = config.admin
  if (admin !== undefined && typeof admin !== 'boolean') throw new Error('admin: must be a boolean')
  const problems = validateAdminSecrets(config)
  if (problems.length) throw new Error(`Unsafe admin config:\n  - ${problems.join('\n  - ')}`)
  try {
    // Environment-backed monitor URLs need a harmless placeholder during validation.  Their
    // actual value stays in the environment and is resolved only when the config becomes active.
    return {
      config: config as unknown as AdminConfig,
      normalized: normalizeConfig(resolveConfigEnv(config as unknown as StatusPingConfig, getEnv, true)),
    }
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error))
  }
}

export function isAdminEnabled(config: AdminConfig | { admin?: boolean }): boolean {
  return config.admin === true
}

export function canAdmin(viewer: Viewer | null, config: NormalizedConfig): boolean {
  return canAcknowledge(viewer, config.access)
}

/** Token-based API auth intentionally returns false when ADMIN_TOKEN is not configured. */
export function authorizeAdminToken(header: string | undefined, getEnv: EnvGetter): boolean {
  const token = getEnv('ADMIN_TOKEN')
  return Boolean(token && timingSafeEqual(header ?? '', `Bearer ${token}`))
}

/**
 * Per-session CSRF token. The token is stored hashed, bound to the HttpOnly session cookie, and
 * can be safely placed in a form. API bearer-token requests are not cookie-authenticated and do
 * not use this mechanism.
 */
export async function issueCsrfToken(db: Db, c: Context, now: number): Promise<string | null> {
  const session = getCookie(c, 'sp_session')
  if (!session) return null
  const sessionHash = await sha256Hex(session)
  const token = randomToken(32)
  await db.run(
    `INSERT INTO admin_csrf (session_hash, token_hash, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(session_hash) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at`,
    [sessionHash, await sha256Hex(token), now + 3600],
  )
  return token
}

export async function verifyCsrfToken(db: Db, c: Context, token: unknown, now: number): Promise<boolean> {
  if (typeof token !== 'string' || token.length < 32) return false
  const session = getCookie(c, 'sp_session')
  if (!session) return false
  const sessionHash = await sha256Hex(session)
  const row = await db.first<{ token_hash: string; expires_at: number }>(
    `SELECT token_hash, expires_at FROM admin_csrf WHERE session_hash = ?`, [sessionHash],
  )
  if (!row || row.expires_at < now || !timingSafeEqual(row.token_hash, await sha256Hex(token))) return false
  await db.run(`DELETE FROM admin_csrf WHERE session_hash = ?`, [sessionHash])
  return true
}

