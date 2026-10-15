/**
 * JSON Schema for the YAML configuration, derived from the config types: every property of every
 * input type must appear here and every required one must be listed, or this file stops
 * compiling. `npm run schema:generate` writes it to statusping.schema.json; /admin/schema.json
 * serves it, and exported YAML points editors at it.
 */
import {
  type AccessInput, type AnnouncementNotificationsInput, type ConfirmationInput, DETAIL_FIELDS, type DiscordSinkInput, type EmailSinkInput,
  type EnvRef, type EscalationStepInput, type GoogleChatSinkInput, type GotifySinkInput, type HttpMonitorInput, type JsonAssertionInput,
  type MatchInput, type MatrixSinkInput, type MattermostSinkInput, type NtfySinkInput, type OneOffMaintenanceInput, type PageInput,
  type PagerDutySinkInput, type PushMonitorInput, type PushoverSinkInput, type RecurringMaintenanceInput, type SlackSinkInput, type SmtpViaInput,
  type StatusPingConfig, type SubscriberConfigInput, type TcpMonitorInput, type TeamsSinkInput, type TelegramSinkInput, type WebhookSinkInput,
} from '../config.ts'
import type { AdminConfig } from './security.ts'

type Schema = Record<string, unknown>
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T]

/** An object schema whose properties and required list are checked against the type T. */
const object = <T>() => <const R extends ReadonlyArray<RequiredKeys<T>>>(
  properties: { [K in keyof T]-?: Schema },
  required: [Exclude<RequiredKeys<T>, R[number]>] extends [never] ? R : never,
  description?: string,
): Schema => ({
  type: 'object',
  ...(description ? { description } : {}),
  properties,
  ...(required.length ? { required: [...required] } : {}),
  additionalProperties: false,
})

const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` })
const str = (description?: string, extra: Schema = {}): Schema => ({ type: 'string', ...(description ? { description } : {}), ...extra })
const num = (description?: string, extra: Schema = {}): Schema => ({ type: 'number', ...(description ? { description } : {}), ...extra })
const int = (description?: string, extra: Schema = {}): Schema => ({ type: 'integer', ...(description ? { description } : {}), ...extra })
const bool = (description?: string): Schema => ({ type: 'boolean', ...(description ? { description } : {}) })
const strings = (description?: string): Schema => ({ type: 'array', items: { type: 'string' }, ...(description ? { description } : {}) })
const literal = (value: string): Schema => ({ const: value })
const secret = (description?: string): Schema => ({ ...(description ? { description } : {}), anyOf: [{ type: 'string' }, ref('envRef')] })
const duration = (description?: string): Schema => ({ ...(description ? { description } : {}), anyOf: [{ type: 'number', minimum: 0 }, { type: 'string', pattern: '^\\d+(?:\\.\\d+)?(?:ms|s|m|h|d)?$' }] })
const anyJson: Schema = {}

const MONITOR_BASE = {
  id: str('Stable id used in URLs and history. Renaming it starts a new history.', { pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$' }),
  name: str(),
  description: str(),
  notify: strings('Alert channel names. Default: defaults.notify, or every channel.'),
  critical: bool('Also checked by the watchdog instance.'),
  renotifyEvery: duration('Repeat an unresolved outage alert at this interval.'),
  renotifyMax: int('Maximum repeated alerts for one incident.', { minimum: 0 }),
  escalation: { type: 'array', items: ref('escalationStep'), description: 'Acknowledgement-gated delivery steps.' },
  confirm: ref('confirmation'),
}

const SINKS: Record<string, Schema> = {
  pushover: object<PushoverSinkInput>()({ type: literal('pushover'), appToken: secret(), userKey: secret(), device: str(), sound: str(), emergency: bool('Send down alerts with emergency priority.') }, ['type', 'appToken', 'userKey']),
  ntfy: object<NtfySinkInput>()({ type: literal('ntfy'), topic: secret(), server: str('Default https://ntfy.sh.'), token: secret() }, ['type', 'topic']),
  telegram: object<TelegramSinkInput>()({ type: literal('telegram'), botToken: secret(), chatId: secret() }, ['type', 'botToken', 'chatId']),
  webhook: object<WebhookSinkInput>()({
    type: literal('webhook'), url: secret('A URL, or { $env: NAME } when the URL carries a credential.'),
    headers: { type: 'object', additionalProperties: secret(), description: 'Credential-bearing values must be { $env: NAME }.' },
    secret: secret('HMAC-SHA256 signing secret, sent as X-StatusPing-Signature.'),
  }, ['type', 'url']),
  discord: object<DiscordSinkInput>()({ type: literal('discord'), webhookUrl: secret() }, ['type', 'webhookUrl']),
  slack: object<SlackSinkInput>()({ type: literal('slack'), webhookUrl: secret() }, ['type', 'webhookUrl']),
  email: object<EmailSinkInput>()({
    type: literal('email'), to: strings('Recipients.'),
    via: { anyOf: [literal('cloudflare'), object<{ provider: 'resend'; apiKey: EnvRef | string; from: string }>()({ provider: literal('resend'), apiKey: secret(), from: str() }, ['provider', 'apiKey', 'from']), ref('smtp')] },
  }, ['type', 'to', 'via']),
  teams: object<TeamsSinkInput>()({ type: literal('teams'), webhookUrl: secret() }, ['type', 'webhookUrl']),
  googlechat: object<GoogleChatSinkInput>()({ type: literal('googlechat'), webhookUrl: secret() }, ['type', 'webhookUrl']),
  mattermost: object<MattermostSinkInput>()({ type: literal('mattermost'), webhookUrl: secret() }, ['type', 'webhookUrl']),
  matrix: object<MatrixSinkInput>()({ type: literal('matrix'), homeserver: str('Such as https://matrix.org.'), accessToken: secret(), roomId: str('Such as !abc123:matrix.org.') }, ['type', 'homeserver', 'accessToken', 'roomId']),
  gotify: object<GotifySinkInput>()({ type: literal('gotify'), server: str(), token: secret('An application token.') }, ['type', 'server', 'token']),
  pagerduty: object<PagerDutySinkInput>()({ type: literal('pagerduty'), routingKey: secret('Events API v2 integration key.') }, ['type', 'routingKey']),
}

const match = object<MatchInput>()({ emails: strings('Emails, or *@domain patterns.'), groups: strings('SSO groups (OpenID Connect only).') }, [])

const DEFS: Record<string, Schema> = {
  envRef: object<EnvRef>()({ $env: str('Name of a Worker secret or environment variable.', { pattern: '^[A-Z][A-Z0-9_]{0,127}$' }), optional: bool() }, ['$env'], 'A secret kept in the environment, named here.'),
  confirmation: object<ConfirmationInput>()({ regions: int('Additional regional probes (1–3).', { minimum: 1, maximum: 3 }), quorum: int('Failed locations required to declare the monitor down.', { minimum: 2 }) }, ['regions', 'quorum']),
  escalationStep: object<EscalationStepInput>()({ after: duration(), notify: strings() }, ['after', 'notify']),
  jsonAssertion: object<JsonAssertionInput>()({ path: str('Such as data.status or items[0].id.'), equals: anyJson, notEquals: anyJson, contains: anyJson, lessThan: num(), greaterThan: num(), exists: bool() }, ['path']),
  pushMonitor: object<PushMonitorInput>()({
    ...MONITOR_BASE, kind: literal('push'), period: duration('Expected time between pings.'), schedule: str('Cron expression, evaluated in tz.'), tz: str('IANA timezone.'),
    grace: duration('Extra time after the expected ping before alerting.'), maxRuntime: duration('Alert when a /start is not finished in time.'),
  }, ['id', 'name', 'kind']),
  httpMonitor: object<HttpMonitorInput>()({
    ...MONITOR_BASE, kind: literal('http'), url: secret('A URL, or { $env: NAME }.'), method: str(),
    headers: { type: 'object', additionalProperties: secret(), description: 'Credential-bearing values must be { $env: NAME }.' },
    body: str(), interval: duration('Whole minutes. Default 1m.'), timeout: duration('Default 10s, at most 30s.'),
    expectStatus: { anyOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'string' }], description: 'Such as [200, 204] or "200-399".' },
    keyword: str('The response must contain this text.'), invertKeyword: bool('The response must not contain the keyword.'),
    json: { type: 'array', items: ref('jsonAssertion') }, retries: int('Failed checks tolerated before alerting.', { minimum: 0 }),
    sslExpiry: { anyOf: [{ const: false }, object<{ warnDays?: number[] }>()({ warnDays: { type: 'array', items: { type: 'integer' } } }, [])] },
    domainExpiry: object<{ warnDays?: number[] }>()({ warnDays: { type: 'array', items: { type: 'integer' } } }, []),
  }, ['id', 'name', 'kind', 'url']),
  tcpMonitor: object<TcpMonitorInput>()({
    ...MONITOR_BASE, kind: literal('tcp'), host: str(), port: int(undefined, { minimum: 1, maximum: 65535 }), interval: duration(), timeout: duration(), retries: int(undefined, { minimum: 0 }),
  }, ['id', 'name', 'kind', 'host', 'port']),
  smtp: object<SmtpViaInput>()({
    provider: literal('smtp'), host: str(), port: int('587 for STARTTLS, 465 for TLS.'), security: { enum: ['tls', 'starttls'] }, username: str(), password: secret(), from: str(),
  }, ['provider', 'host', 'port', 'security', 'from']),
  sink: { oneOf: Object.values(SINKS) },
  page: object<PageInput>()({
    slug: str(undefined, { pattern: '^[a-z0-9-]+$' }), title: str(), description: str(),
    access: { anyOf: [literal('public'), object<MatchInput & { teams?: string[] }>()({ emails: strings(), groups: strings(), teams: strings() }, [])], description: 'Default public.' },
    show: { anyOf: [literal('all'), { type: 'array', items: { enum: [...DETAIL_FIELDS] } }] },
    monitors: strings('Monitor ids, group:<name>, or * for every monitor.'),
  }, ['slug', 'title', 'monitors']),
  maintenance: {
    oneOf: [
      object<OneOffMaintenanceInput>()({ title: str(), monitors: { anyOf: [literal('*'), { type: 'array', items: { type: 'string' } }] }, excludeFromUptime: bool(), start: str('ISO-8601 with a timezone.'), end: str() }, ['title', 'monitors', 'start', 'end']),
      object<RecurringMaintenanceInput>()({ title: str(), monitors: { anyOf: [literal('*'), { type: 'array', items: { type: 'string' } }] }, excludeFromUptime: bool(), schedule: str('Cron expression.'), tz: str(), duration: duration() }, ['title', 'monitors', 'schedule', 'duration']),
    ],
  },
  access: object<AccessInput>()({
    provider: {
      oneOf: [
        object<{ type: 'basic' }>()({ type: literal('basic') }, ['type']),
        object<{ type: 'cloudflare-access'; teamDomain: string; audience: string }>()({ type: literal('cloudflare-access'), teamDomain: str('Such as yourteam.cloudflareaccess.com.'), audience: secret() }, ['type', 'teamDomain', 'audience']),
        object<{ type: 'oidc'; issuer: string; clientId: string; clientSecret: string; groupsClaim?: string; scopes?: string[]; trustUnverifiedEmail?: boolean }>()({
          type: literal('oidc'), issuer: str(), clientId: secret(), clientSecret: secret(), groupsClaim: str('Default groups.'), scopes: strings(), trustUnverifiedEmail: bool('Only for providers where you control every email.'),
        }, ['type', 'issuer', 'clientId', 'clientSecret']),
      ],
    },
    teams: { type: 'object', additionalProperties: match },
    admins: object<MatchInput & { teams?: string[] }>()({ emails: strings(), groups: strings(), teams: strings() }, [], 'Who can open Settings.'),
    sessionHours: num('Default 12.'),
  }, ['provider']),
}

const ROOT = object<AdminConfig>()({
  title: str(), baseUrl: str('The public address of this site.'), description: str(), timezone: str('IANA timezone. Default UTC.'),
  sinks: { type: 'object', additionalProperties: ref('sink'), description: 'Alert channels by name.' },
  announcements: object<AnnouncementNotificationsInput>()({ notify: strings() }, ['notify']),
  subscribers: object<SubscriberConfigInput>()({ provider: literal('resend'), apiKey: secret(), from: str() }, ['provider', 'apiKey', 'from']),
  defaults: object<NonNullable<StatusPingConfig['defaults']>>()({ notify: strings(), grace: duration(), renotifyEvery: duration(), renotifyMax: int(undefined, { minimum: 0 }) }, []),
  groups: { type: 'array', items: object<StatusPingConfig['groups'][number]>()({ name: str(), monitors: { type: 'array', items: { oneOf: [ref('httpMonitor'), ref('pushMonitor'), ref('tcpMonitor')] } } }, ['name', 'monitors']) },
  pages: { type: 'array', items: ref('page') },
  maintenance: { type: 'array', items: ref('maintenance') },
  home: str('Slug of the page served at /.'),
  access: ref('access'),
  peer: object<NonNullable<StatusPingConfig['peer']>>()({ pingUrl: secret(), heartbeatMonitor: str(), healthMonitor: str() }, []),
  limits: object<NonNullable<StatusPingConfig['limits']>>()({
    maxChecksPerTick: int('Most HTTP/TCP checks started in one tick. Default 35 on Cloudflare Workers (at most 1000); default 1000 on Node (at most 10000).', { minimum: 1, maximum: 10_000 }),
    checkConcurrency: int('HTTP/TCP checks run at the same time. Default 5 on Cloudflare Workers (at most 6); default 50 on Node (at most 500).', { minimum: 1, maximum: 500 }),
    tickBudgetMs: int('Stop starting new checks after this many milliseconds in one tick. Default 20000.', { minimum: 1000, maximum: 300_000 }),
    maxConfirmationsPerTick: int('Default 6.', { minimum: 1, maximum: 35 }),
    pingPerIpPerMinute: int('Default 60.', { minimum: 1, maximum: 10_000 }),
  }, []),
  admin: bool('Older configurations only; the admin is always on after setup.'),
  updates: object<NonNullable<StatusPingConfig['updates']>>()({ enabled: bool(), manifestUrl: str(), publicKey: str() }, []),
}, ['title', 'baseUrl', 'groups'])

/** The JSON Schema document (draft 2020-12). */
export function configSchema(): Schema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'StatusPing configuration',
    description: 'The YAML edited in Settings → Configuration. Secrets are never written here: name them with { $env: NAME }.',
    ...ROOT,
    $defs: DEFS,
  }
}

export const configSchemaJson = () => `${JSON.stringify(configSchema(), null, 2)}\n`
