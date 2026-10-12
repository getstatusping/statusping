import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { canAcknowledge, type Viewer } from '../auth/viewer.ts'
import { type EnvGetter, type EnvRef, isReservedEnv, type NormalizedConfig, normalizeConfig, resolveConfigEnv, type StatusPingConfig } from '../config.ts'
import type { Db } from '../db/types.ts'
import { randomToken, sha256Hex, timingSafeEqual } from '../util/crypto.ts'
import { TENANT_ENV, clampToTenantPolicy, explicitIntervalIds, parseTenantPolicy, tenantPolicyProblems } from '../platform.ts'

/** Configuration accepted by the browser admin.  It is opt-in on purpose. */
export type AdminConfig = StatusPingConfig & { admin?: boolean }

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/
const SENSITIVE_NAME = /(?:authorization|cookie|api[-_]?key|token|secret|password|credential)/i

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * Where a secret reference appears decides which names it may read. A reference resolves to a
 * real value that may be sent somewhere (a webhook header, a monitor URL), so:
 * - StatusPing's own server secrets are never readable (isReservedEnv);
 * - sign-in settings (OIDC_*, CF_ACCESS_AUD) only from the sign-in method;
 * - a channel's saved credential (SINK_<NAME>_<FIELD>) only from the field it was saved for, so a
 *   channel can't be retyped to send its own stored credential somewhere else.
 */
type RefScope = { kind: 'provider' } | { kind: 'sink'; name: string; field: string | null } | { kind: 'other' }
const SIGN_IN_ENV = /^(OIDC_[A-Z0-9_]+|CF_ACCESS_AUD)$/
const sinkEnv = (name: string, field: string) => `SINK_${name}_${field}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_')

function envRef(value: unknown, path: string, problems: string[], scope: RefScope = { kind: 'other' }): value is EnvRef {
  const ref = record(value)
  if (!ref || typeof ref.$env !== 'string' || !ENV_NAME.test(ref.$env) || Object.keys(ref).some((key) => key !== '$env' && key !== 'optional')) {
    problems.push(`${path}: must be a secret reference, { $env: NAME }`)
    return false
  }
  const name = ref.$env
  if (isReservedEnv(name)) {
    problems.push(`${path}: ${name} is a server secret and cannot be referenced`)
    return false
  }
  if (SIGN_IN_ENV.test(name) && scope.kind !== 'provider') {
    problems.push(`${path}: ${name} belongs to the sign-in method and cannot be referenced here`)
    return false
  }
  if (name.startsWith('SINK_') && !(scope.kind === 'sink' && scope.field !== null && name === sinkEnv(scope.name, scope.field))) {
    problems.push(`${path}: ${name} is a saved channel credential and can only be used by the field it was saved for`)
    return false
  }
  if (ref.optional !== undefined && typeof ref.optional !== 'boolean') problems.push(`${path}.optional: must be a boolean`)
  return true
}

/** A literal URL must not carry a credential (user:password, or a token-like query parameter). */
function literalUrl(value: string, path: string, problems: string[]): void {
  try {
    const url = new URL(value)
    if (url.username || url.password || [...url.searchParams.keys()].some((key) => SENSITIVE_NAME.test(key))) {
      problems.push(`${path}: contains a credential. Store the URL as a secret and write { $env: NAME } instead`)
    }
  } catch { /* normalizeConfig reports malformed URLs */ }
}

/** Header values: literal text, or { $env: NAME }. Credential-bearing headers must use $env. */
function headerValues(value: unknown, path: string, problems: string[], scope: RefScope = { kind: 'other' }): void {
  if (value === undefined) return
  const headers = record(value)
  if (!headers) { problems.push(`${path}: must be an object`); return }
  for (const [header, item] of Object.entries(headers)) {
    if (typeof item === 'string') {
      if (SENSITIVE_NAME.test(header)) problems.push(`${path}.${header}: holds a credential. Store it as a secret and write { $env: NAME } instead`)
    } else envRef(item, `${path}.${header}`, problems, scope)
  }
}

/**
 * The browser never receives a secret value.  This deliberately narrows the editable surface:
 * credentials must be EnvRef objects ({ $env: NAME }); a literal URL or header that looks like it
 * carries a credential is refused rather than stored.
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
    const scope = (field: string | null): RefScope => ({ kind: 'sink', name, field })
    const ref = (key: string) => envRef(sink[key], `sinks.${name}.${key}`, problems, scope(key))
    switch (sink.type) {
      case 'pushover': ref('appToken'); ref('userKey'); break
      case 'ntfy':
        ref('topic')
        if (sink.token !== undefined) ref('token')
        break
      case 'telegram': ref('botToken'); ref('chatId'); break
      case 'discord': ref('webhookUrl'); break
      case 'teams': case 'googlechat': case 'mattermost': ref('webhookUrl'); break
      case 'matrix': ref('accessToken'); break
      case 'gotify': ref('token'); break
      case 'pagerduty': ref('routingKey'); break
      case 'slack': ref('webhookUrl'); break
      case 'email': {
        const via = sink.via
        if (via && typeof via === 'object' && !Array.isArray(via) && (via as Record<string, unknown>).provider === 'resend') {
          envRef((via as Record<string, unknown>).apiKey, `sinks.${name}.via.apiKey`, problems, scope('apiKey'))
        }
        if (via && typeof via === 'object' && !Array.isArray(via) && (via as Record<string, unknown>).provider === 'smtp' && (via as Record<string, unknown>).password !== undefined) {
          envRef((via as Record<string, unknown>).password, `sinks.${name}.via.password`, problems, scope('password'))
        }
        break
      }
      case 'webhook': {
        // A credential in the URL or a header must be a secret: { $env: NAME }, never a literal.
        if (typeof sink.url === 'string') literalUrl(sink.url, `sinks.${name}.url`, problems)
        else if (sink.url === undefined) problems.push(`sinks.${name}.url: must be a URL or { $env: NAME }`)
        else envRef(sink.url, `sinks.${name}.url`, problems, scope('url'))
        headerValues(sink.headers, `sinks.${name}.headers`, problems, scope(null))
        if (sink.secret !== undefined) envRef(sink.secret, `sinks.${name}.secret`, problems, scope('secret'))
        break
      }
    }
  }
  const subscribers = record(config.subscribers)
  if (subscribers?.provider === 'resend') envRef(subscribers.apiKey, 'subscribers.apiKey', problems)
  const access = record(config.access)
  const provider = record(access?.provider)
  if (provider?.type === 'cloudflare-access') envRef(provider.audience, 'access.provider.audience', problems, { kind: 'provider' })
  if (provider?.type === 'oidc') {
    envRef(provider.clientSecret, 'access.provider.clientSecret', problems, { kind: 'provider' })
    if (provider.clientId !== undefined && typeof provider.clientId !== 'string') envRef(provider.clientId, 'access.provider.clientId', problems, { kind: 'provider' })
  }
  const peer = record(config.peer)
  if (peer?.pingUrl !== undefined && peer.pingUrl !== null) envRef(peer.pingUrl, 'peer.pingUrl', problems)
  for (const [groupIndex, groupValue] of (Array.isArray(config.groups) ? config.groups : []).entries()) {
    const group = record(groupValue)
    for (const [monitorIndex, monitorValue] of (Array.isArray(group?.monitors) ? group!.monitors : []).entries()) {
      const monitor = record(monitorValue)
      if (!monitor) continue
      if (monitor.kind === 'http') {
        const path = `groups.${groupIndex}.monitors.${monitorIndex}`
        headerValues(monitor.headers, `${path}.headers`, problems)
        if (typeof monitor.url === 'string') literalUrl(monitor.url, `${path}.url`, problems)
        else if (monitor.url !== undefined) envRef(monitor.url, `${path}.url`, problems)
      }
    }
  }
  return problems
}

/** Every { $env: NAME } the configuration names, with the places it is used. */
export function envReferences(value: unknown): Array<{ name: string; paths: string[] }> {
  const found = new Map<string, string[]>()
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) { node.forEach((item, index) => walk(item, `${path}[${index}]`)); return }
    const obj = record(node)
    if (!obj) return
    if (typeof obj.$env === 'string') { found.set(obj.$env, [...(found.get(obj.$env) ?? []), path]); return }
    for (const [key, item] of Object.entries(obj)) walk(item, path ? `${path}.${key}` : key)
  }
  walk(value, '')
  return [...found].map(([name, paths]) => ({ name, paths })).sort((a, b) => a.name.localeCompare(b.name))
}

export interface AdminConfigValidation {
  config: AdminConfig
  normalized: NormalizedConfig
}

/**
 * Validates a JSON-shaped admin config without resolving or returning secret values. On a hosted
 * tenant, a save over the plan's limits is rejected; loading an already-stored config instead
 * fits it into the plan, so a downgrade never takes the site down.
 */
export function validateAdminConfig(value: unknown, getEnv: EnvGetter, mode: 'save' | 'load' = 'save'): AdminConfigValidation {
  const config = record(value)
  if (!config) throw new Error('config: must be an object')
  const admin = config.admin
  if (admin !== undefined && typeof admin !== 'boolean') throw new Error('admin: must be a boolean')
  const problems = validateAdminSecrets(config)
  if (problems.length) throw new Error(`Unsafe admin config:\n  - ${problems.join('\n  - ')}`)
  try {
    // Environment-backed monitor URLs need a harmless placeholder during validation.  Their
    // actual value stays in the environment and is resolved only when the config becomes active.
    const normalized = normalizeConfig(resolveConfigEnv(config as unknown as StatusPingConfig, getEnv, true))
    const tenant = parseTenantPolicy(getEnv(TENANT_ENV))
    if (!tenant) return { config: config as unknown as AdminConfig, normalized }
    if (mode === 'save') {
      const overLimit = tenantPolicyProblems(normalized, tenant, explicitIntervalIds(config as unknown as StatusPingConfig))
      if (overLimit.length) throw new Error(`Over your plan's limits:\n  - ${overLimit.join('\n  - ')}`)
    }
    return { config: config as unknown as AdminConfig, normalized: clampToTenantPolicy(normalized, tenant) }
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
 * The credential a browser signed in with: StatusPing's session cookie, or the Cloudflare
 * Access token for Access sign-in (Access authenticates every request and sets no session).
 */
function signInBinding(c: Context): string | undefined {
  return getCookie(c, 'sp_session') ?? getCookie(c, 'CF_Authorization') ?? c.req.header('cf-access-jwt-assertion') ?? getCookie(c, 'sp_recover')
}

/**
 * Per-session CSRF token, derived from the sign-in credential. That credential is HttpOnly (or
 * an Access token a cross-site page cannot read), so the token cannot be forged; and because it
 * is stable for the session, forms stay valid across pages, tabs, and the Back button. API
 * bearer-token requests are not cookie-authenticated and do not use this mechanism.
 */
export async function issueCsrfToken(_db: Db, c: Context, _now: number): Promise<string | null> {
  const session = signInBinding(c)
  return session ? sha256Hex(`statusping-csrf:${session}`) : null
}

export async function verifyCsrfToken(db: Db, c: Context, token: unknown, now: number): Promise<boolean> {
  if (typeof token !== 'string' || token.length < 32) return false
  const expected = await issueCsrfToken(db, c, now)
  return expected !== null && timingSafeEqual(token, expected)
}

