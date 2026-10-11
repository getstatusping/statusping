/**
 * MCP tools for everything Settings manages: status pages, alert channels, maintenance windows,
 * ping URLs, acknowledgements, site settings, administrators, configuration and activity.
 * Not here on purpose: resetting the site, changing the sign-in method (it needs a browser
 * sign-in) and creating MCP tokens (a token must not mint itself more power).
 */
import { acknowledgeIncident } from '../acknowledgements.ts'
import type { MaintenanceInput, PageInput, SinkInput } from '../config.ts'
import { type Deps, storedEnvKey } from '../deps.ts'
import { describeChanges, type Form, FormError, pageFromForm, pageList, putPage, putSink, removePage, removeSink, SINK_FIELDS, type SinkType, sinkEnvName, sinkFromForm } from '../admin/forms.ts'
import type { AdminConfig } from '../admin/security.ts'
import { listAudit, rotatePingToken, sendSinkTest } from '../admin/service.ts'
import { parseAdminYaml, stringifyAdminYaml } from '../admin/yaml.ts'
import { checkForUpdate } from '../updates.ts'
import { isValidTimeZone, nowSeconds } from '../util/time.ts'
import { APP_VERSION } from '../version.ts'
import type { ApiToken } from './tokens.ts'
import { at, iso, type Json, str, type Tool, ToolError } from './tool.ts'

interface Ctx {
  deps: Deps
  storedConfig: () => Promise<AdminConfig>
  save: (token: ApiToken, next: AdminConfig, secrets?: Array<{ name: string; value: string }>) => Promise<void>
  actor: (token: ApiToken) => string
}

const strings = { type: 'array', items: str }
const formErrors = <T>(fn: () => T): T => {
  try { return fn() } catch (e) { if (e instanceof FormError) throw new ToolError(e.message); throw e }
}

function pageView(p: PageInput, home: string | undefined) {
  const access = p.access === undefined || p.access === 'public' ? 'public' : 'private'
  return {
    slug: p.slug, title: p.title, description: p.description ?? null, url: `/${p.slug}`, home: p.slug === home, visibility: access,
    ...(access === 'private' && typeof p.access === 'object' && 'emails' in p.access ? { emails: p.access.emails ?? [] } : {}),
    monitors: p.monitors.includes('*') ? 'all' : p.monitors,
  }
}

/** A channel without its credentials: secret fields only say whether they are set. */
function channelView(name: string, sink: SinkInput) {
  const s = sink as unknown as Json
  const secret = new Set(SINK_FIELDS[sink.type].fields.filter((f) => f.secret).map((f) => f.key))
  const out: Json = { name, type: sink.type }
  for (const [key, value] of Object.entries(s)) {
    if (key === 'type') continue
    if (secret.has(key)) out[key] = value ? 'set' : 'not set'
    else if (key === 'via' && value && typeof value === 'object') {
      const via = value as Json
      out.via = Object.fromEntries(Object.entries(via).map(([k, v]) => [k, k === 'apiKey' || k === 'password' ? (v ? 'set' : 'not set') : v]))
    } else if (key !== 'headers') out[key] = value
  }
  return out
}

const CHANNEL_HELP = (Object.keys(SINK_FIELDS) as SinkType[]).map((type) => {
  const keys = type === 'email'
    ? 'to (array of addresses), via ("smtp", "resend" or "cloudflare"), from; SMTP: smtpHost, smtpPort, smtpSecurity ("starttls" or "tls"), smtpUsername, password; Resend: apiKey'
    : SINK_FIELDS[type].fields.map((f) => `${f.key}${f.optional ? ' (optional)' : ''}`).join(', ')
  return `${type}: ${keys}`
}).join('. ')

/** The fields a channel form would show today, so an update only changes what it names. */
function channelForm(sink: SinkInput): Form {
  const s = sink as unknown as Json
  const form: Form = { type: sink.type }
  for (const f of SINK_FIELDS[sink.type].fields) if (typeof s[f.key] === 'string' && !f.secret) form[f.key] = s[f.key]
  if (sink.type === 'email') {
    form.to = sink.to.join('\n')
    const via = sink.via
    if (via === 'cloudflare') form.via = 'cloudflare'
    else if (via.provider === 'resend') Object.assign(form, { via: 'resend', from: via.from })
    else Object.assign(form, { via: 'smtp', from: via.from, smtpHost: via.host, smtpPort: String(via.port), smtpSecurity: via.security, smtpUsername: via.username ?? '' })
  }
  return form
}

function settingsForm(args: Json): Form {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, Array.isArray(v) ? v.map(at).join('\n') : at(v)]))
}

export function adminTools({ deps, storedConfig, save, actor }: Ctx): Tool[] {
  const PAGE_FIELDS: Json = {
    title: str, description: { ...str, description: 'Optional. Shown under the title.' },
    visibility: { type: 'string', enum: ['public', 'private'] },
    emails: { ...strings, description: 'Private pages: who may see it, as emails or *@domain patterns.' },
    monitors: { ...strings, description: 'Monitor ids to show. Omit (or ["*"]) for every monitor.' },
  }
  const pageArgs = (args: Json, existing?: PageInput): Form => {
    const monitors = Array.isArray(args.monitors) ? args.monitors.map(at) : existing ? (existing.monitors.includes('*') ? ['*'] : existing.monitors) : ['*']
    const priorEmails = existing?.access && typeof existing.access === 'object' && 'emails' in existing.access ? existing.access.emails ?? [] : []
    return {
      title: at(args.title ?? existing?.title), description: at(args.description ?? existing?.description ?? ''), slug: at(args.slug),
      visibility: at(args.visibility ?? (existing && existing.access !== undefined && existing.access !== 'public' ? 'private' : 'public')),
      emails: (Array.isArray(args.emails) ? args.emails.map(at) : priorEmails).join('\n'),
      show: monitors.includes('*') ? 'all' : 'some', monitors: monitors.filter((m) => m !== '*'),
    }
  }

  return [
    // ── Status pages ────────────────────────────────────────────────────────────────────────
    {
      name: 'list_status_pages', scope: 'read', annotations: { title: 'List status pages', readOnlyHint: true },
      description: 'Every status page: its address, who can see it, which monitors it shows, and which one is the home page.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => { const config = await storedConfig(); const home = config.home ?? pageList(config)[0]?.slug; return { pages: pageList(config).map((p) => pageView(p, home)) } },
    },
    {
      name: 'add_status_page', scope: 'pages', annotations: { title: 'Add status page', readOnlyHint: false, destructiveHint: false },
      description: 'Add a status page. Public pages are open to anyone with the link; private pages need sign-in and an allowed email.',
      inputSchema: { type: 'object', required: ['title'], properties: { ...PAGE_FIELDS, slug: { ...str, description: 'Address, such as "api" for /api. Generated from the title when omitted.' } } },
      run: async (args, { token }) => {
        const config = await storedConfig()
        const page = formErrors(() => pageFromForm(pageArgs(args), undefined, new Set(pageList(config).map((p) => p.slug))))
        await save(token, putPage(config, page))
        return { added: pageView(page, config.home) }
      },
    },
    {
      name: 'update_status_page', scope: 'pages', annotations: { title: 'Change status page', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      description: 'Change a status page. Only the fields given change; the address stays the same.',
      inputSchema: { type: 'object', required: ['slug'], properties: { slug: { ...str, description: 'The page address, from list_status_pages.' }, ...PAGE_FIELDS } },
      run: async (args, { token }) => {
        const config = await storedConfig()
        const existing = pageList(config).find((p) => p.slug === at(args.slug))
        if (!existing) throw new ToolError(`No status page at /${at(args.slug)}.`)
        const page = formErrors(() => pageFromForm(pageArgs(args, existing), existing, new Set()))
        await save(token, putPage(config, page))
        return { updated: pageView(page, config.home ?? pageList(config)[0]?.slug) }
      },
    },
    {
      name: 'delete_status_page', scope: 'pages', annotations: { title: 'Delete status page', readOnlyHint: false, destructiveHint: true },
      description: 'Delete a status page. Monitors and their history are not affected. The last page cannot be deleted.',
      inputSchema: { type: 'object', required: ['slug'], properties: { slug: str } },
      run: async (args, { token }) => {
        const config = await storedConfig()
        if (!pageList(config).some((p) => p.slug === at(args.slug))) throw new ToolError(`No status page at /${at(args.slug)}.`)
        await save(token, formErrors(() => removePage(config, at(args.slug))))
        return { deleted: at(args.slug) }
      },
    },
    {
      name: 'set_home_page', scope: 'pages', annotations: { title: 'Set home page', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      description: "Choose which status page visitors see at the site's root address (/).",
      inputSchema: { type: 'object', required: ['slug'], properties: { slug: str } },
      run: async (args, { token }) => {
        const config = await storedConfig()
        if (!pageList(config).some((p) => p.slug === at(args.slug))) throw new ToolError(`No status page at /${at(args.slug)}.`)
        await save(token, { ...config, home: at(args.slug) })
        return { home: at(args.slug) }
      },
    },

    // ── Alert channels ──────────────────────────────────────────────────────────────────────
    {
      name: 'list_channels', scope: 'channels', annotations: { title: 'List alert channels', readOnlyHint: true },
      description: 'Every alert channel with its settings. Credentials are never returned, only whether they are set.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => ({ channels: Object.entries((await storedConfig()).sinks ?? {}).map(([name, sink]) => channelView(name, sink)) }),
    },
    {
      name: 'add_channel', scope: 'channels', annotations: { title: 'Add alert channel', readOnlyHint: false, destructiveHint: false },
      description: `Add an alert channel. Credentials are stored write-only. Settings by type: ${CHANNEL_HELP}.`,
      inputSchema: { type: 'object', required: ['name', 'type', 'settings'], properties: {
        name: { ...str, description: 'Letters, numbers, - and _. Monitors refer to the channel by this name.' },
        type: { type: 'string', enum: Object.keys(SINK_FIELDS) },
        settings: { type: 'object', description: 'The fields for this channel type (see the tool description).' },
      } },
      run: async (args, { token }) => {
        const config = await storedConfig()
        const name = at(args.name)
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw new ToolError('Use 1–40 letters, numbers, - or _ for the channel name.')
        if (config.sinks?.[name]) throw new ToolError(`A channel named "${name}" already exists.`)
        const settings = (args.settings && typeof args.settings === 'object' ? args.settings : {}) as Json
        const { sink, secrets } = formErrors(() => sinkFromForm({ ...settingsForm(settings), type: at(args.type) }, name, undefined))
        await save(token, putSink(config, name, sink), secrets)
        return { added: channelView(name, sink) }
      },
    },
    {
      name: 'update_channel', scope: 'channels', annotations: { title: 'Change alert channel', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      description: 'Change an alert channel. Only the settings given change; omitted credentials are kept.',
      inputSchema: { type: 'object', required: ['name', 'settings'], properties: { name: str, settings: { type: 'object' } } },
      run: async (args, { token }) => {
        const config = await storedConfig()
        const name = at(args.name)
        const existing = config.sinks?.[name]
        if (!existing) throw new ToolError(`No channel named "${name}".`)
        const settings = (args.settings && typeof args.settings === 'object' ? args.settings : {}) as Json
        const { sink, secrets } = formErrors(() => sinkFromForm({ ...channelForm(existing), ...settingsForm(settings) }, name, existing))
        await save(token, putSink(config, name, sink), secrets)
        return { updated: channelView(name, sink) }
      },
    },
    {
      name: 'delete_channel', scope: 'channels', annotations: { title: 'Delete alert channel', readOnlyHint: false, destructiveHint: true },
      description: 'Delete an alert channel and erase the credentials it stored. Monitors stop sending to it.',
      inputSchema: { type: 'object', required: ['name'], properties: { name: str } },
      run: async (args, { token }) => {
        const config = await storedConfig()
        const name = at(args.name)
        if (!config.sinks?.[name]) throw new ToolError(`No channel named "${name}".`)
        await save(token, removeSink(config, name))
        const prefix = storedEnvKey(sinkEnvName(name, ''))
        await deps.db.run(`DELETE FROM instance_secrets WHERE substr(name, 1, ?) = ?`, [prefix.length, prefix])
        return { deleted: name }
      },
    },
    {
      name: 'test_channel', scope: 'channels', annotations: { title: 'Send test alert', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: 'Send one test alert through a channel to check it works.',
      inputSchema: { type: 'object', required: ['name'], properties: { name: str } },
      run: async (args) => {
        const name = at(args.name)
        try { await sendSinkTest(name, await storedConfig(), deps.getEnv, deps.fetch, deps) } catch (error) { throw new ToolError(`The test alert to "${name}" failed: ${(error as Error).message}`) }
        return { sent: name }
      },
    },

    // ── Monitors: ping URLs and maintenance ─────────────────────────────────────────────────
    {
      name: 'rotate_ping_url', scope: 'monitors', annotations: { title: 'Replace ping URL', readOnlyHint: false, destructiveHint: true },
      description: 'Give a scheduled-job monitor a new secret ping URL. The old URL stops working at once, so update the job too.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: { ...str, description: 'A scheduled-job (push) monitor id.' } } },
      run: async (args, { token }) => {
        const pingToken = await rotatePingToken(deps.db, at(args.id), actor(token), nowSeconds())
        if (!pingToken) throw new ToolError(`"${at(args.id)}" is not a scheduled-job monitor.`)
        return { id: at(args.id), pingUrl: `${deps.config.baseUrl.replace(/\/+$/, '')}/ping/${pingToken}`, note: 'Keep the ping URL secret. It is not shown again.' }
      },
    },
    {
      name: 'list_maintenance', scope: 'read', annotations: { title: 'List maintenance windows', readOnlyHint: true },
      description: 'Planned maintenance windows, one-off or recurring, with their position for delete_maintenance.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => ({ maintenance: ((await storedConfig()).maintenance ?? []).map((m, index) => ({ index, ...m })) }),
    },
    {
      name: 'add_maintenance', scope: 'monitors', annotations: { title: 'Add maintenance window', readOnlyHint: false, destructiveHint: false },
      description: 'Plan maintenance: give start and end (ISO 8601) for a one-off window, or schedule (cron), duration and optional tz for a recurring one. Affected monitors show maintenance instead of an outage.',
      inputSchema: { type: 'object', required: ['title', 'monitors'], properties: {
        title: str, monitors: { description: 'Monitor ids, or "*" for every monitor.', anyOf: [strings, { type: 'string', enum: ['*'] }] },
        start: str, end: str, schedule: str, duration: { ...str, description: 'Such as 30m or 2h.' }, tz: str,
        excludeFromUptime: { type: 'boolean', description: 'Default true.' },
      } },
      run: async (args, { token }) => {
        const config = await storedConfig()
        const monitors = args.monitors === '*' ? '*' : Array.isArray(args.monitors) ? args.monitors.map(at) : []
        const base = { title: at(args.title), monitors, ...(typeof args.excludeFromUptime === 'boolean' ? { excludeFromUptime: args.excludeFromUptime } : {}) }
        const window: MaintenanceInput = args.schedule
          ? { ...base, schedule: at(args.schedule), duration: at(args.duration), ...(args.tz ? { tz: at(args.tz) } : {}) } as MaintenanceInput
          : { ...base, start: at(args.start), end: at(args.end) } as MaintenanceInput
        await save(token, { ...config, maintenance: [...(config.maintenance ?? []), window] })
        return { added: window }
      },
    },
    {
      name: 'delete_maintenance', scope: 'monitors', annotations: { title: 'Delete maintenance window', readOnlyHint: false, destructiveHint: true },
      description: 'Delete a maintenance window by its index from list_maintenance. The title must match, so a stale index cannot delete the wrong window.',
      inputSchema: { type: 'object', required: ['index', 'title'], properties: { index: { type: 'integer', minimum: 0 }, title: str } },
      run: async (args, { token }) => {
        const config = await storedConfig()
        const list = config.maintenance ?? []
        const index = Number(args.index)
        if (!Number.isInteger(index) || list[index]?.title !== at(args.title)) throw new ToolError('No maintenance window with that index and title. Call list_maintenance again.')
        await save(token, { ...config, maintenance: list.filter((_, i) => i !== index) })
        return { deleted: list[index] }
      },
    },

    // ── Incidents: acknowledge an alert ─────────────────────────────────────────────────────
    {
      name: 'acknowledge_alert', scope: 'incidents', annotations: { title: 'Acknowledge alert', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      description: 'Acknowledge an open outage so its escalating alerts stop. Use the id of a detected incident from list_incidents or get_status.',
      inputSchema: { type: 'object', required: ['incidentId'], properties: { incidentId: { type: 'integer' } } },
      run: async (args, { token }) => {
        const id = Number(args.incidentId)
        const incident = Number.isSafeInteger(id) ? await deps.db.first<{ id: number; monitor_id: string }>(`SELECT id, monitor_id FROM incidents WHERE id = ? AND severity = 'outage' AND resolved_at IS NULL`, [id]) : null
        if (!incident) throw new ToolError(`No open outage with the id ${at(args.incidentId)}.`)
        const created = await acknowledgeIncident(deps.db, id, actor(token), 'admin-page', nowSeconds())
        return { incidentId: id, monitorId: incident.monitor_id, acknowledged: true, alreadyAcknowledged: !created }
      },
    },

    // ── Settings ────────────────────────────────────────────────────────────────────────────
    {
      name: 'get_settings', scope: 'settings', annotations: { title: 'Get settings', readOnlyHint: true },
      description: 'Site title, address and timezone, update checks, administrators, sign-in method and installed version.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        const config = await storedConfig()
        const p = config.access?.provider
        const update = await checkForUpdate({ db: deps.db, config: deps.config, fetch: deps.fetch, now: nowSeconds() })
        return {
          title: config.title, baseUrl: config.baseUrl, timezone: config.timezone ?? 'UTC', updateChecks: config.updates?.enabled === true,
          administrators: config.access?.admins?.emails ?? [], signInMethod: p ? (p.type === 'oidc' ? { type: 'oidc', issuer: p.issuer } : p.type === 'cloudflare-access' ? { type: 'cloudflare-access', teamDomain: p.teamDomain } : { type: 'basic' }) : null,
          version: APP_VERSION, update: { result: update.result, availableVersion: update.targetVersion, checkedAt: iso(update.checkedAt) },
        }
      },
    },
    {
      name: 'update_settings', scope: 'settings', annotations: { title: 'Change settings', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      description: 'Change the site title, public address, timezone, or whether to check for StatusPing updates. Only the fields given change.',
      inputSchema: { type: 'object', properties: { title: str, baseUrl: { ...str, description: 'Public address, such as https://status.example.com.' }, timezone: { ...str, description: 'IANA timezone, such as Europe/London.' }, updateChecks: { type: 'boolean' } } },
      run: async (args, { token }) => {
        const config = await storedConfig()
        const next: AdminConfig = { ...config }
        if (args.title !== undefined) { const title = at(args.title).trim().slice(0, 80); if (!title) throw new ToolError('The title cannot be empty.'); next.title = title }
        if (args.baseUrl !== undefined) {
          const baseUrl = at(args.baseUrl).replace(/\/+$/, '')
          try { if (!['https:', 'http:'].includes(new URL(baseUrl).protocol)) throw new Error() } catch { throw new ToolError('Enter the address as a full URL, such as https://status.example.com.') }
          next.baseUrl = baseUrl
        }
        if (args.timezone !== undefined) { if (!isValidTimeZone(at(args.timezone))) throw new ToolError(`"${at(args.timezone)}" is not a timezone.`); next.timezone = at(args.timezone) }
        if (args.updateChecks === true) next.updates = { ...(config.updates ?? {}), enabled: true }
        else if (args.updateChecks === false) delete next.updates
        await save(token, next)
        return { title: next.title, baseUrl: next.baseUrl, timezone: next.timezone ?? 'UTC', updateChecks: next.updates?.enabled === true }
      },
    },
    {
      name: 'set_administrators', scope: 'settings', annotations: { title: 'Set administrators', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      description: 'Replace the list of people who can open Settings, as emails or *@domain patterns. At least one is required.',
      inputSchema: { type: 'object', required: ['emails'], properties: { emails: strings } },
      run: async (args, { token }) => {
        const config = await storedConfig()
        const emails = (Array.isArray(args.emails) ? args.emails.map(at) : []).map((e) => e.trim().toLowerCase()).filter(Boolean)
        if (!config.access) throw new ToolError('No sign-in method is configured.')
        if (!emails.length && !config.access.admins?.teams?.length) throw new ToolError('Keep at least one administrator.')
        await save(token, { ...config, access: { ...config.access, admins: { ...(config.access.admins ?? {}), emails } } })
        return { administrators: emails }
      },
    },
    {
      name: 'check_for_updates', scope: 'settings', annotations: { title: 'Check for updates', readOnlyHint: true, openWorldHint: true },
      description: 'Check the signed StatusPing release manifest for a newer version now.',
      inputSchema: { type: 'object', properties: {} },
      run: async (_args, { token }) => {
        const result = await checkForUpdate({ db: deps.db, config: deps.config, fetch: deps.fetch, now: nowSeconds(), force: true })
        await deps.db.run(`INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, 'update.check', ?, NULL, NULL, ?)`, [actor(token), result.targetVersion ? `release:${result.targetVersion}` : 'release:none', nowSeconds()])
        return { installed: APP_VERSION, result: result.result, availableVersion: result.targetVersion, checkedAt: iso(result.checkedAt) }
      },
    },
    {
      name: 'get_configuration', scope: 'settings', annotations: { title: 'Export configuration', readOnlyHint: true },
      description: 'The whole configuration as YAML, as Settings → Configuration exports it. Credentials are not included, only the names they are stored under.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => ({ yaml: stringifyAdminYaml(await storedConfig()) }),
    },
    {
      name: 'import_configuration', scope: 'settings', annotations: { title: 'Import configuration', readOnlyHint: false, destructiveHint: true },
      description: 'Replace the whole configuration with YAML. By default this only previews the changes; pass apply: true to save. The sign-in method always stays as it is.',
      inputSchema: { type: 'object', required: ['yaml'], properties: { yaml: str, apply: { type: 'boolean', description: 'Save the changes. Default false (preview only).' } } },
      run: async (args, { token }) => {
        const current = await storedConfig()
        const yaml = at(args.yaml)
        if (yaml.length > 262_144) throw new ToolError('Configuration files must be 256 KB or smaller.')
        let parsed: unknown
        try { parsed = parseAdminYaml(yaml) } catch (error) { throw new ToolError(`The YAML is invalid: ${(error as Error).message}`) }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ToolError('The file must contain a StatusPing configuration.')
        const next = { ...(parsed as AdminConfig), admin: true }
        if (current.access) next.access = { ...(next.access ?? {}), provider: current.access.provider } as AdminConfig['access']
        if (!next.access?.admins?.emails?.length && !next.access?.admins?.teams?.length) throw new ToolError('The configuration must keep at least one administrator.')
        const changes = describeChanges(current, next)
        if (args.apply !== true) return { preview: true, changes, note: 'Nothing was saved. Call again with apply: true to save.' }
        await save(token, next)
        return { applied: true, changes }
      },
    },
    {
      name: 'get_activity', scope: 'settings', annotations: { title: 'Get activity', readOnlyHint: true },
      description: 'Recent changes to the site: who changed what, and when. Secret values are never recorded.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 50.' } } },
      run: async (args) => ({ activity: (await listAudit(deps.db, typeof args.limit === 'number' ? args.limit : 50)).map((e) => ({ at: iso(e.at), actor: e.actor, action: e.action, target: e.target })) }),
    },
  ]
}
