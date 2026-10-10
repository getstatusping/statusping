import { Cron } from 'croner'
import { parseJsonPath } from './evaluate/json.ts'
import { isValidTimeZone, parseDuration } from './util/time.ts'

// ─── Public config types (what users write in statusping.config.ts) ────────────────────────

export type Duration = number | string
/** Values accepted by JSON response assertions. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export interface EnvRef {
  readonly $env: string
  readonly optional?: boolean
}
/** A literal value or a reference to an environment variable / secret. */
export type Secret = string | EnvRef

/** Reference an environment variable (Worker secret, process env var) resolved at runtime. */
export function env(name: string, opts: { optional?: boolean } = {}): EnvRef {
  return { $env: name, optional: opts.optional }
}

interface MonitorBase {
  /** Stable slug; used in URLs and the database. Renaming it starts a new history. */
  id: string
  name: string
  description?: string
  /** Sink names; defaults to `defaults.notify`. */
  notify?: string[]
  /** Also checked by the watchdog instance (see plan §8.3). */
  critical?: boolean
  /** Repeat an unresolved outage alert at this interval. Off unless set here or in defaults. */
  renotifyEvery?: Duration
  /** Maximum number of repeated alerts for one incident. Omit for no cap. */
  renotifyMax?: number
}

/** Detail fields that can be shown on the status page. The current status is always shown. */
export const DETAIL_FIELDS = [
  'uptime', // uptime % and 90-day bars
  'schedule', // period / cron, grace, max runtime, check interval, timeout
  'incidents', // incident list: reason, start, duration
  'errors', // failure text: incident details, last error, check error messages
  'pings', // ping history: time, signal, exit code, run duration
  'logs', // log bodies sent with pings
  'checks', // HTTP check history: time, ok/fail, status code
  'response-time', // response times
  'target', // HTTP check URL, method, keyword
] as const
export type DetailField = (typeof DETAIL_FIELDS)[number]
export type FieldList = DetailField[] | 'all'

/** Who may open a page: everyone, or signed-in users matching emails / SSO groups / teams. */
export type PageAccess = 'public' | (MatchInput & { teams?: string[] })

/**
 * A status page: which monitors it shows, which fields, and who may open it. A monitor can
 * appear on any number of pages. Pages are served at /pages/<slug>; `home` is also served at /.
 */
export interface PageInput {
  slug: string
  title: string
  description?: string
  /** Default 'public'. Anything else requires `access.provider`. */
  access?: PageAccess
  /** Default: ['uptime', 'incidents'] on public pages, 'all' on restricted pages. */
  show?: FieldList
  /** Monitor ids, 'group:<group name>', or '*' for all monitors. */
  monitors: string[]
}

/** Shared fields for planned maintenance windows. */
interface MaintenanceBaseInput {
  /** Short description shown on the status page, e.g. "Database upgrade". */
  title: string
  /** Monitor ids affected by this window, or `*` for every monitor. */
  monitors: string[] | '*'
  /** Do not count this window's downtime against affected monitors' uptime. Default true. */
  excludeFromUptime?: boolean
}

/** A maintenance window with fixed ISO-8601 start and end times. */
export interface OneOffMaintenanceInput extends MaintenanceBaseInput {
  start: string
  end: string
}

/** A recurring maintenance window, evaluated in `tz` (or the instance timezone). */
export interface RecurringMaintenanceInput extends MaintenanceBaseInput {
  schedule: string
  tz?: string
  duration: Duration
}

export type MaintenanceInput = OneOffMaintenanceInput | RecurringMaintenanceInput

export interface PushMonitorInput extends MonitorBase {
  kind: 'push'
  /** Expected time between pings (interval mode). */
  period?: Duration
  /** Cron expression (cron mode), evaluated in `tz`. */
  schedule?: string
  tz?: string
  /** Extra time after the expected ping before alerting. */
  grace?: Duration
  /** Alert when a `/start` is not followed by a finish signal within this time. */
  maxRuntime?: Duration
}

export interface HttpMonitorInput extends MonitorBase {
  kind: 'http'
  /** A URL, or env('NAME') — e.g. the other instance's /healthz in a primary/watchdog pair. */
  url: string | EnvRef
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Whole minutes; default `'1m'`. */
  interval?: Duration
  /** Default `'10s'`, max `'30s'`. */
  timeout?: Duration
  /** Accepted status codes, e.g. `[200, 204]` or `'200-399'`. Default `'200-299'`. */
  expectStatus?: number[] | string
  /** Response body must contain this text. */
  keyword?: string
  /** If true, the body must NOT contain `keyword`. */
  invertKeyword?: boolean
  /** Assertions evaluated against a JSON response body. */
  json?: JsonAssertionInput[]
  /** Consecutive failed checks tolerated before marking down. Default 0. */
  retries?: number
  /** Certificate-expiry warnings. Enabled by default for HTTPS monitors; set false to disable. */
  sslExpiry?: false | { warnDays?: number[] }
  /** Domain-registration expiry warnings. Disabled unless configured. */
  domainExpiry?: { warnDays?: number[] }
}

/** One deliberately small JSONPath assertion. Exactly one operator must be supplied. */
export interface JsonAssertionInput {
  /** Dot properties, quoted bracket properties, and numeric array indexes are supported. */
  path: string
  equals?: JsonValue
  notEquals?: JsonValue
  contains?: JsonValue
  lessThan?: number
  greaterThan?: number
  exists?: boolean
}

export interface TcpMonitorInput extends MonitorBase {
  kind: 'tcp'
  host: string
  port: number
  interval?: Duration
  timeout?: Duration
  /** Consecutive failed checks tolerated before marking down. Default 0. */
  retries?: number
}

export type MonitorInput = PushMonitorInput | HttpMonitorInput | TcpMonitorInput

export interface PushoverSinkInput {
  type: 'pushover'
  appToken: Secret
  userKey: Secret
  device?: string
  sound?: string
  /** Send down alerts with emergency priority (repeats until acknowledged). */
  emergency?: boolean
}
export interface NtfySinkInput {
  type: 'ntfy'
  topic: Secret
  /** Default `https://ntfy.sh`. */
  server?: string
  /** Strongly recommended: ntfy.sh rate-limits anonymous senders by (shared) IP. */
  token?: Secret
}
export interface TelegramSinkInput {
  type: 'telegram'
  botToken: Secret
  chatId: Secret
}
export interface WebhookSinkInput {
  type: 'webhook'
  url: string
  headers?: Record<string, string>
  /** HMAC-SHA256 signing secret. Sent as X-StatusPing-Signature when configured. */
  secret?: Secret
}
export interface DiscordSinkInput {
  type: 'discord'
  webhookUrl: Secret
}
export interface SlackSinkInput {
  type: 'slack'
  webhookUrl: Secret
}
export interface EmailSinkInput {
  type: 'email'
  /** Recipients must be verified when using Cloudflare Email Routing. */
  to: string[]
  via: 'cloudflare' | { provider: 'resend'; apiKey: Secret; from: string }
}
export type SinkInput = PushoverSinkInput | NtfySinkInput | TelegramSinkInput | WebhookSinkInput | DiscordSinkInput | SlackSinkInput | EmailSinkInput

export type AuthProviderInput =
  /** Per-user email + password from the BASIC_AUTH_USERS secret (`npm run cli -- add-user`). */
  | { type: 'basic' }
  /** Cloudflare Access in front of /internal/*; the Worker verifies the Access JWT. */
  | { type: 'cloudflare-access'; teamDomain: string; audience: Secret }
  /** OpenID Connect SSO (Google, Okta, Microsoft Entra, Auth0, Keycloak, …). */
  | {
      type: 'oidc'
      issuer: string
      clientId: Secret
      clientSecret: Secret
      /** ID-token claim holding group names. Default 'groups'. */
      groupsClaim?: string
      /** Default ['openid', 'email', 'profile']. Add e.g. 'groups' if your IdP needs it. */
      scopes?: string[]
    }

/** Who matches: emails (exact or `*@domain.com`) and — SSO only — groups. */
export interface MatchInput {
  emails?: string[]
  groups?: string[]
}

export interface AccessInput {
  provider: AuthProviderInput
  /** Named, reusable member lists for page access: `access: { teams: ['ops'] }`. */
  teams?: Record<string, MatchInput>
  /** SSO session length in hours. Default 12. */
  sessionHours?: number
}

export interface StatusPingConfig {
  title: string
  /** Public URL of this instance, used in alert links and ping URLs. */
  baseUrl: string
  description?: string
  /** IANA timezone used for times on the status page and in alerts. Default UTC. */
  timezone?: string
  sinks?: Record<string, SinkInput>
  defaults?: { notify?: string[]; grace?: Duration; renotifyEvery?: Duration; renotifyMax?: number }
  /** Monitor definitions. Group names become the sections on pages. */
  groups: { name: string; monitors: MonitorInput[] }[]
  /** Status pages. Default: one public page with all monitors, showing uptime + incidents. */
  pages?: PageInput[]
  /** Planned windows: alerts are muted and affected monitors show Maintenance while active. */
  maintenance?: MaintenanceInput[]
  /** Slug of the page served at "/". Default: the first public page. */
  home?: string
  /** How people sign in to restricted pages. */
  access?: AccessInput
  /** Primary ↔ watchdog pairing (plan §8.3). */
  peer?: {
    /** Ping URL of the push monitor on the *other* instance that watches this one. */
    pingUrl?: Secret
    /** Local push monitor that receives the other instance's heartbeat. */
    heartbeatMonitor?: string
    /** Optional local HTTP monitor that checks the other instance's /healthz. */
    healthMonitor?: string
  }
  limits?: {
    /** Cloudflare's free plan allows 50 subrequests per invocation; keep headroom. Default 35. */
    maxChecksPerTick?: number
    /** Stop starting new checks after this many ms in one tick. Default 20000. */
    tickBudgetMs?: number
  }
}

export function defineConfig(config: StatusPingConfig): StatusPingConfig {
  return config
}

/**
 * Parses the JSON form used by deployments which cannot ship a TypeScript config file.
 * Keep this deliberately small: structural and semantic validation remains in
 * normalizeConfig(), so both config sources produce the same validation errors.
 */
export function parseJsonConfig(raw: string, source = 'STATUSPING_CONFIG'): StatusPingConfig {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${(error as Error).message}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} must be a JSON object`)
  }
  return value as StatusPingConfig
}

/** Returns the runtime JSON configuration, with a useful error if it is absent. */
export function configFromEnv(getEnv: EnvGetter): StatusPingConfig {
  const raw = getEnv('STATUSPING_CONFIG')
  if (!raw) throw new Error('STATUSPING_CONFIG is not set')
  return parseJsonConfig(raw)
}

/** Prefer a checked-in TypeScript config when one is available (the Node adapter). */
export function selectConfig(fileConfig: StatusPingConfig | undefined, getEnv: EnvGetter): StatusPingConfig {
  return fileConfig ?? configFromEnv(getEnv)
}

// ─── Normalized form ────────────────────────────────────────────────────────────────────────

interface NormalizedBase {
  id: string
  name: string
  description: string | null
  group: string
  order: number
  notify: string[]
  critical: boolean
  /** Seconds between repeat alerts, or null when repeat alerts are disabled. */
  renotifyEvery: number | null
  /** Maximum repeats per incident, or null for no cap. */
  renotifyMax: number | null
}
export interface PushMonitor extends NormalizedBase {
  kind: 'push'
  period: number | null
  schedule: string | null
  tz: string
  grace: number
  maxRuntime: number | null
}
export interface HttpMonitor extends NormalizedBase {
  kind: 'http'
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
  intervalMin: number
  timeoutMs: number
  expectStatus: [number, number][]
  keyword: string | null
  invertKeyword: boolean
  json: NormalizedJsonAssertion[]
  retries: number
  /** Days before expiry which open an amber certificate warning. */
  sslWarnDays: number[] | null
  /** Days before expiry which open an amber domain-registration warning. */
  domainWarnDays: number[] | null
}
export interface NormalizedJsonAssertion {
  path: string
  operator: 'equals' | 'notEquals' | 'contains' | 'lessThan' | 'greaterThan' | 'exists'
  expected: JsonValue | boolean
}
export interface TcpMonitor extends NormalizedBase {
  kind: 'tcp'
  host: string
  port: number
  intervalMin: number
  timeoutMs: number
  retries: number
}
export type Monitor = PushMonitor | HttpMonitor | TcpMonitor

export type Role = 'primary' | 'watchdog'

export interface NormalizedMatch {
  emails: string[]
  groups: string[]
}
export interface NormalizedAccess {
  provider: AuthProviderInput
  teams: Record<string, NormalizedMatch>
  sessionHours: number
}

export interface NormalizedPage {
  slug: string
  title: string
  description: string | null
  access: 'public' | (NormalizedMatch & { teams: string[] })
  show: DetailField[]
  /** Monitor ids in display order. */
  monitorIds: string[]
}

interface NormalizedMaintenanceBase {
  title: string
  /** Affected monitor ids in display order. */
  monitors: string[]
  excludeFromUptime: boolean
}

export interface OneOffMaintenance extends NormalizedMaintenanceBase {
  kind: 'one-off'
  /** Unix epoch seconds. */
  start: number
  /** Unix epoch seconds. */
  end: number
}

export interface RecurringMaintenance extends NormalizedMaintenanceBase {
  kind: 'recurring'
  schedule: string
  tz: string
  /** Seconds. */
  duration: number
}

export type NormalizedMaintenance = OneOffMaintenance | RecurringMaintenance

export interface NormalizedConfig {
  title: string
  baseUrl: string
  description: string | null
  timezone: string
  sinks: Record<string, SinkInput>
  monitors: Monitor[]
  peer: { pingUrl: Secret | null; heartbeatMonitor: string | null; healthMonitor: string | null }
  limits: { maxChecksPerTick: number; tickBudgetMs: number }
  access: NormalizedAccess | null
  pages: NormalizedPage[]
  home: string | null
  maintenance: NormalizedMaintenance[]
}

export class ConfigError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`Invalid StatusPing config:\n  - ${problems.join('\n  - ')}`)
    this.problems = problems
  }
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/i

export const DEFAULT_PUBLIC_FIELDS: DetailField[] = ['uptime', 'incidents']

function resolveFields(list: FieldList, where: string, problems: string[]): DetailField[] {
  if (list === 'all') return [...DETAIL_FIELDS]
  const bad = list.filter((f) => !(DETAIL_FIELDS as readonly string[]).includes(f))
  if (bad.length) problems.push(`${where}: unknown field(s) ${bad.join(', ')} (allowed: ${DETAIL_FIELDS.join(', ')}, or 'all')`)
  return [...new Set(list.filter((f) => (DETAIL_FIELDS as readonly string[]).includes(f)))]
}

function parseStatusRanges(input: number[] | string | undefined): [number, number][] {
  if (input === undefined) return [[200, 299]]
  if (Array.isArray(input)) return input.map((c) => [c, c])
  return input.split(',').map((part) => {
    const [lo, hi] = part.trim().split('-').map((n) => Number(n.trim()))
    if (!Number.isInteger(lo) || (hi !== undefined && !Number.isInteger(hi))) {
      throw new Error(`invalid expectStatus "${input}"`)
    }
    return [lo!, hi ?? lo!]
  })
}

function normalizeWarnDays(input: number[] | undefined, fallback: number[], where: string, fail: (message: string) => void): number[] {
  const days = input ?? fallback
  if (!Array.isArray(days) || days.some((day) => !Number.isInteger(day) || day <= 0)) {
    fail(`${where}.warnDays must be an array of positive whole days`)
    return []
  }
  if (new Set(days).size !== days.length) fail(`${where}.warnDays must not contain duplicates`)
  return [...days].sort((a, b) => b - a)
}

const JSON_OPERATORS = ['equals', 'notEquals', 'contains', 'lessThan', 'greaterThan', 'exists'] as const

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(isJsonValue)
}

function isEmail(value: unknown): value is string {
  return typeof value === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
}

function isMailbox(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = value.match(/^.*<([^<>]+)>$/)
  return isEmail(match ? match[1] : value)
}

function normalizeJsonAssertions(input: unknown, fail: (message: string) => void): NormalizedJsonAssertion[] {
  if (input === undefined) return []
  if (!Array.isArray(input)) {
    fail('json must be an array of assertions')
    return []
  }
  const assertions: NormalizedJsonAssertion[] = []
  for (const [index, assertion] of input.entries()) {
    const where = `json[${index}]`
    if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) {
      fail(`${where} must be an object`)
      continue
    }
    const record = assertion as Record<string, unknown>
    if (typeof record.path !== 'string' || !record.path) {
      fail(`${where}.path must be a non-empty JSONPath string`)
      continue
    }
    try {
      parseJsonPath(record.path)
    } catch (error) {
      fail(`${where}.path "${record.path}" is not supported: ${(error as Error).message}`)
      continue
    }
    const operators = JSON_OPERATORS.filter((operator) => Object.prototype.hasOwnProperty.call(record, operator))
    if (operators.length !== 1) {
      fail(`${where} must specify exactly one operator (${JSON_OPERATORS.join(', ')})`)
      continue
    }
    const operator = operators[0]!
    const expected = record[operator]
    if (operator === 'exists') {
      if (typeof expected !== 'boolean') {
        fail(`${where}.exists must be true or false`)
        continue
      }
    } else if ((operator === 'lessThan' || operator === 'greaterThan') && (typeof expected !== 'number' || !Number.isFinite(expected))) {
      fail(`${where}.${operator} must be a finite number`)
      continue
    } else if (!isJsonValue(expected)) {
      fail(`${where}.${operator} must be a JSON value`)
      continue
    }
    assertions.push({ path: record.path, operator, expected: expected as JsonValue | boolean })
  }
  return assertions
}

export function normalizeConfig(config: StatusPingConfig): NormalizedConfig {
  const problems: string[] = []
  const sinks = config.sinks && typeof config.sinks === 'object' && !Array.isArray(config.sinks) ? config.sinks : {}
  if (config.sinks !== undefined && sinks !== config.sinks) problems.push('sinks: must be an object')
  const groups = Array.isArray(config.groups) ? config.groups : []
  if (!Array.isArray(config.groups)) problems.push('groups: must be an array')
  const timezone = config.timezone ?? 'UTC'
  if (!isValidTimeZone(timezone)) problems.push(`timezone: unknown timezone "${timezone}"`)
  try {
    new URL(config.baseUrl)
  } catch {
    problems.push(`baseUrl: "${config.baseUrl}" is not a valid URL`)
  }
  for (const [name, sink] of Object.entries(sinks)) {
    if (!['pushover', 'ntfy', 'telegram', 'webhook', 'discord', 'slack', 'email'].includes(sink.type)) {
      problems.push(`sinks.${name}: unknown type "${(sink as { type: string }).type}"`)
    }
    if (sink.type === 'webhook') {
      try {
        const url = new URL(sink.url)
        if (!['http:', 'https:'].includes(url.protocol)) problems.push(`sinks.${name}.url: must be http(s)`)
      } catch {
        problems.push(`sinks.${name}.url: "${sink.url}" is not a valid URL`)
      }
      if (sink.headers !== undefined && (!sink.headers || typeof sink.headers !== 'object' || Array.isArray(sink.headers))) {
        problems.push(`sinks.${name}.headers: must be an object`)
      } else if (sink.headers !== undefined && Object.values(sink.headers).some((value) => typeof value !== 'string')) {
        problems.push(`sinks.${name}.headers: all values must be strings`)
      }
    }
    if (sink.type === 'email') {
      if (!Array.isArray(sink.to) || sink.to.length === 0 || sink.to.some((address) => !isEmail(address))) {
        problems.push(`sinks.${name}.to: must contain one or more email addresses`)
      }
      if (sink.via !== 'cloudflare') {
        if (!sink.via || sink.via.provider !== 'resend') problems.push(`sinks.${name}.via: provider must be "resend"`)
        else if (typeof sink.via.from !== 'string' || !isMailbox(sink.via.from)) {
          problems.push(`sinks.${name}.via.from: must be an email address`)
        }
      }
    }
  }

  const defaultNotify = config.defaults?.notify ?? Object.keys(sinks)
  let defaultGrace = 300
  let defaultRenotifyEvery: number | null = null
  let defaultRenotifyMax: number | null = null
  try {
    if (config.defaults?.grace !== undefined) defaultGrace = parseDuration(config.defaults.grace, 'defaults.grace')
  } catch (e) {
    problems.push((e as Error).message)
  }
  try {
    if (config.defaults?.renotifyEvery !== undefined) {
      defaultRenotifyEvery = parseDuration(config.defaults.renotifyEvery, 'defaults.renotifyEvery')
      if (defaultRenotifyEvery <= 0) problems.push('defaults.renotifyEvery must be greater than 0s')
    }
  } catch (e) {
    problems.push((e as Error).message)
  }
  if (config.defaults?.renotifyMax !== undefined) {
    if (!Number.isInteger(config.defaults.renotifyMax) || config.defaults.renotifyMax < 0) {
      problems.push('defaults.renotifyMax must be a non-negative integer')
    } else {
      defaultRenotifyMax = config.defaults.renotifyMax
    }
  }

  const seen = new Set<string>()
  const monitors: Monitor[] = []
  let order = 0

  for (const group of groups) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.monitors)) {
      problems.push('each group must be an object with a monitors array')
      continue
    }
    for (const input of group.monitors) {
      if (!input || typeof input !== 'object') {
        problems.push(`group "${group.name}": each monitor must be an object`)
        continue
      }
      const where = `monitor "${input.id ?? '?'}"`
      const fail = (msg: string) => problems.push(`${where}: ${msg}`)
      if (!input.id || !ID_RE.test(input.id)) {
        fail('id must be 1–63 chars of letters, digits, "-" or "_"')
        continue
      }
      if (seen.has(input.id)) fail('duplicate id')
      seen.add(input.id)
      const notify = input.notify ?? defaultNotify
      for (const s of notify) if (!sinks[s]) fail(`notify references unknown sink "${s}"`)

      let renotifyEvery = defaultRenotifyEvery
      if (input.renotifyEvery !== undefined) {
        try {
          renotifyEvery = parseDuration(input.renotifyEvery, 'renotifyEvery')
          if (renotifyEvery <= 0) fail('renotifyEvery must be greater than 0s')
        } catch (e) {
          fail((e as Error).message)
        }
      }
      let renotifyMax = defaultRenotifyMax
      if (input.renotifyMax !== undefined) {
        if (!Number.isInteger(input.renotifyMax) || input.renotifyMax < 0) fail('renotifyMax must be a non-negative integer')
        else renotifyMax = input.renotifyMax
      }

      const base: NormalizedBase = {
        id: input.id,
        name: input.name || input.id,
        description: input.description ?? null,
        group: group.name,
        order: order++,
        notify,
        critical: input.critical ?? false,
        renotifyEvery,
        renotifyMax,
      }

      try {
        if (input.kind === 'push') {
          if ((input.period === undefined) === (input.schedule === undefined)) {
            fail('set exactly one of "period" or "schedule"')
            continue
          }
          const tz = input.tz ?? timezone
          if (!isValidTimeZone(tz)) fail(`unknown timezone "${tz}"`)
          const period = input.period !== undefined ? parseDuration(input.period, 'period') : null
          if (period !== null && period < 60) fail('period must be at least 60s (ticks run every minute)')
          if (input.schedule !== undefined) {
            try {
              new Cron(input.schedule, { timezone: tz, paused: true })
            } catch (e) {
              fail(`invalid schedule "${input.schedule}": ${(e as Error).message}`)
            }
          }
          monitors.push({
            ...base,
            kind: 'push',
            period,
            schedule: input.schedule ?? null,
            tz,
            grace: input.grace !== undefined ? parseDuration(input.grace, 'grace') : defaultGrace,
            maxRuntime: input.maxRuntime !== undefined ? parseDuration(input.maxRuntime, 'maxRuntime') : null,
          })
        } else if (input.kind === 'http') {
          if (typeof input.url !== 'string') {
            fail(`url references env ${input.url.$env}; resolve it with resolveConfigEnv() first`)
            continue
          }
          let url: URL | null = null
          try {
            url = new URL(input.url)
          } catch {
            fail(`url "${input.url}" is not valid`)
          }
          if (url && !['http:', 'https:'].includes(url.protocol)) fail('url must be http(s)')
          const interval = parseDuration(input.interval ?? 60, 'interval')
          if (interval < 60 || interval % 60 !== 0) fail('interval must be a whole number of minutes')
          const timeout = parseDuration(input.timeout ?? 10, 'timeout')
          if (timeout < 1 || timeout > 30) fail('timeout must be between 1s and 30s')
          let sslWarnDays: number[] | null = null
          if (input.sslExpiry !== false && url?.protocol === 'https:') {
            sslWarnDays = normalizeWarnDays(input.sslExpiry?.warnDays, [14, 7, 1], 'sslExpiry', fail)
          } else if (input.sslExpiry && url?.protocol !== 'https:') {
            fail('sslExpiry is only supported for https URLs')
          }
          const domainWarnDays = input.domainExpiry
            ? normalizeWarnDays(input.domainExpiry.warnDays, [30, 7], 'domainExpiry', fail)
            : null
          const json = normalizeJsonAssertions(input.json, fail)
          monitors.push({
            ...base,
            kind: 'http',
            url: input.url,
            method: (input.method ?? 'GET').toUpperCase(),
            headers: input.headers ?? {},
            body: input.body ?? null,
            intervalMin: Math.max(1, Math.round(interval / 60)),
            timeoutMs: timeout * 1000,
            expectStatus: parseStatusRanges(input.expectStatus),
            keyword: input.keyword ?? null,
            invertKeyword: input.invertKeyword ?? false,
            json,
            retries: Math.max(0, Math.floor(input.retries ?? 0)),
            sslWarnDays,
            domainWarnDays,
          })
        } else if (input.kind === 'tcp') {
          if (typeof input.host !== 'string' || !input.host.trim()) fail('host must be a non-empty hostname or IP address')
          if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) fail('port must be an integer between 1 and 65535')
          const interval = parseDuration(input.interval ?? 60, 'interval')
          if (interval < 60 || interval % 60 !== 0) fail('interval must be a whole number of minutes')
          const timeout = parseDuration(input.timeout ?? 10, 'timeout')
          if (timeout < 1 || timeout > 30) fail('timeout must be between 1s and 30s')
          monitors.push({
            ...base,
            kind: 'tcp',
            host: input.host.trim(),
            port: input.port,
            intervalMin: Math.max(1, Math.round(interval / 60)),
            timeoutMs: timeout * 1000,
            retries: Math.max(0, Math.floor(input.retries ?? 0)),
          })
        } else {
          fail(`unknown kind "${(input as { kind: string }).kind}"`)
        }
      } catch (e) {
        fail((e as Error).message)
      }
    }
  }

  const peer = {
    pingUrl: config.peer?.pingUrl ?? null,
    heartbeatMonitor: config.peer?.heartbeatMonitor ?? null,
    healthMonitor: config.peer?.healthMonitor ?? null,
  }
  const byId = new Map(monitors.map((m) => [m.id, m]))
  if (peer.heartbeatMonitor && byId.get(peer.heartbeatMonitor)?.kind !== 'push') {
    problems.push(`peer.heartbeatMonitor: "${peer.heartbeatMonitor}" must be a push monitor`)
  }
  if (peer.healthMonitor && byId.get(peer.healthMonitor)?.kind !== 'http') {
    problems.push(`peer.healthMonitor: "${peer.healthMonitor}" must be an http monitor`)
  }

  const limits = {
    maxChecksPerTick: config.limits?.maxChecksPerTick ?? 35,
    tickBudgetMs: config.limits?.tickBudgetMs ?? 20_000,
  }

  const access = normalizeAccess(config.access, problems)
  const pages = normalizePages(config, monitors, access, problems)
  const maintenance = normalizeMaintenance(config.maintenance, monitors, timezone, problems)
  const home = config.home ?? pages.find((p) => p.access === 'public')?.slug ?? null
  if (config.home && !pages.some((p) => p.slug === config.home)) problems.push(`home: unknown page "${config.home}"`)

  if (problems.length) throw new ConfigError(problems)
  return {
    title: config.title,
    baseUrl: config.baseUrl.replace(/\/+$/, ''),
    description: config.description ?? null,
    timezone,
    sinks,
    monitors,
    peer,
    limits,
    access,
    pages,
    home,
    maintenance,
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/

function parseIsoTimestamp(value: unknown, where: string, problems: string[]): number | null {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value)) {
    problems.push(`${where}: must be an ISO-8601 timestamp with a timezone`)
    return null
  }
  // Date.parse normalizes impossible calendar dates (such as February 30), so validate
  // the calendar portion separately before accepting its instant.
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value)!
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const calendar = new Date(Date.UTC(year, month - 1, day))
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    problems.push(`${where}: must be a real calendar date`)
    return null
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) {
    problems.push(`${where}: must be a valid ISO-8601 timestamp`)
    return null
  }
  return Math.floor(milliseconds / 1000)
}

function normalizeMaintenance(
  input: StatusPingConfig['maintenance'],
  monitors: Monitor[],
  defaultTimezone: string,
  problems: string[],
): NormalizedMaintenance[] {
  if (input === undefined) return []
  if (!Array.isArray(input)) {
    problems.push('maintenance: must be an array')
    return []
  }
  const knownMonitors = new Map(monitors.map((monitor, order) => [monitor.id, order]))
  const normalized: NormalizedMaintenance[] = []

  for (const [index, candidate] of input.entries()) {
    const where = `maintenance[${index}]`
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      problems.push(`${where}: must be an object`)
      continue
    }
    const window = candidate as unknown as Record<string, unknown>
    const title = typeof window.title === 'string' ? window.title.trim() : ''
    if (!title) problems.push(`${where}.title: must be a non-empty string`)

    const ids: string[] = []
    const selected = new Set<string>()
    if (window.monitors === '*') {
      ids.push(...monitors.map((monitor) => monitor.id))
    } else if (!Array.isArray(window.monitors) || !window.monitors.length) {
      problems.push(`${where}.monitors: must be "*" or a non-empty array of monitor ids`)
    } else {
      for (const id of window.monitors) {
        if (typeof id !== 'string' || !id) {
          problems.push(`${where}.monitors: every monitor id must be a non-empty string`)
        } else if (selected.has(id)) {
          problems.push(`${where}.monitors: duplicate monitor "${id}"`)
        } else if (!knownMonitors.has(id)) {
          selected.add(id)
          problems.push(`${where}.monitors: unknown monitor "${id}"`)
        } else {
          selected.add(id)
          ids.push(id)
        }
      }
      ids.sort((a, b) => knownMonitors.get(a)! - knownMonitors.get(b)!)
    }

    let excludeFromUptime = true
    if (window.excludeFromUptime !== undefined) {
      if (typeof window.excludeFromUptime !== 'boolean') problems.push(`${where}.excludeFromUptime: must be a boolean`)
      else excludeFromUptime = window.excludeFromUptime
    }

    const hasOneOffField = 'start' in window || 'end' in window
    const hasRecurringField = 'schedule' in window || 'duration' in window || 'tz' in window
    if (hasOneOffField && hasRecurringField) {
      problems.push(`${where}: must define either start/end or schedule/duration, not both`)
      continue
    }
    if (hasOneOffField) {
      const startAt = parseIsoTimestamp(window.start, `${where}.start`, problems)
      const endAt = parseIsoTimestamp(window.end, `${where}.end`, problems)
      if (startAt === null || endAt === null || !title || !ids.length) continue
      if (endAt <= startAt) {
        problems.push(`${where}.end: must be after start`)
        continue
      }
      normalized.push({ kind: 'one-off', title, monitors: ids, excludeFromUptime, start: startAt, end: endAt })
      continue
    }
    if (hasRecurringField) {
      const schedule = typeof window.schedule === 'string' ? window.schedule : ''
      if (!schedule) problems.push(`${where}.schedule: must be a non-empty cron expression`)
      const tz = typeof window.tz === 'string' ? window.tz : defaultTimezone
      if (!isValidTimeZone(tz)) problems.push(`${where}.tz: unknown timezone "${tz}"`)
      let duration: number | null = null
      try {
        duration = parseDuration(window.duration as Duration, `${where}.duration`)
        if (duration <= 0) problems.push(`${where}.duration must be greater than 0s`)
      } catch (error) {
        problems.push((error as Error).message)
      }
      if (schedule) {
        try {
          // Keep validating schedule syntax when the supplied timezone is invalid too;
          // otherwise a single bad field would hide a separate actionable problem.
          new Cron(schedule, { timezone: isValidTimeZone(tz) ? tz : 'UTC', paused: true })
        } catch (error) {
          problems.push(`${where}.schedule: invalid cron expression "${schedule}": ${(error as Error).message}`)
        }
      }
      if (!title || !ids.length || !schedule || !duration || duration <= 0 || !isValidTimeZone(tz)) continue
      normalized.push({ kind: 'recurring', title, monitors: ids, excludeFromUptime, schedule, tz, duration })
      continue
    }
    problems.push(`${where}: must define start/end or schedule/duration`)
  }
  return normalized
}

function normalizePages(
  config: StatusPingConfig,
  monitors: Monitor[],
  access: NormalizedAccess | null,
  problems: string[],
): NormalizedPage[] {
  const inputs: PageInput[] = config.pages === undefined ? [
    { slug: 'status', title: config.title, description: config.description, access: 'public', monitors: ['*'] },
  ] : Array.isArray(config.pages) ? config.pages : []
  if (config.pages !== undefined && !Array.isArray(config.pages)) problems.push('pages: must be an array')
  const seen = new Set<string>()
  return inputs.map((p) => {
    const where = `page "${p.slug}"`
    if (!SLUG_RE.test(p.slug ?? '')) problems.push(`${where}: slug must be lowercase letters, digits and "-"`)
    if (seen.has(p.slug)) problems.push(`${where}: duplicate slug`)
    seen.add(p.slug)

    const ids: string[] = []
    const add = (id: string) => {
      if (!ids.includes(id)) ids.push(id)
    }
    for (const sel of p.monitors ?? []) {
      if (sel === '*') monitors.forEach((m) => add(m.id))
      else if (sel.startsWith('group:')) {
        const name = sel.slice(6)
        const inGroup = monitors.filter((m) => m.group === name)
        if (!inGroup.length) problems.push(`${where}: no monitors in group "${name}"`)
        inGroup.forEach((m) => add(m.id))
      } else if (monitors.some((m) => m.id === sel)) add(sel)
      else problems.push(`${where}: unknown monitor "${sel}"`)
    }
    // Display order follows the monitor definitions, so sections stay grouped.
    const order = new Map(monitors.map((m, i) => [m.id, i]))
    ids.sort((a, b) => order.get(a)! - order.get(b)!)

    let pageAccess: NormalizedPage['access'] = 'public'
    if (p.access && p.access !== 'public') {
      if (!access) problems.push(`${where}: restricted access requires an \`access.provider\` config`)
      const sso = access?.provider.type === 'oidc'
      const match = normalizeMatch(p.access, `${where}: access`, sso, problems)
      const teams = p.access.teams ?? []
      for (const t of teams) if (access && !access.teams[t]) problems.push(`${where}: unknown team "${t}"`)
      if (!match.emails.length && !match.groups.length && !teams.length) {
        problems.push(`${where}: access must list emails${sso ? ', groups' : ''} or teams (or be 'public')`)
      }
      pageAccess = { ...match, teams }
    }
    return {
      slug: p.slug,
      title: p.title,
      description: p.description ?? null,
      access: pageAccess,
      show: resolveFields(p.show ?? (pageAccess === 'public' ? DEFAULT_PUBLIC_FIELDS : 'all'), `${where}: show`, problems),
      monitorIds: ids,
    }
  })
}

const EMAIL_PATTERN_RE = /^(\*|[^@\s*]+)@[^@\s*]+\.[^@\s*]+$/

function normalizeMatch(input: MatchInput | undefined, where: string, sso: boolean, problems: string[]): NormalizedMatch {
  const emails = (input?.emails ?? []).map((e) => e.trim().toLowerCase())
  for (const e of emails) {
    if (!EMAIL_PATTERN_RE.test(e)) problems.push(`${where}: "${e}" is not an email or *@domain pattern`)
  }
  const groups = input?.groups ?? []
  if (groups.length && !sso) {
    problems.push(`${where}: groups are only available with SSO (provider "oidc"); use emails for basic / cloudflare-access`)
  }
  return { emails, groups }
}

function normalizeAccess(input: AccessInput | undefined, problems: string[]): NormalizedAccess | null {
  if (!input) return null
  if (typeof input !== 'object' || !input.provider || typeof input.provider !== 'object') {
    problems.push('access: must contain a provider object')
    return null
  }
  const p = input.provider
  const sso = p.type === 'oidc'
  if (p.type === 'cloudflare-access' && !/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(p.teamDomain)) {
    problems.push(`access.provider.teamDomain: expected "<team>.cloudflareaccess.com", got "${p.teamDomain}"`)
  }
  if (p.type === 'oidc') {
    try {
      const u = new URL(p.issuer)
      if (u.protocol !== 'https:' && u.hostname !== 'localhost') problems.push('access.provider.issuer: must be https')
    } catch {
      problems.push(`access.provider.issuer: "${p.issuer}" is not a valid URL`)
    }
  }
  if (!['basic', 'cloudflare-access', 'oidc'].includes(p.type)) {
    problems.push(`access.provider: unknown type "${(p as { type: string }).type}"`)
  }
  const teams: Record<string, NormalizedMatch> = {}
  for (const [name, t] of Object.entries(input.teams ?? {})) {
    teams[name] = normalizeMatch(t, `access.teams.${name}`, sso, problems)
  }
  return { provider: p, teams, sessionHours: input.sessionHours ?? 12 }
}

/**
 * Resolves env() references that affect monitor definitions (HTTP monitor URLs). With
 * `lenient`, unresolved references become a placeholder URL (used by the CLI's `check`).
 */
export function resolveConfigEnv(config: StatusPingConfig, getEnv: EnvGetter, lenient = false): StatusPingConfig {
  return {
    ...config,
    groups: config.groups.map((g) => ({
      ...g,
      monitors: g.monitors.map((m) => {
        if (m.kind !== 'http' || typeof m.url === 'string') return m
        const value = getEnv(m.url.$env)
        if (value) return { ...m, url: value }
        if (lenient) return { ...m, url: `https://unset.invalid/${m.url.$env}` }
        throw new Error(`monitor "${m.id}": missing environment variable ${m.url.$env} for its url`)
      }),
    })),
  }
}

/** Monitors this instance actively evaluates. The watchdog only runs critical + peer monitors. */
export function activeMonitors(config: NormalizedConfig, role: Role): Monitor[] {
  if (role === 'primary') return config.monitors
  const peerIds = new Set([config.peer.heartbeatMonitor, config.peer.healthMonitor].filter(Boolean))
  return config.monitors.filter((m) => m.critical || peerIds.has(m.id))
}

export type EnvGetter = (name: string) => string | undefined

export function resolveSecret(value: Secret, getEnv: EnvGetter): string | undefined {
  if (typeof value === 'string') return value
  const v = getEnv(value.$env)
  if (v === undefined || v === '') {
    if (value.optional) return undefined
    throw new Error(`missing environment variable ${value.$env}`)
  }
  return v
}

/** Parses the PING_TOKENS secret: JSON object of `{ monitorId: token }`. */
export function parsePingTokens(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === 'string' && e[1].length >= 16,
        ),
      )
    }
  } catch {
    // fall through
  }
  throw new Error('PING_TOKENS must be a JSON object of { "monitor-id": "token" } (tokens ≥ 16 chars)')
}
