import { Cron } from 'croner'
import { parseJsonPath } from './evaluate/json.ts'
import { normalizeSchedule, recurringScheduleProblem } from './maintenance.ts'
import { hasControlChars, isEmailAddress } from './util/email.ts'
import { isValidTimeZone, parseDuration } from './util/time.ts'
import { OFFICIAL_MANIFEST_URL, OFFICIAL_RELEASE_PUBLIC_KEY } from './updates.ts'

// ─── Config types (the YAML document edited in Settings → Configuration) ───────────────────

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
  /** Replace ordinary down/re-notify delivery with these acknowledgement-gated steps. */
  escalation?: EscalationStepInput[]
  /** Re-check a failed active monitor from other locations before opening an outage. */
  confirm?: ConfirmationInput
}

/** Regional confirmation settings. `quorum` includes the scheduler's failed check. */
export interface ConfirmationInput {
  /** Number of additional regional probes to ask (1–3). */
  regions: number
  /** Failed locations required to declare the monitor down (2 through regions + 1). */
  quorum: number
}

/** One acknowledgement-gated delivery step. The first step is always immediate (`after: '0s'`). */
export interface EscalationStepInput {
  after: Duration
  notify: string[]
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
  /** Header values may name a secret: `Authorization: { $env: API_AUTH }`. */
  headers?: Record<string, Secret>
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
  /** A URL, or `{ $env: NAME }` when the URL itself carries a credential. */
  url: Secret
  /** Header values may name a secret: `Authorization: { $env: HOOK_AUTH }`. */
  headers?: Record<string, Secret>
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
  via: 'cloudflare' | { provider: 'resend'; apiKey: Secret; from: string } | SmtpViaInput
}
/** Your own mail server. Port 465 uses TLS from the start; 587 upgrades with STARTTLS. Plaintext is not supported. */
export interface SmtpViaInput {
  provider: 'smtp'
  host: string
  port: number
  security: 'tls' | 'starttls'
  username?: string
  password?: Secret
  from: string
}
/** A Microsoft Teams Workflows ("Post to a channel when a webhook request is received") URL. */
export interface TeamsSinkInput {
  type: 'teams'
  webhookUrl: Secret
}
export interface GoogleChatSinkInput {
  type: 'googlechat'
  webhookUrl: Secret
}
export interface MattermostSinkInput {
  type: 'mattermost'
  webhookUrl: Secret
}
export interface MatrixSinkInput {
  type: 'matrix'
  /** Such as https://matrix.org. */
  homeserver: string
  accessToken: Secret
  /** Room ID, such as !abc123:matrix.org. The bot account must have joined the room. */
  roomId: string
}
export interface GotifySinkInput {
  type: 'gotify'
  server: string
  /** An application token. */
  token: Secret
}
/** PagerDuty Events API v2. Outages trigger an incident; recovery resolves it. */
export interface PagerDutySinkInput {
  type: 'pagerduty'
  routingKey: Secret
}
export type SinkInput = PushoverSinkInput | NtfySinkInput | TelegramSinkInput | WebhookSinkInput | DiscordSinkInput | SlackSinkInput | EmailSinkInput
  | TeamsSinkInput | GoogleChatSinkInput | MattermostSinkInput | MatrixSinkInput | GotifySinkInput | PagerDutySinkInput
/** Every alert channel type, in the order Settings lists them. */
export const SINK_TYPES = ['slack', 'discord', 'teams', 'googlechat', 'mattermost', 'telegram', 'matrix', 'pushover', 'ntfy', 'gotify', 'pagerduty', 'email', 'webhook'] as const

/** Delivery settings for status-page subscribers.  This intentionally does not
 * reuse an arbitrary alert sink: subscribers need a provider that can deliver
 * to addresses we do not know at configuration time. */
export interface SubscriberConfigInput {
  provider: 'resend'
  apiKey: Secret
  from: string
}

/** Optional operator-facing delivery for manual status announcements. Disabled unless a sink is named. */
export interface AnnouncementNotificationsInput {
  /** Alert sink names to receive every announcement create/update. */
  notify: string[]
}

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
      /**
       * Accept the email even when the provider does not mark it verified. Only for providers
       * where administrators control every account's email (for example a self-hosted Pocket
       * ID); otherwise someone could claim another person's address. Default false.
       */
      trustUnverifiedEmail?: boolean
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
  /** People allowed to acknowledge an active incident from a monitor page. */
  admins?: MatchInput & { teams?: string[] }
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
  /** Deliver manual announcement create/updates to these alert sinks. Off by default. */
  announcements?: AnnouncementNotificationsInput
  subscribers?: SubscriberConfigInput
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
    /** Maximum additional regional confirmation probes started in one tick. Default 6. */
    maxConfirmationsPerTick?: number
    /** Maximum accepted /ping requests from one client IP per fixed minute. Default 60. */
    pingPerIpPerMinute?: number
  }
  /** Enable the database-backed browser admin. Off by default: config-as-code remains authoritative. */
  admin?: boolean
  /** Opt-in, signed release-manifest checks shown only to authenticated administrators. */
  updates?: {
    enabled?: boolean
    /** HTTPS URL of the signed release manifest. Defaults to the latest official GitHub Release. */
    manifestUrl?: string
    /** Base64-encoded 32-byte Ed25519 public key used to verify the manifest signature. Defaults to the official release key. */
    publicKey?: string
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
  /** Null means ordinary down/re-notify delivery. */
  escalation: NormalizedEscalationStep[] | null
  /** Null disables regional confirmation. */
  confirm?: NormalizedConfirmation | null
}
export interface NormalizedEscalationStep {
  after: number
  notify: string[]
}
export interface NormalizedConfirmation {
  regions: number
  quorum: number
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
  /** The URL came from the environment: never displayed or stored. */
  secretUrl?: boolean
  /** Header names whose values came from the environment. */
  secretHeaders?: string[]
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
  admins: (NormalizedMatch & { teams: string[] }) | null
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
  announcements: { notify: string[] }
  subscribers: SubscriberConfigInput | null
  monitors: Monitor[]
  peer: { pingUrl: Secret | null; heartbeatMonitor: string | null; healthMonitor: string | null }
  limits: { maxChecksPerTick: number; tickBudgetMs: number; maxConfirmationsPerTick: number; pingPerIpPerMinute: number }
  access: NormalizedAccess | null
  pages: NormalizedPage[]
  home: string | null
  maintenance: NormalizedMaintenance[]
  updates: { enabled: boolean; manifestUrl: string | null; publicKey: string | null }
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

const isEmail = isEmailAddress

/** An address, or `Display Name <address>`. No control characters anywhere: it becomes a header. */
function isMailbox(value: unknown): value is string {
  if (typeof value !== 'string' || hasControlChars(value) || value.length > 320) return false
  const match = value.match(/^([^<>]*)<([^<>]+)>$/)
  return isEmail(match ? match[2] : value)
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

export interface NormalizeOptions {
  /**
   * Saving a config (rather than loading a stored one) also enforces rules that would make an
   * already-running site fail to load if applied retroactively, such as the minimum cadence
   * of recurring maintenance.
   */
  save?: boolean
  /**
   * Loading only: what was dropped or clamped so a stored configuration an older release accepted
   * still loads (an unknown sink name, an out-of-range limit). Saving refuses these instead.
   */
  warnings?: string[]
}

/**
 * A list of strings from user input. Anything else (not a list, or a list holding numbers,
 * objects or null) becomes a validation problem rather than a TypeError further on; the strings
 * that are there are kept so the remaining checks can still report on them. With `report` false
 * (loading a stored configuration, for lists an older release accepted) bad entries are dropped.
 */
function stringList(value: unknown, where: string, problems: string[], report = true): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    if (report) problems.push(`${where}: must be a list of strings`)
    return []
  }
  if (report && value.some((item) => typeof item !== 'string')) problems.push(`${where}: every entry must be a string`)
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * A number within [min, max]. Saving refuses anything else with a problem naming the range. A
 * stored configuration is only loaded, so an out-of-range value saved by an older release is
 * clamped (or a non-number replaced by the default) instead of making the whole site fail to load.
 */
function boundedNumber(value: unknown, fallback: number, where: string, [min, max]: readonly [number, number], problems: string[], save: boolean, integer = true, warnings?: string[]): number {
  if (value === undefined) return fallback
  const valid = typeof value === 'number' && Number.isFinite(value) && (!integer || Number.isInteger(value))
  if (valid && value >= min && value <= max) return value
  const message = `${where} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}`
  const used = valid ? Math.min(max, Math.max(min, value)) : fallback
  if (save) problems.push(message)
  else warnings?.push(`${message} (using ${used})`)
  return used
}

/** Bounds for the tick's work limits: at least one check (Workers allow 1000 subrequests), and a budget from 1 s to 5 min. */
export const LIMIT_BOUNDS = { maxChecksPerTick: [1, 1000], tickBudgetMs: [1000, 300_000], maxConfirmationsPerTick: [1, 35], pingPerIpPerMinute: [1, 10_000] } as const
/** Session length bounds, in hours: from one hour to 30 days. */
export const SESSION_HOURS_BOUNDS = [1, 720] as const

export function normalizeConfig(config: StatusPingConfig, options: NormalizeOptions = {}): NormalizedConfig {
  const problems: string[] = []
  const save = options.save === true
  /**
   * A rule an older release did not enforce (or enforced more loosely). Saving refuses the value;
   * loading a stored configuration drops or clamps it and records a warning, so an upgrade never
   * makes a site that was working fail to load.
   */
  const lenient = (message: string, onLoad = '') => {
    if (save) problems.push(message)
    else options.warnings?.push(`${message}${onLoad}`)
  }
  const configuredSinks = config.sinks && typeof config.sinks === 'object' && !Array.isArray(config.sinks) ? config.sinks : {}
  if (config.sinks !== undefined && configuredSinks !== config.sinks) problems.push('sinks: must be an object')
  /** Channels a stored configuration keeps but that cannot be used safely; they are left out on load. */
  const disabledSinks = new Set<string>()
  let subscribers: SubscriberConfigInput | null = null
  if (config.subscribers !== undefined) {
    const value = config.subscribers
    if (!value || typeof value !== 'object' || value.provider !== 'resend') problems.push('subscribers.provider: must be "resend"')
    // 0.3.11 tightened address checks (header injection). A stored sender that no longer passes
    // turns subscriber email off rather than taking the site down.
    else if (typeof value.from !== 'string' || !isMailbox(value.from)) lenient('subscribers.from: must be an email address', ' (subscriber email is off until it is fixed)')
    else subscribers = value
  }
  const groups = Array.isArray(config.groups) ? config.groups : []
  if (!Array.isArray(config.groups)) problems.push('groups: must be an array')
  const timezone = config.timezone ?? 'UTC'
  if (!isValidTimeZone(timezone)) problems.push(`timezone: unknown timezone "${timezone}"`)
  try {
    new URL(config.baseUrl)
  } catch {
    problems.push(`baseUrl: "${config.baseUrl}" is not a valid URL`)
  }
  let updates: NormalizedConfig['updates'] = { enabled: false, manifestUrl: null, publicKey: null }
  if (config.updates !== undefined) {
    const input = config.updates
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      problems.push('updates: must be an object')
    } else {
      const enabled = input.enabled ?? false
      if (typeof enabled !== 'boolean') problems.push('updates.enabled: must be a boolean')
      const manifestUrl = input.manifestUrl
      const publicKey = input.publicKey
      if (manifestUrl !== undefined && typeof manifestUrl !== 'string') problems.push('updates.manifestUrl: must be a string')
      if (publicKey !== undefined && typeof publicKey !== 'string') problems.push('updates.publicKey: must be a base64 Ed25519 public key')
      if (typeof manifestUrl === 'string') {
        try {
          const url = new URL(manifestUrl)
          // A manifest is public, static release metadata.  Keeping its URL
          // free of userinfo, queries, and fragments prevents an operator
          // accidentally placing a bearer-like value in editable config (or
          // subsequently sending it as part of an outbound request).
          if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) problems.push('updates.manifestUrl: must be an HTTPS URL without credentials, query parameters, or fragments')
        } catch { problems.push('updates.manifestUrl: must be a valid HTTPS URL') }
      }
      let keyIsValid = false
      if (typeof publicKey === 'string') {
        try { keyIsValid = Uint8Array.from(atob(publicKey), (char) => char.charCodeAt(0)).byteLength === 32 } catch { /* report below */ }
        if (!keyIsValid) problems.push('updates.publicKey: must be a base64-encoded 32-byte Ed25519 public key')
      }
      // Enabling checks without a source uses the official GitHub Release
      // manifest and release key; either can be overridden for a mirror.
      if (typeof enabled === 'boolean' && (publicKey === undefined || keyIsValid)) {
        updates = enabled
          ? { enabled, manifestUrl: typeof manifestUrl === 'string' ? manifestUrl : OFFICIAL_MANIFEST_URL, publicKey: typeof publicKey === 'string' ? publicKey : OFFICIAL_RELEASE_PUBLIC_KEY }
          : { enabled, manifestUrl: typeof manifestUrl === 'string' ? manifestUrl : null, publicKey: typeof publicKey === 'string' ? publicKey : null }
      }
    }
  }
  for (const [name, sink] of Object.entries(configuredSinks)) {
    if (!(SINK_TYPES as readonly string[]).includes(sink.type)) {
      problems.push(`sinks.${name}: unknown type "${(sink as { type: string }).type}"`)
    }
    if (sink.type === 'matrix' || sink.type === 'gotify') {
      const base = sink.type === 'matrix' ? sink.homeserver : sink.server
      const key = sink.type === 'matrix' ? 'homeserver' : 'server'
      try { if (new URL(base).protocol !== 'https:') problems.push(`sinks.${name}.${key}: must be an https:// URL`) } catch { problems.push(`sinks.${name}.${key}: "${base}" is not a valid URL`) }
    }
    if (sink.type === 'matrix' && (typeof sink.roomId !== 'string' || !/^![^:\s]+:\S+$/.test(sink.roomId))) problems.push(`sinks.${name}.roomId: must look like !abc123:example.org`)
    if (sink.type === 'webhook') {
      if (typeof sink.url === 'string') {
        try {
          const url = new URL(sink.url)
          if (!['http:', 'https:'].includes(url.protocol)) problems.push(`sinks.${name}.url: must be http(s)`)
        } catch {
          problems.push(`sinks.${name}.url: "${sink.url}" is not a valid URL`)
        }
      } else if (!isEnvRef(sink.url)) problems.push(`sinks.${name}.url: must be a URL or { $env: NAME }`)
      if (sink.headers !== undefined && (!sink.headers || typeof sink.headers !== 'object' || Array.isArray(sink.headers))) {
        problems.push(`sinks.${name}.headers: must be an object`)
      } else if (sink.headers !== undefined && Object.values(sink.headers).some((value) => typeof value !== 'string' && !isEnvRef(value))) {
        problems.push(`sinks.${name}.headers: values must be strings or { $env: NAME }`)
      }
    }
    if (sink.type === 'email') {
      // 0.3.11 tightened address checks (no control characters or header delimiters). An address
      // stored before then disables just this channel on load; saving still refuses it.
      const disable = (message: string) => {
        lenient(message, ' (the channel is off until it is fixed)')
        if (!save) disabledSinks.add(name)
      }
      if (!Array.isArray(sink.to) || sink.to.length === 0) problems.push(`sinks.${name}.to: must contain one or more email addresses`)
      else if (sink.to.some((address) => !isEmail(address))) disable(`sinks.${name}.to: must contain one or more email addresses`)
      if (sink.via !== 'cloudflare') {
        if (!sink.via || (sink.via.provider !== 'resend' && sink.via.provider !== 'smtp')) problems.push(`sinks.${name}.via: provider must be "resend" or "smtp"`)
        else if (typeof sink.via.from !== 'string' || !isMailbox(sink.via.from)) {
          disable(`sinks.${name}.via.from: must be an email address`)
        }
        if (sink.via && typeof sink.via === 'object' && sink.via.provider === 'smtp') {
          const smtp = sink.via
          if (typeof smtp.host !== 'string' || !/^[a-z0-9.-]+$/i.test(smtp.host)) problems.push(`sinks.${name}.via.host: must be a host name`)
          if (!Number.isInteger(smtp.port) || smtp.port < 1 || smtp.port > 65535) problems.push(`sinks.${name}.via.port: must be a port number`)
          else if (smtp.port === 25) problems.push(`sinks.${name}.via.port: port 25 is blocked on Cloudflare; use 465 or 587`)
          if (smtp.security !== 'tls' && smtp.security !== 'starttls') problems.push(`sinks.${name}.via.security: must be "tls" or "starttls"`)
          if (smtp.username !== undefined && typeof smtp.username !== 'string') problems.push(`sinks.${name}.via.username: must be a string`)
          if (smtp.username && smtp.password === undefined) problems.push(`sinks.${name}.via.password: required with a username`)
        }
      }
    }
  }

  const sinks: Record<string, SinkInput> = disabledSinks.size
    ? Object.fromEntries(Object.entries(configuredSinks).filter(([name]) => !disabledSinks.has(name)))
    : configuredSinks
  // Own keys only: a name such as "toString" must not resolve to an Object.prototype member.
  const isSink = (name: string) => Object.prototype.hasOwnProperty.call(sinks, name)
  /**
   * Sink names from a notify list. Releases before 0.3.12 did not check every list (defaults.notify
   * not at all) and resolved names through the prototype, so a stored list may name a channel that
   * does not exist: loading drops the name with a warning, saving refuses it.
   */
  const knownSinks = (names: string[], unknown: (name: string) => string): string[] => names.filter((name) => {
    if (isSink(name)) return true
    lenient(unknown(name), disabledSinks.has(name) ? ' (the channel is off)' : ' (left out)')
    return false
  })

  let announcementNotify: string[] = []
  if (config.announcements !== undefined) {
    const notify = config.announcements?.notify
    if (!Array.isArray(notify) || notify.length === 0 || notify.some((sink) => typeof sink !== 'string')) {
      lenient('announcements.notify: must name one or more sinks', ' (announcement alerts are off)')
    } else {
      if (new Set(notify).size !== notify.length) lenient('announcements.notify: must not contain duplicates')
      announcementNotify = knownSinks([...new Set(notify)], (sink) => `announcements.notify references unknown sink "${sink}"`)
    }
  }

  const defaultNotify = config.defaults?.notify === undefined
    ? Object.keys(sinks)
    : knownSinks(stringList(config.defaults.notify, 'defaults.notify', problems, save), (s) => `defaults.notify references unknown sink "${s}"`)
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
      const notify = input.notify === undefined ? defaultNotify : knownSinks(stringList(input.notify, `${where}.notify`, problems, save), (s) => `${where}: notify references unknown sink "${s}"`)

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

      let escalation: NormalizedEscalationStep[] | null = null
      if (input.escalation !== undefined) {
        if (!Array.isArray(input.escalation) || input.escalation.length === 0) {
          fail('escalation must be a non-empty array of steps')
        } else {
          const steps: NormalizedEscalationStep[] = []
          let previous = -1
          for (const [stepIndex, step] of input.escalation.entries()) {
            const stepWhere = `escalation[${stepIndex}]`
            if (!step || typeof step !== 'object') {
              fail(`${stepWhere} must be an object`)
              continue
            }
            let after: number | null = null
            try {
              after = parseDuration(step.after, `${stepWhere}.after`)
              if (after < 0) fail(`${stepWhere}.after must not be negative`)
            } catch (error) {
              fail((error as Error).message)
            }
            const listed = stringList(step.notify, `${where}: ${stepWhere}.notify`, problems, save)
            if (!listed.length) fail(`${stepWhere}.notify must name one or more sinks`)
            if (new Set(listed).size !== listed.length) fail(`${stepWhere}.notify must not contain duplicates`)
            // A step left with no known channel on load still gates escalation; it just sends nothing.
            const notifyStep = knownSinks(listed, (sink) => `${where}: ${stepWhere}.notify references unknown sink "${sink}"`)
            if (after !== null) {
              if (stepIndex === 0 && after !== 0) fail('escalation[0].after must be 0s')
              if (after <= previous) fail(`${stepWhere}.after must be strictly greater than the previous step`)
              previous = after
              steps.push({ after, notify: notifyStep })
            }
          }
          if (steps.length === input.escalation.length) escalation = steps
        }
        if (renotifyEvery !== null) fail('renotifyEvery cannot be used with escalation')
      }

      let confirm: NormalizedConfirmation | null = null
      if (input.confirm !== undefined) {
        const value = input.confirm
        if (!value || typeof value !== 'object' || !Number.isInteger(value.regions) || value.regions < 1 || value.regions > 3) {
          fail('confirm.regions must be a whole number from 1 to 3')
        } else if (!Number.isInteger(value.quorum) || value.quorum < 2 || value.quorum > value.regions + 1) {
          fail('confirm.quorum must be a whole number from 2 through confirm.regions + 1')
        } else {
          confirm = { regions: value.regions, quorum: value.quorum }
        }
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
        escalation,
        confirm,
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
            headers: Object.fromEntries(Object.entries(input.headers ?? {}).map(([key, value]) => {
              if (typeof value !== 'string') fail(`headers.${key} references env ${value.$env}; resolve it with resolveConfigEnv() first`)
              return [key, String(value)]
            })),
            ...((input as WithEnvFields)[FROM_ENV] ?? {}),
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

  const limitsInput = config.limits && typeof config.limits === 'object' ? config.limits : undefined
  const bounded = (key: keyof typeof LIMIT_BOUNDS, fallback: number) =>
    boundedNumber(limitsInput?.[key], fallback, `limits.${key}`, LIMIT_BOUNDS[key], problems, save, true, options.warnings)
  const limits = {
    maxChecksPerTick: bounded('maxChecksPerTick', 35),
    tickBudgetMs: bounded('tickBudgetMs', 20_000),
    maxConfirmationsPerTick: bounded('maxConfirmationsPerTick', 6),
    pingPerIpPerMinute: bounded('pingPerIpPerMinute', 60),
  }

  const access = normalizeAccess(config.access, problems, save, options.warnings)
  const pages = normalizePages(config, monitors, access, problems, save, options.warnings)
  const maintenance = normalizeMaintenance(config.maintenance, monitors, timezone, problems, save)
  const home = config.home ?? pages.find((p) => p.access === 'public')?.slug ?? null
  if (config.home && !pages.some((p) => p.slug === config.home)) problems.push(`home: unknown page "${config.home}"`)

  if (problems.length) throw new ConfigError(problems)
  return {
    title: config.title,
    baseUrl: config.baseUrl.replace(/\/+$/, ''),
    description: config.description ?? null,
    timezone,
    sinks,
    announcements: { notify: announcementNotify },
    subscribers,
    monitors,
    peer,
    limits,
    access,
    pages,
    home,
    maintenance,
    updates,
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

/** The most maintenance windows a saved config may hold. */
export const MAX_MAINTENANCE_WINDOWS = 200

function normalizeMaintenance(
  input: StatusPingConfig['maintenance'],
  monitors: Monitor[],
  defaultTimezone: string,
  problems: string[],
  save: boolean,
): NormalizedMaintenance[] {
  if (input === undefined) return []
  if (!Array.isArray(input)) {
    problems.push('maintenance: must be an array')
    return []
  }
  // Every window is expanded on each status-page render and tick, so a saved list is capped.
  if (save && input.length > MAX_MAINTENANCE_WINDOWS) problems.push(`maintenance: at most ${MAX_MAINTENANCE_WINDOWS} windows (found ${input.length}); remove past one-off windows`)
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
      const schedule = typeof window.schedule === 'string' ? normalizeSchedule(window.schedule) : ''
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
        // A stored window that breaks this still loads; rendering skips it if it overflows.
        const cadence = save ? recurringScheduleProblem(schedule, isValidTimeZone(tz) ? tz : 'UTC') : null
        if (cadence) problems.push(`${where}.schedule: "${schedule}" ${cadence}`)
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
  save = false,
  warnings?: string[],
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
      const match = normalizeMatch(p.access, `${where}: access`, sso, problems, save)
      const listed = stringList(p.access.teams, `${where}: access.teams`, problems, save)
      if (!match.emails.length && !match.groups.length && !listed.length) {
        problems.push(`${where}: access must list emails${sso ? ', groups' : ''} or teams (or be 'public')`)
      }
      // Before 0.3.12 a team named like an Object.prototype member ("constructor") resolved, so a
      // stored page may list one. Loading drops it; the page stays restricted to whoever is left.
      const teams = access ? knownTeams(listed, access.teams, where, problems, save, warnings) : listed
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

/** The listed teams that exist. An unknown one is refused when saving and dropped (with a warning) when loading. */
function knownTeams(listed: string[], teams: Record<string, NormalizedMatch>, where: string, problems: string[], save: boolean, warnings?: string[]): string[] {
  return listed.filter((team) => {
    // Own keys only: "constructor" is not a team.
    if (Object.prototype.hasOwnProperty.call(teams, team)) return true
    const message = `${where}: unknown team "${team}"`
    if (save) problems.push(message)
    else warnings?.push(`${message} (left out)`)
    return false
  })
}

const EMAIL_PATTERN_RE = /^(\*|[^@\s*]+)@[^@\s*]+\.[^@\s*]+$/

/**
 * Emails must be strings (anything else always failed). The shape of the match and its groups are
 * checked strictly on save only, since an older release stored them without these checks.
 */
function normalizeMatch(input: MatchInput | undefined, where: string, sso: boolean, problems: string[], save = false): NormalizedMatch {
  if (save && input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) problems.push(`${where}: must be an object`)
  const record = input && typeof input === 'object' ? input : undefined
  const emails = stringList(record?.emails, `${where}.emails`, problems).map((e) => e.trim().toLowerCase())
  for (const e of emails) {
    if (!EMAIL_PATTERN_RE.test(e)) problems.push(`${where}: "${e}" is not an email or *@domain pattern`)
  }
  const groups = stringList(record?.groups, `${where}.groups`, problems, save)
  if (groups.length && !sso) {
    problems.push(`${where}: groups are only available with SSO (provider "oidc"); use emails for basic / cloudflare-access`)
  }
  return { emails, groups }
}

function normalizeAccess(input: AccessInput | undefined, problems: string[], save = false, warnings?: string[]): NormalizedAccess | null {
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
    if (p.trustUnverifiedEmail !== undefined && typeof p.trustUnverifiedEmail !== 'boolean') problems.push('access.provider.trustUnverifiedEmail: must be true or false')
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
  const validTeams = input.teams && typeof input.teams === 'object' && !Array.isArray(input.teams)
  if (save && input.teams !== undefined && !validTeams) problems.push('access.teams: must be an object of named member lists')
  for (const [name, t] of Object.entries(validTeams ? input.teams! : {})) {
    teams[name] = normalizeMatch(t, `access.teams.${name}`, sso, problems, save)
  }
  let admins: NormalizedAccess['admins'] = null
  if (input.admins !== undefined) {
    const match = normalizeMatch(input.admins, 'access.admins', sso, problems, save)
    // Non-string admin teams always failed (as unknown teams), so they are reported on load too.
    const listedTeams = stringList(input.admins?.teams, 'access.admins.teams', problems)
    if (!match.emails.length && !match.groups.length && !listedTeams.length) {
      problems.push(`access.admins: must list emails${sso ? ', groups' : ''} or teams`)
    }
    // As for pages: a prototype-named team an older release accepted is dropped on load.
    const adminTeams = knownTeams(listedTeams, teams, 'access.admins', problems, save, warnings)
    admins = { ...match, teams: adminTeams }
  }
  const sessionHours = boundedNumber(input.sessionHours, 12, 'access.sessionHours', SESSION_HOURS_BOUNDS, problems, save, false, warnings)
  return { provider: p, teams, sessionHours, admins }
}

export function isEnvRef(value: unknown): value is EnvRef {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as EnvRef).$env === 'string')
}

/** Marks what resolveConfigEnv() filled in from the environment. A symbol: it never reaches JSON. */
const FROM_ENV = Symbol('fromEnv')
type WithEnvFields = { [FROM_ENV]?: { secretUrl?: boolean; secretHeaders?: string[] } }

/**
 * Resolves env() references that affect monitor definitions (HTTP monitor URLs and header
 * values). With `lenient`, unresolved references become placeholders (used for validation).
 */
export function resolveConfigEnv(config: StatusPingConfig, getEnv: EnvGetter, lenient = false): StatusPingConfig {
  return {
    ...config,
    groups: (config.groups ?? []).map((g) => ({
      ...g,
      monitors: g.monitors.map((m) => {
        if (m.kind !== 'http') return m
        const headerRefs = Object.entries(m.headers ?? {}).filter((entry): entry is [string, EnvRef] => isEnvRef(entry[1]))
        if (typeof m.url === 'string' && !headerRefs.length) return m
        const fromEnv = { ...(typeof m.url === 'string' ? {} : { secretUrl: true }), ...(headerRefs.length ? { secretHeaders: headerRefs.map(([key]) => key) } : {}) }
        let url = m.url
        if (typeof url !== 'string') {
          const value = getEnv(url.$env)
          if (value) url = value
          else if (lenient) url = `https://unset.invalid/${url.$env}`
          else throw new Error(`monitor "${m.id}": missing environment variable ${url.$env} for its url`)
        }
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(m.headers ?? {})) {
          if (typeof value === 'string') { headers[key] = value; continue }
          const resolved = getEnv(value.$env)
          if (resolved) headers[key] = resolved
          else if (lenient || value.optional) { if (lenient) headers[key] = 'unset' }
          else throw new Error(`monitor "${m.id}": missing environment variable ${value.$env} for its ${key} header`)
        }
        return { ...m, url, headers, [FROM_ENV]: fromEnv } as MonitorInput
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

/**
 * StatusPing's own server secrets. No configuration may reference them with { $env }: a reference
 * in a webhook header or monitor URL would send the value to an address the config chooses.
 */
const RESERVED_ENV = new Set(['SESSION_SECRET', 'ADMIN_TOKEN', 'ACK_SECRET', 'SUBSCRIBER_TOKEN_SECRET', 'TICK_SECRET', 'BASIC_AUTH_USERS', 'PING_TOKENS'])
export const isReservedEnv = (name: string) => RESERVED_ENV.has(name) || name.startsWith('STATUSPING_') || name.startsWith('TURSO_')

export function resolveSecret(value: Secret, getEnv: EnvGetter): string | undefined {
  if (typeof value === 'string') return value
  // Defense in depth: the admin validator already refuses these names.
  if (isReservedEnv(value.$env)) throw new Error(`${value.$env} is a server secret and cannot be referenced in the configuration`)
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
