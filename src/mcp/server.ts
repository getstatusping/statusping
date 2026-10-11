/**
 * A remote MCP server at /mcp (Streamable HTTP, stateless JSON responses). Clients sign in with
 * a bearer token created in Settings → MCP; each token's scopes decide which tools it sees.
 */
import type { Context, Hono } from 'hono'
import { createAnnouncement, listAnnouncements, parseAnnouncementCreate, parseAnnouncementPatch, patchAnnouncement } from '../announcements.ts'
import type { MonitorInput } from '../config.ts'
import { type Deps, refreshAdminConfig, storedEnvKey } from '../deps.ts'
import { type Form, FormError, findMonitor, monitorFromForm, monitorRows, putMonitor, removeMonitor } from '../admin/forms.ts'
import { loadAdminConfig, rotatePingToken, saveAdminConfig } from '../admin/service.ts'
import { type AdminConfig, validateAdminConfig } from '../admin/security.ts'
import { dispatchAnnouncementNotifications, enqueueAnnouncementNotifications } from '../notify/announcements.ts'
import { dispatchSubscriberOutbox, enqueueAnnouncement } from '../subscribers.ts'
import { syncConfig } from '../sync.ts'
import { nowSeconds } from '../util/time.ts'
import { APP_VERSION } from '../version.ts'
import { loadMonitorDetail, loadStatusData } from '../web/data.ts'
import { type ApiToken, authenticateApiToken } from './tokens.ts'
import { adminTools } from './admin-tools.ts'
import { at, iso, type Json, str, type Tool, ToolError } from './tool.ts'

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']


const MONITOR_FIELDS: Json = {
  name: { ...str, description: 'Display name.' },
  description: { ...str, description: 'Optional note shown under the name.' },
  group: { ...str, description: 'Group on the status page. Defaults to the first group.' },
  url: { ...str, description: 'Website monitors: the http(s) URL to check.' },
  keyword: { ...str, description: 'Website monitors: text the response must contain.' },
  expectStatus: { ...str, description: 'Website monitors: expected status, such as 200 or 2xx.' },
  host: { ...str, description: 'TCP monitors: host name or IP address.' },
  port: { type: 'integer', minimum: 1, maximum: 65535, description: 'TCP monitors: port.' },
  interval: { ...str, description: 'Website and TCP monitors: how often to check, such as 1m, 5m or 1h.' },
  retries: { type: 'integer', minimum: 0, maximum: 10, description: 'Website and TCP monitors: failed checks before an outage.' },
  period: { ...str, description: 'Scheduled jobs: expected ping interval, such as 1h or 1d.' },
  schedule: { ...str, description: 'Scheduled jobs: cron expression instead of a period.' },
  tz: { ...str, description: 'Scheduled jobs: timezone for the cron expression.' },
  grace: { ...str, description: 'Scheduled jobs: how late a ping may be, such as 10m.' },
  maxRuntime: { ...str, description: 'Scheduled jobs: longest expected run, such as 30m.' },
}

/** A monitor's editable fields as the Settings form would show them. */
function monitorForm(m: MonitorInput): Form {
  const o = m as unknown as Json
  return Object.fromEntries(['name', 'description', 'url', 'keyword', 'expectStatus', 'host', 'port', 'interval', 'retries', 'period', 'schedule', 'tz', 'grace', 'maxRuntime']
    .filter((k) => o[k] !== undefined && typeof o[k] !== 'object').map((k) => [k, at(o[k])]))
}

export function mountMcp(app: Hono, deps: Deps): void {
  const storedConfig = async (): Promise<AdminConfig> => (await loadAdminConfig(deps.db))?.config ?? deps.configInput
  const actor = (token: ApiToken) => `mcp:${token.name}`

  const save = async (token: ApiToken, next: AdminConfig, secrets: Array<{ name: string; value: string }> = []) => {
    // Credentials are checked against the values about to be stored, then stored before the config that names them.
    const pending = new Map(secrets.map((s) => [s.name, s.value]))
    const getEnv = (name: string) => pending.get(name) ?? deps.getEnv(name)
    try { validateAdminConfig({ ...next, admin: true }, getEnv) } catch (error) { throw new ToolError((error as Error).message) }
    const now = nowSeconds()
    if (secrets.length) {
      await deps.db.batch([
        ...secrets.map(({ name, value }) => ({ sql: `INSERT INTO instance_secrets (name, value, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`, params: [storedEnvKey(name), value, now] })),
        ...secrets.map(({ name }) => ({ sql: `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, 'setting.store', ?, NULL, NULL, ?)`, params: [actor(token), name, now] })),
      ])
      await refreshAdminConfig(deps, now)
    }
    await saveAdminConfig(deps.db, { ...next, admin: true }, actor(token), now, getEnv)
    await refreshAdminConfig(deps, now)
  }

  const announce = (c: Context, announcement: Awaited<ReturnType<typeof createAnnouncement>>, key: string) => {
    const work = Promise.all([
      enqueueAnnouncement(deps, announcement, key, nowSeconds()).then(() => dispatchSubscriberOutbox(deps, nowSeconds())),
      enqueueAnnouncementNotifications(deps, announcement, nowSeconds()).then(() => dispatchAnnouncementNotifications(deps, nowSeconds())),
    ]).catch((e) => deps.log('error', 'background task failed', { error: (e as Error).message }))
    try { c.executionCtx.waitUntil(work) } catch { /* Node: keeps running on its own. */ }
  }

  const knownMonitors = () => new Set(deps.config.monitors.map((m) => m.id))

  const TOOLS: Tool[] = [
    {
      name: 'get_status', scope: 'read', annotations: { title: 'Get status', readOnlyHint: true },
      description: 'Overall status of the site: every monitor with its current state and uptime, open incidents, and active or upcoming maintenance.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        const d = await loadStatusData(deps, nowSeconds())
        return {
          site: deps.config.title, url: deps.config.baseUrl, generatedAt: iso(d.now), lastCheckRun: iso(d.lastTickAt), counts: d.counts,
          monitors: d.groups.flatMap((g) => g.monitors.map((m) => ({
            id: m.monitor.id, name: m.monitor.name, group: g.name, kind: m.monitor.kind, status: m.state.status, since: iso(m.state.status_since),
            uptime24h: m.uptime24h, uptime90d: m.uptime90, lastError: m.state.last_error,
          }))),
          openIncidents: d.openIncidents.map((i) => ({ id: i.id, monitorId: i.monitorId, monitor: i.monitorName, reason: i.reason, detail: i.detail, startedAt: iso(i.startedAt) })),
          warnings: d.openWarnings.map((i) => ({ monitorId: i.monitorId, monitor: i.monitorName, reason: i.reason, detail: i.detail, startedAt: iso(i.startedAt) })),
          announcements: d.announcements.filter((a) => a.status !== 'resolved'),
          maintenance: { active: d.activeMaintenance, upcoming: d.upcomingMaintenance },
        }
      },
    },
    {
      name: 'get_monitor', scope: 'read', annotations: { title: 'Get monitor', readOnlyHint: true },
      description: 'One monitor in detail: what it checks, its state, recent check results or pings, and recent incidents.',
      inputSchema: { type: 'object', properties: { id: { ...str, description: 'Monitor id, as returned by get_status.' } }, required: ['id'] },
      run: async (args) => {
        const d = await loadMonitorDetail(deps, at(args.id), nowSeconds())
        if (!d) throw new ToolError(`No monitor with the id "${at(args.id)}".`)
        const m = d.view.monitor as unknown as Json
        return {
          id: m.id, name: m.name, kind: m.kind, target: m.kind === 'http' ? { url: typeof m.url === 'string' ? m.url : '(from a secret)' } : m.kind === 'tcp' ? { host: m.host, port: m.port } : { period: m.period ?? null, schedule: m.schedule ?? null },
          status: d.view.state.status, since: iso(d.view.state.status_since), lastError: d.view.state.last_error, uptime24h: d.view.uptime24h, uptime90d: d.view.uptime90,
          recentChecks: d.checks.slice(0, 20).map((c) => ({ ...c, at: iso(c.at) })),
          recentPings: d.pings.slice(0, 20).map((p) => ({ kind: p.kind, exitCode: p.exit_code, durationMs: p.duration_ms, at: iso(p.received_at) })),
          incidents: d.incidents.slice(0, 20).map((i) => ({ id: i.id, reason: i.reason, severity: i.severity, detail: i.detail, startedAt: iso(i.startedAt), resolvedAt: iso(i.resolvedAt) })),
        }
      },
    },
    {
      name: 'list_incidents', scope: 'read', annotations: { title: 'List incidents', readOnlyHint: true },
      description: 'Outages detected by the monitors and incident announcements posted by people, newest first.',
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'resolved'] }, days: { type: 'integer', minimum: 1, maximum: 90, description: 'How far back to look. Default 30.' } } },
      run: async (args) => {
        const status = args.status === 'open' || args.status === 'resolved' ? args.status : undefined
        const days = typeof args.days === 'number' && args.days >= 1 && args.days <= 90 ? Math.floor(args.days) : 30
        const since = nowSeconds() - days * 86_400
        const detected = await deps.db.all<{ id: number; monitor_id: string; reason: string; severity: string; detail: string | null; started_at: number; resolved_at: number | null }>(
          `SELECT id, monitor_id, reason, severity, detail, started_at, resolved_at FROM incidents WHERE started_at >= ?${status === 'open' ? ' AND resolved_at IS NULL' : status === 'resolved' ? ' AND resolved_at IS NOT NULL' : ''} ORDER BY started_at DESC LIMIT 200`, [since])
        return {
          detected: detected.map((i) => ({ id: i.id, monitorId: i.monitor_id, reason: i.reason, severity: i.severity, detail: i.detail, startedAt: iso(i.started_at), resolvedAt: iso(i.resolved_at) })),
          announcements: await listAnnouncements(deps.db, { status, since }),
        }
      },
    },
    {
      name: 'create_incident', scope: 'incidents', annotations: { title: 'Post incident', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: 'Post an incident announcement on the status pages. Subscribers and alert channels may be notified.',
      inputSchema: {
        type: 'object', required: ['title', 'impact', 'monitors', 'message'],
        properties: {
          title: { ...str, description: 'Short headline.' },
          impact: { type: 'string', enum: ['none', 'minor', 'major', 'maintenance'] },
          status: { type: 'string', enum: ['investigating', 'identified', 'monitoring', 'resolved'], description: 'Default investigating.' },
          monitors: { type: 'array', items: str, description: 'Ids of the affected monitors.' },
          message: { ...str, description: 'The first update, shown to visitors.' },
        },
      },
      run: async (args, { c }) => {
        const input = parseAnnouncementCreate({ title: args.title, impact: args.impact, status: args.status ?? 'investigating', monitors: args.monitors, body: args.message })
        if (!input) throw new ToolError('Invalid incident: check the title, impact, status, monitors and message.')
        const known = knownMonitors()
        const unknown = input.monitors.filter((id) => !known.has(id))
        if (unknown.length) throw new ToolError(`Unknown monitor: ${unknown.join(', ')}.`)
        const announcement = await createAnnouncement(deps.db, input, nowSeconds())
        announce(c, announcement, 'created')
        return announcement
      },
    },
    {
      name: 'update_incident', scope: 'incidents', annotations: { title: 'Update incident', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: 'Add an update to an incident announcement, change its status, or resolve it (status "resolved").',
      inputSchema: {
        type: 'object', required: ['id'],
        properties: {
          id: { type: 'integer', description: 'Announcement id from list_incidents.' },
          status: { type: 'string', enum: ['investigating', 'identified', 'monitoring', 'resolved'] },
          message: { ...str, description: 'Update shown to visitors.' },
          title: str, impact: { type: 'string', enum: ['none', 'minor', 'major', 'maintenance'] },
          monitors: { type: 'array', items: str },
        },
      },
      run: async (args, { c }) => {
        const id = Number(args.id)
        const input = parseAnnouncementPatch({ ...(args.title !== undefined ? { title: args.title } : {}), ...(args.impact !== undefined ? { impact: args.impact } : {}), ...(args.status !== undefined ? { status: args.status } : {}), ...(args.message !== undefined ? { body: args.message } : {}), ...(args.monitors !== undefined ? { monitors: args.monitors } : {}) })
        if (!Number.isSafeInteger(id) || id < 1 || !input) throw new ToolError('Invalid update: give an announcement id and at least one change.')
        const known = knownMonitors()
        if (input.monitors?.some((m) => !known.has(m))) throw new ToolError('Unknown monitor.')
        const announcement = await patchAnnouncement(deps.db, id, input, nowSeconds())
        if (!announcement) throw new ToolError(`No announcement with the id ${id}.`)
        if (input.status !== undefined || input.body !== undefined) announce(c, announcement, `update:${announcement.updates[0]?.id ?? announcement.id}`)
        return announcement
      },
    },
    {
      name: 'add_monitor', scope: 'monitors', annotations: { title: 'Add monitor', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: 'Add a monitor: a website (kind "http"), a TCP port ("tcp"), or a scheduled job that pings in ("push"). For a scheduled job, the result includes its secret ping URL.',
      inputSchema: { type: 'object', required: ['kind', 'name'], properties: { kind: { type: 'string', enum: ['http', 'tcp', 'push'] }, id: { ...str, description: 'Optional id; generated from the name.' }, ...MONITOR_FIELDS } },
      run: async (args, { token }) => {
        const config = await storedConfig()
        const form: Form = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, at(v)]))
        let monitor: MonitorInput
        try { monitor = monitorFromForm(form, undefined, new Set(monitorRows(config).map((r) => r.monitor.id))) } catch (e) { if (e instanceof FormError) throw new ToolError(e.message); throw e }
        const group = at(args.group) || (config.groups ?? [])[0]?.name || 'Services'
        await save(token, putMonitor(config, monitor, group))
        // The monitors table is normally synced on the next check run; a ping URL needs the row now.
        if (monitor.kind === 'push') await syncConfig(deps, nowSeconds())
        const pingToken = monitor.kind === 'push' ? await rotatePingToken(deps.db, monitor.id, actor(token), nowSeconds()) : null
        return { added: monitor, group, ...(pingToken ? { pingUrl: `${deps.config.baseUrl.replace(/\/+$/, '')}/ping/${pingToken}`, note: 'Keep the ping URL secret. It is not shown again.' } : {}) }
      },
    },
    {
      name: 'update_monitor', scope: 'monitors', annotations: { title: 'Change monitor', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: 'Change a monitor. Only the fields given are changed; its kind and id stay the same.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: { ...str, description: 'Monitor id.' }, ...MONITOR_FIELDS } },
      run: async (args, { token }) => {
        const config = await storedConfig()
        const row = findMonitor(config, at(args.id))
        if (!row) throw new ToolError(`No monitor with the id "${at(args.id)}".`)
        const changes = Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'id' && k !== 'group').map(([k, v]) => [k, at(v)]))
        let monitor: MonitorInput
        try { monitor = monitorFromForm({ ...monitorForm(row.monitor), ...changes }, row.monitor, new Set()) } catch (e) { if (e instanceof FormError) throw new ToolError(e.message); throw e }
        const group = at(args.group) || row.group
        await save(token, putMonitor(config, monitor, group))
        return { updated: monitor, group }
      },
    },
    {
      name: 'delete_monitor', scope: 'monitors', annotations: { title: 'Delete monitor', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      description: 'Delete a monitor and remove it from every status page. Its history is kept but no longer shown.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: { ...str, description: 'Monitor id.' } } },
      run: async (args, { token }) => {
        const config = await storedConfig()
        const id = at(args.id)
        if (!findMonitor(config, id)) throw new ToolError(`No monitor with the id "${id}".`)
        await save(token, removeMonitor(config, id))
        return { deleted: id }
      },
    },
    ...adminTools({ deps, storedConfig, save, actor }),
  ]

  const rpc = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result })
  const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

  app.all('/mcp', async (c) => {
    if (!deps.adminEnabled) return c.text('Not found', 404)
    if (c.req.method !== 'POST') return c.text('Method not allowed', 405, { allow: 'POST' })
    // Browsers may only call from this site's own origin (guards against DNS rebinding).
    const origin = c.req.header('origin')
    if (origin && origin !== new URL(deps.config.baseUrl).origin) return c.text('Forbidden', 403)
    const token = await authenticateApiToken(deps.db, c.req.header('authorization'), nowSeconds())
    if (!token) return c.json(rpcError(null, -32001, 'Unauthorized: create a token in Settings → MCP.'), 401, { 'www-authenticate': 'Bearer realm="statusping"' })
    let msg: Json
    try { msg = await c.req.json() } catch { return c.json(rpcError(null, -32700, 'Parse error'), 400) }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return c.json(rpcError(null, -32600, 'Invalid request'), 400)
    // Notifications and responses need no reply.
    if (msg.id === undefined) return c.body(null, 202)
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Json
    const tools = TOOLS.filter((t) => token.scopes.includes(t.scope))
    const headers = { 'cache-control': 'no-store' }
    switch (msg.method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        return c.json(rpc(msg.id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'statusping', title: `StatusPing · ${deps.config.title}`, version: APP_VERSION },
          instructions: `StatusPing status site "${deps.config.title}" at ${deps.config.baseUrl}. This token can: ${token.scopes.join(', ')}. Times are ISO 8601 UTC.`,
        }), 200, headers)
      }
      case 'ping': return c.json(rpc(msg.id, {}), 200, headers)
      case 'tools/list':
        return c.json(rpc(msg.id, { tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) }), 200, headers)
      case 'tools/call': {
        const tool = tools.find((t) => t.name === params.name)
        if (!tool) return c.json(rpcError(msg.id, -32602, TOOLS.some((t) => t.name === params.name) ? `This token is not allowed to use ${String(params.name)}.` : `Unknown tool: ${String(params.name)}`), 200, headers)
        const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Json
        try {
          const result = await tool.run(args, { token, c })
          return c.json(rpc(msg.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result }), 200, headers)
        } catch (error) {
          if (!(error instanceof ToolError)) deps.log('error', 'mcp tool failed', { tool: tool.name, error: (error as Error).message })
          return c.json(rpc(msg.id, { content: [{ type: 'text', text: error instanceof ToolError ? error.message : 'The tool failed. See the server log.' }], isError: true }), 200, headers)
        }
      }
      default: return c.json(rpcError(msg.id, -32601, `Method not found: ${msg.method}`), 200, headers)
    }
  })
}
