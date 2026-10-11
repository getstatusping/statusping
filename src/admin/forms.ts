/**
 * Form input → configuration changes for the admin's Settings pages. Every function returns a
 * new config; the caller validates and saves it with saveAdminConfig(), so the forms can never
 * store anything the YAML import could not. Fields a form does not show (escalation, headers,
 * confirmation, …) are carried over untouched when an item is edited.
 */
import type { AdminConfig } from './security.ts'
import type { MonitorInput, PageInput, SinkInput } from '../config.ts'

export type Form = Record<string, unknown>
export const text = (form: Form, name: string) => (typeof form[name] === 'string' ? (form[name] as string).trim() : '')
const list = (form: Form, name: string): string[] => {
  const value = form[name]
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
}
const lines = (value: string) => value.split(/[\n,]/).map((line) => line.trim()).filter(Boolean)

export class FormError extends Error {}

/** A stable, URL-safe id from a name, for new monitors and pages. */
export function slugify(value: string, fallback: string): string {
  const slug = value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return slug || fallback
}

// ── Monitors ────────────────────────────────────────────────────────────────────────────────

export interface MonitorRow { monitor: MonitorInput; group: string }

export function monitorRows(config: AdminConfig): MonitorRow[] {
  return (config.groups ?? []).flatMap((group) => group.monitors.map((monitor) => ({ monitor, group: group.name })))
}

export function findMonitor(config: AdminConfig, id: string): MonitorRow | undefined {
  return monitorRows(config).find((row) => row.monitor.id === id)
}

/** Builds a monitor from the form, starting from the existing one so hidden fields survive. */
export function monitorFromForm(form: Form, existing: MonitorInput | undefined, ids: ReadonlySet<string>): MonitorInput {
  const kind = (existing?.kind ?? text(form, 'kind')) as MonitorInput['kind']
  if (!['http', 'push', 'tcp'].includes(kind)) throw new FormError('Choose a monitor type.')
  const name = text(form, 'name').slice(0, 80)
  if (!name) throw new FormError('Give the monitor a name.')
  let id = existing?.id
  if (!id) {
    id = slugify(text(form, 'id') || name, kind)
    if (ids.has(id)) throw new FormError(`A monitor with the id "${id}" already exists. Choose another name or id.`)
  }
  const base: Record<string, unknown> = { ...(existing ?? {}), id, kind, name }
  const set = (key: string, value: unknown) => { if (value === undefined || value === '') delete base[key]; else base[key] = value }
  set('description', text(form, 'description').slice(0, 200))
  // Alerts: every channel (the default), selected channels, or none.
  const alerts = text(form, 'alerts')
  if (alerts === 'all') delete base.notify
  else if (alerts === 'some') base.notify = list(form, 'notify')
  else if (alerts === 'none') base.notify = []

  if (kind === 'http') {
    const url = text(form, 'url')
    try { if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error() } catch { throw new FormError('Enter a full http:// or https:// URL.') }
    set('url', url)
    set('keyword', text(form, 'keyword').slice(0, 200))
    set('interval', text(form, 'interval'))
    set('expectStatus', text(form, 'expectStatus'))
    set('retries', numberField(form, 'retries', 0, 10))
  } else if (kind === 'push') {
    const schedule = text(form, 'schedule')
    if (schedule) { set('schedule', schedule); set('tz', text(form, 'tz')); delete base.period }
    else { set('period', text(form, 'period') || '1d'); delete base.schedule; delete base.tz }
    set('grace', text(form, 'grace'))
    set('maxRuntime', text(form, 'maxRuntime'))
  } else {
    const host = text(form, 'host')
    if (!/^[a-z0-9.:-]+$/i.test(host)) throw new FormError('Enter a host name or IP address, such as db.example.com.')
    const port = numberField(form, 'port', 1, 65535)
    if (port === undefined) throw new FormError('Enter a port between 1 and 65535.')
    set('host', host)
    set('port', port)
    set('interval', text(form, 'interval'))
    set('retries', numberField(form, 'retries', 0, 10))
  }
  return base as unknown as MonitorInput
}

function numberField(form: Form, name: string, min: number, max: number): number | undefined {
  const raw = text(form, name)
  if (raw === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) throw new FormError(`${name === 'port' ? 'Port' : 'Retries'} must be a whole number from ${min} to ${max}.`)
  return value
}

/** Places a monitor in a group (created on demand), replacing any copy of it elsewhere. */
export function putMonitor(config: AdminConfig, monitor: MonitorInput, group: string): AdminConfig {
  const groupName = group.trim().slice(0, 60) || 'Services'
  const groups = (config.groups ?? []).map((g) => ({ ...g, monitors: g.monitors.filter((m) => m.id !== monitor.id) }))
  const existingIndex = (config.groups ?? []).findIndex((g) => g.monitors.some((m) => m.id === monitor.id))
  const target = groups.find((g) => g.name === groupName)
  if (target) {
    const original = existingIndex >= 0 ? (config.groups ?? [])[existingIndex]!.monitors.findIndex((m) => m.id === monitor.id) : -1
    const sameGroup = existingIndex >= 0 && (config.groups ?? [])[existingIndex]!.name === groupName
    if (sameGroup && original >= 0) target.monitors.splice(original, 0, monitor)
    else target.monitors.push(monitor)
  } else {
    groups.push({ name: groupName, monitors: [monitor] })
  }
  return { ...config, groups: groups.filter((g) => g.monitors.length > 0) }
}

/** Removes a monitor and every page reference to it. */
export function removeMonitor(config: AdminConfig, id: string): AdminConfig {
  return {
    ...config,
    groups: (config.groups ?? []).map((g) => ({ ...g, monitors: g.monitors.filter((m) => m.id !== id) })).filter((g) => g.monitors.length > 0),
    ...(config.pages ? { pages: config.pages.map((p) => (Array.isArray(p.monitors) ? { ...p, monitors: p.monitors.filter((m) => m !== id) } : p)) } : {}),
  }
}

// ── Status pages ────────────────────────────────────────────────────────────────────────────

/** Pages as stored, or the single default page the config implies when none are listed. */
export function pageList(config: AdminConfig): PageInput[] {
  return config.pages?.length ? config.pages : [{ slug: 'status', title: config.title, monitors: ['*'] } as PageInput]
}

export function pageFromForm(form: Form, existing: PageInput | undefined, slugs: ReadonlySet<string>): PageInput {
  const title = text(form, 'title').slice(0, 80)
  if (!title) throw new FormError('Give the page a title.')
  let slug = existing?.slug
  if (!slug) {
    slug = slugify(text(form, 'slug') || title, 'status')
    if (slugs.has(slug)) throw new FormError(`A page at /${slug} already exists. Choose another address.`)
  }
  const page: Record<string, unknown> = { ...(existing ?? {}), slug, title }
  const description = text(form, 'description').slice(0, 300)
  if (description) page.description = description
  else delete page.description
  const visibility = text(form, 'visibility')
  if (visibility === 'public') page.access = 'public'
  else {
    const emails = lines(text(form, 'emails'))
    if (!emails.length) throw new FormError('List at least one email address (or *@your-domain) that may see the private page.')
    page.access = { emails }
  }
  page.monitors = text(form, 'show') === 'all' ? ['*'] : list(form, 'monitors')
  return page as unknown as PageInput
}

export function putPage(config: AdminConfig, page: PageInput): AdminConfig {
  const pages = pageList(config)
  const index = pages.findIndex((p) => p.slug === page.slug)
  const next = index >= 0 ? pages.map((p, i) => (i === index ? page : p)) : [...pages, page]
  return { ...config, pages: next }
}

export function removePage(config: AdminConfig, slug: string): AdminConfig {
  const pages = pageList(config).filter((p) => p.slug !== slug)
  if (!pages.length) throw new FormError('Keep at least one status page.')
  return { ...config, pages, ...(config.home === slug ? { home: pages[0]!.slug } : {}) }
}

// ── Alert channels ──────────────────────────────────────────────────────────────────────────

export type SinkType = SinkInput['type']

/** The fields each channel type shows. Secret fields are stored write-only, never rendered. */
export const SINK_FIELDS: Record<SinkType, { label: string; help: string; fields: Array<{ key: string; label: string; secret?: boolean; optional?: boolean; placeholder?: string; hint?: string }> }> = {
  slack: { label: 'Slack', help: 'Create an incoming webhook in your Slack workspace and paste its URL.', fields: [{ key: 'webhookUrl', label: 'Webhook URL', secret: true, placeholder: 'https://hooks.slack.com/services/…' }] },
  teams: { label: 'Microsoft Teams', help: 'In the Teams channel, open Workflows → "Post to a channel when a webhook request is received", finish the template, and paste the URL it gives you.', fields: [{ key: 'webhookUrl', label: 'Workflow URL', secret: true, placeholder: 'https://…logic.azure.com/… or https://…powerplatform.com/…' }] },
  googlechat: { label: 'Google Chat', help: 'In the space, open Apps & integrations → Webhooks → Add webhook, and paste its URL.', fields: [{ key: 'webhookUrl', label: 'Webhook URL', secret: true, placeholder: 'https://chat.googleapis.com/v1/spaces/…' }] },
  mattermost: { label: 'Mattermost', help: 'Integrations → Incoming Webhooks → Add Incoming Webhook, choose the channel, and paste its URL.', fields: [{ key: 'webhookUrl', label: 'Webhook URL', secret: true, placeholder: 'https://mattermost.example.com/hooks/…' }] },
  matrix: { label: 'Matrix', help: 'Use a bot account that has joined the room. Its access token is in Element under Settings → Help & About → Access token.', fields: [{ key: 'homeserver', label: 'Homeserver', placeholder: 'https://matrix.org' }, { key: 'roomId', label: 'Room ID', placeholder: '!abc123:matrix.org', hint: 'Room settings → Advanced → Internal room ID.' }, { key: 'accessToken', label: 'Access token', secret: true }] },
  gotify: { label: 'Gotify', help: 'In Gotify, open Apps → Create application, and copy its token.', fields: [{ key: 'server', label: 'Server', placeholder: 'https://gotify.example.com' }, { key: 'token', label: 'Application token', secret: true }] },
  pagerduty: { label: 'PagerDuty', help: 'In the PagerDuty service, open Integrations → Add integration → Events API V2, and copy the integration key. Outages open a PagerDuty incident and recovery resolves it.', fields: [{ key: 'routingKey', label: 'Integration key', secret: true }] },
  discord: { label: 'Discord', help: 'Channel settings → Integrations → Webhooks → New webhook → Copy URL.', fields: [{ key: 'webhookUrl', label: 'Webhook URL', secret: true, placeholder: 'https://discord.com/api/webhooks/…' }] },
  telegram: { label: 'Telegram', help: 'Create a bot with @BotFather, add it to your chat, and use the chat ID.', fields: [{ key: 'botToken', label: 'Bot token', secret: true }, { key: 'chatId', label: 'Chat ID', secret: true }] },
  pushover: { label: 'Pushover', help: 'Create an application at pushover.net for its API token; your user key is on the dashboard.', fields: [{ key: 'appToken', label: 'Application API token', secret: true }, { key: 'userKey', label: 'User key', secret: true }, { key: 'device', label: 'Device', optional: true, hint: 'Leave empty for all your devices.' }] },
  ntfy: { label: 'ntfy', help: 'Subscribe to a hard-to-guess topic in the ntfy app.', fields: [{ key: 'topic', label: 'Topic', secret: true }, { key: 'server', label: 'Server', optional: true, placeholder: 'https://ntfy.sh' }, { key: 'token', label: 'Access token', secret: true, optional: true, hint: 'Recommended on ntfy.sh, which rate-limits anonymous senders.' }] },
  email: { label: 'Email', help: 'Sends through your own mail server (SMTP), Resend, or Cloudflare Email Routing (recipients must be verified there).', fields: [{ key: 'to', label: 'Recipients', placeholder: 'ops@example.com, me@example.com' }, { key: 'via', label: 'Send with' }, { key: 'apiKey', label: 'Resend API key', secret: true, optional: true }, { key: 'password', label: 'SMTP password', secret: true, optional: true }, { key: 'from', label: 'From address', optional: true, placeholder: 'StatusPing <alerts@example.com>' }] },
  webhook: { label: 'Webhook', help: 'StatusPing POSTs a JSON alert to your URL, optionally signed with a shared secret.', fields: [{ key: 'url', label: 'URL', secret: true, placeholder: 'https://example.com/hooks/statusping' }, { key: 'secret', label: 'Signing secret', secret: true, optional: true }] },
}

/** The environment name a channel's credential is stored under. */
export const sinkEnvName = (sink: string, field: string) => `SINK_${sink}_${field}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_')

export interface SinkFormResult { sink: SinkInput; secrets: Array<{ name: string; value: string }> }

/**
 * Builds a channel from the form. A secret field with a value is stored under its SINK_ name;
 * left blank on edit, the existing reference (a Worker secret or an earlier stored value) stays.
 */
export function sinkFromForm(form: Form, name: string, existing: SinkInput | undefined): SinkFormResult {
  const type = (existing?.type ?? text(form, 'type')) as SinkType
  const spec = SINK_FIELDS[type]
  if (!spec) throw new FormError('Choose a channel type.')
  const sink: Record<string, unknown> = { ...(existing ?? {}), type }
  const old = (existing ?? {}) as Record<string, unknown>
  const secrets: SinkFormResult['secrets'] = []
  for (const field of spec.fields) {
    if (type === 'email') continue
    const value = text(form, field.key)
    if (field.secret) {
      if (value) {
        const envName = sinkEnvName(name, field.key)
        secrets.push({ name: envName, value })
        sink[field.key] = { $env: envName }
      } else if (!old[field.key] && !field.optional) {
        throw new FormError(`Enter the ${field.label.toLowerCase()}.`)
      }
    } else if (value) sink[field.key] = value
    else delete sink[field.key]
  }
  if (type === 'email') {
    const to = lines(text(form, 'to'))
    if (!to.length || to.some((address) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address))) throw new FormError('List one or more valid recipient email addresses.')
    sink.to = to
    const via = text(form, 'via')
    const previous = typeof old.via === 'object' && old.via ? old.via as Record<string, unknown> : {}
    if (via === 'smtp') {
      const from = text(form, 'from')
      if (!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(from.replace(/^.*<([^<>]+)>$/, '$1'))) throw new FormError('Enter the From address, such as StatusPing <alerts@example.com>.')
      const host = text(form, 'smtpHost')
      if (!/^[a-z0-9.-]+$/i.test(host)) throw new FormError('Enter the mail server, such as smtp.example.com.')
      const port = Number(text(form, 'smtpPort') || '587')
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new FormError('Enter the mail server port, usually 587 or 465.')
      if (port === 25) throw new FormError('Port 25 is blocked on Cloudflare. Use 587 (STARTTLS) or 465 (TLS).')
      const security = text(form, 'smtpSecurity') === 'tls' ? 'tls' : 'starttls'
      const username = text(form, 'smtpUsername')
      const password = text(form, 'password')
      // Keep the saved password only while the same server and account are used.
      let passwordRef = previous.provider === 'smtp' && previous.host === host && previous.username === username ? previous.password : undefined
      if (password) { const envName = sinkEnvName(name, 'password'); secrets.push({ name: envName, value: password }); passwordRef = { $env: envName } }
      if (username && !passwordRef) throw new FormError('Enter the SMTP password.')
      sink.via = { provider: 'smtp', host, port, security, ...(username ? { username, password: passwordRef } : {}), from }
    } else if (via === 'resend') {
      const apiKey = text(form, 'apiKey')
      const from = text(form, 'from')
      if (!from) throw new FormError('Enter the From address for Resend.')
      let keyRef = previous.provider === 'resend' ? previous.apiKey : undefined
      if (apiKey) { const envName = sinkEnvName(name, 'apiKey'); secrets.push({ name: envName, value: apiKey }); keyRef = { $env: envName } }
      if (!keyRef) throw new FormError('Enter the Resend API key.')
      sink.via = { provider: 'resend', apiKey: keyRef, from }
    } else sink.via = 'cloudflare'
  }
  return { sink: sink as unknown as SinkInput, secrets }
}

export function putSink(config: AdminConfig, name: string, sink: SinkInput): AdminConfig {
  return { ...config, sinks: { ...(config.sinks ?? {}), [name]: sink } }
}

/** Removes a channel and every reference to it from monitors and defaults. */
export function removeSink(config: AdminConfig, name: string): AdminConfig {
  const sinks = { ...(config.sinks ?? {}) }
  delete sinks[name]
  const strip = (notify: string[] | undefined) => (notify ? notify.filter((n) => n !== name) : notify)
  return {
    ...config,
    sinks,
    groups: (config.groups ?? []).map((g) => ({ ...g, monitors: g.monitors.map((m) => (m.notify ? { ...m, notify: strip(m.notify) } : m)) })),
    ...(config.defaults?.notify ? { defaults: { ...config.defaults, notify: strip(config.defaults.notify) } } : {}),
  }
}

// ── Import preview ──────────────────────────────────────────────────────────────────────────

/** What an import would change, in plain words. */
export function describeChanges(before: AdminConfig, after: AdminConfig): string[] {
  const changes: string[] = []
  const diff = (label: string, a: string[], b: string[]) => {
    const added = b.filter((x) => !a.includes(x))
    const removed = a.filter((x) => !b.includes(x))
    if (added.length) changes.push(`Adds ${label}: ${added.join(', ')}`)
    if (removed.length) changes.push(`Removes ${label}: ${removed.join(', ')}`)
  }
  if (before.title !== after.title) changes.push(`Renames the site to "${after.title}"`)
  if (before.baseUrl !== after.baseUrl) changes.push(`Changes the address to ${after.baseUrl}`)
  diff('monitors', monitorRows(before).map((r) => r.monitor.id), monitorRows(after).map((r) => r.monitor.id))
  diff('status pages', pageList(before).map((p) => p.slug), pageList(after).map((p) => p.slug))
  diff('alert channels', Object.keys(before.sinks ?? {}), Object.keys(after.sinks ?? {}))
  if (JSON.stringify(before.access) !== JSON.stringify(after.access)) changes.push('Changes sign-in or administrator settings')
  const changedMonitors = monitorRows(after).filter((row) => {
    const old = findMonitor(before, row.monitor.id)
    return old && JSON.stringify(old.monitor) !== JSON.stringify(row.monitor)
  }).map((row) => row.monitor.id)
  if (changedMonitors.length) changes.push(`Updates monitors: ${changedMonitors.join(', ')}`)
  return changes.length ? changes : ['No changes: the imported configuration matches the current one.']
}
