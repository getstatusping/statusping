import type { Context, Hono } from 'hono'
import { currentViewer, sameOrigin, signInResponse } from '../auth/providers.ts'
import type { Viewer } from '../auth/viewer.ts'
import type { MonitorInput, PageInput, SinkInput } from '../config.ts'
import type { Deps } from '../deps.ts'
import { isStorableEnv, refreshAdminConfig, storedEnvKey } from '../deps.ts'
import { isValidTimeZone, nowSeconds } from '../util/time.ts'
import {
  describeChanges, findMonitor, type Form, FormError, monitorFromForm, monitorRows, pageFromForm, pageList, putMonitor, putPage, putSink,
  removeMonitor, removePage, removeSink, SINK_FIELDS, sinkEnvName, sinkFromForm, type SinkType, text,
} from './forms.ts'
import {
  accessPage, activityPage, mcpPage, mcpTokenCreated, channelForm, channelsPage, generalPage, configurationPage, importPreview, monitorForm, monitorsPage,
  pageForm, pagesPage, pingUrlPage, type SecretSource,
} from './ui.ts'
import { appendAudit, listAudit, loadAdminConfig, rotatePingToken, saveAdminConfig, sendSinkTest } from './service.ts'
import { type AdminConfig, authorizeAdminToken, canAdmin, issueCsrfToken, validateAdminConfig, verifyCsrfToken } from './security.ts'
import { parseAdminYaml, stringifyAdminYaml } from './yaml.ts'
import { beginSetup } from '../setup/state.ts'
import { deleteCookie } from 'hono/cookie'
import { checkForUpdate } from '../updates.ts'
import { mountAccessSwitch } from './access-switch.ts'
import { createApiToken, isMcpScope, listApiTokens, revokeApiToken } from '../mcp/tokens.ts'
import { APP_VERSION } from '../version.ts'

const noStore = { 'cache-control': 'no-store' }

function notFound(c: Context) { return c.text('Not found', 404) }

/** Fixed confirmation messages, chosen by a short code in the URL (never free text). */
const NOTICES: Record<string, string> = {
  'general-saved': 'Site settings saved.',
  'monitor-added': 'Monitor added. Checks start within a minute.',
  'monitor-saved': 'Monitor saved.',
  'monitor-deleted': 'Monitor deleted.',
  'page-added': 'Status page added.',
  'page-saved': 'Status page saved.',
  'page-deleted': 'Status page deleted.',
  'channel-added': 'Alert channel added. Send a test to check it.',
  'channel-saved': 'Alert channel saved.',
  'channel-deleted': 'Alert channel deleted.',
  'test-sent': 'Test alert sent.',
  'admins-saved': 'Administrators saved.',
  imported: 'Configuration imported.',
  'updates-saved': 'Update checks saved.',
  'method-saved': 'Saved.',
  'method-started': 'Set up the new method below. The current one keeps working until you switch.',
  'method-cancelled': 'The sign-in method was not changed.',
  'method-expired': 'That change expired after an hour. Start again.',
  'method-changed': 'Sign-in method changed. Everyone else signs in again with the new method.',
  'mcp-token-revoked': 'Token revoked. Clients using it can no longer connect.',
  'home-saved': 'Home page changed.',
  'update-available': 'A new version is available.',
  'update-current': 'This installation is up to date.',
  'update-incompatible': 'A newer version is available but cannot be applied directly.',
  'update-failed': 'The update manifest could not be verified.',
  'update-disabled': 'Update checks are off.',
}

const providerSummary = (config: AdminConfig) => {
  const p = config.access?.provider
  if (!p) return 'No sign-in method is configured.'
  if (p.type === 'basic') return 'Email and password.'
  if (p.type === 'cloudflare-access') return `Cloudflare Access (${p.teamDomain}).`
  return `Single sign-on with ${p.issuer}.`
}

/** Adds the browser Settings pages and the bearer-token JSON API. */
export function mountAdminRoutes(app: Hono, deps: Deps): void {
  const enabled = () => deps.adminEnabled
  const browserAdmin = async (c: Context) => {
    if (!enabled()) return null
    const viewer = await currentViewer(c, deps)
    if (!viewer) return signInResponse(c, deps)
    if (!canAdmin(viewer, deps.config)) return c.text('Forbidden', 403, noStore)
    return viewer
  }
  const apiAdmin = (c: Context) => {
    if (!enabled()) return null
    return authorizeAdminToken(c.req.header('authorization'), deps.getEnv)
  }
  const storedConfig = async (): Promise<AdminConfig> => (await loadAdminConfig(deps.db))?.config ?? deps.configInput
  const bodyJson = async (c: Context): Promise<unknown | null> => {
    try { return await c.req.json() } catch { return null }
  }

  /** A signed-in administrator viewing a page, with a fresh CSRF value for its forms. */
  const view = async (c: Context): Promise<Response | { viewer: Viewer; csrf: string; config: AdminConfig; notice?: string }> => {
    const viewer = await browserAdmin(c)
    if (viewer === null) return notFound(c)
    if (viewer instanceof Response) return viewer
    const csrf = await issueCsrfToken(deps.db, c, nowSeconds())
    if (!csrf) return c.text('Your session is invalid. Please sign in again.', 401, noStore)
    return { viewer, csrf, config: await storedConfig(), notice: NOTICES[c.req.query('notice') ?? ''] }
  }

  /** A same-origin form post with a valid CSRF value, plus a fresh value to re-render with. */
  const post = async (c: Context): Promise<Response | { viewer: Viewer; form: Form; csrf: string; config: AdminConfig }> => {
    const viewer = await browserAdmin(c)
    if (viewer === null) return notFound(c)
    if (viewer instanceof Response) return viewer
    if (!sameOrigin(c, deps)) return c.text('Forbidden', 403, noStore)
    const form = await c.req.parseBody({ all: true }).catch(() => ({})) as Form
    if (!(await verifyCsrfToken(deps.db, c, form.csrf, nowSeconds()))) return c.text('Forbidden', 403, noStore)
    return { viewer, form, csrf: (await issueCsrfToken(deps.db, c, nowSeconds())) ?? '', config: await storedConfig() }
  }

  const done = (c: Context, path: string, notice: string) => {
    const res = c.redirect(`${path}?notice=${notice}`, 303)
    res.headers.set('cache-control', 'no-store')
    return res
  }

  /**
   * Validates and saves a whole new config. Refuses changes that would lock the saving
   * administrator out. Returns an error message for the form, or null when saved.
   */
  const save = async (viewer: Viewer, next: AdminConfig, secrets: Array<{ name: string; value: string }> = []): Promise<string | null> => {
    let normalized
    try { normalized = validateAdminConfig({ ...next, admin: true }, deps.getEnv).normalized } catch (error) { return (error as Error).message }
    if (!canAdmin(viewer, normalized)) return 'This change would remove your own access to Settings. Ask another administrator to make it.'
    const now = nowSeconds()
    if (secrets.length) {
      await deps.db.batch([
        ...secrets.map(({ name, value }) => ({
          sql: `INSERT INTO instance_secrets (name, value, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
          params: [storedEnvKey(name), value, now],
        })),
        ...secrets.map(({ name }) => ({
          sql: `INSERT INTO audit_log (actor, action, target, before_json, after_json, at) VALUES (?, 'setting.store', ?, NULL, NULL, ?)`,
          params: [viewer.email, name, now],
        })),
      ])
    }
    try {
      await saveAdminConfig(deps.db, { ...next, admin: true }, viewer.email, now, deps.getEnv)
    } catch (error) { return (error as Error).message }
    await refreshAdminConfig(deps, now)
    return null
  }

  const html = (c: Context, body: string, status: 200 | 400 = 200) => c.html(body, status, noStore)
  const formValues = (form: Form): Record<string, string> =>
    Object.fromEntries(Object.entries(form).filter(([key, value]) => key !== 'csrf' && typeof value === 'string').map(([key, value]) => [key, value as string]))

  // ── General ───────────────────────────────────────────────────────────────────────────────

  const general = async (c: Context, v: { viewer: Viewer; csrf: string; config: AdminConfig; notice?: string }, error?: string, status: 200 | 400 = 200, resetError?: string) => {
    const update = await checkForUpdate({ db: deps.db, config: deps.config, fetch: deps.fetch, now: nowSeconds() })
    return html(c, generalPage({ viewer: v.viewer, csrf: v.csrf, title: v.config.title, baseUrl: v.config.baseUrl, timezone: v.config.timezone ?? 'UTC', updatesEnabled: v.config.updates?.enabled === true, installedVersion: APP_VERSION, update, notice: v.notice, error, resetError }), status)
  }

  app.get('/admin', async (c) => {
    const v = await view(c)
    return v instanceof Response ? v : general(c, v)
  })

  app.post('/admin/general', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    const title = text(p.form, 'title').slice(0, 80)
    const baseUrl = text(p.form, 'baseUrl').replace(/\/+$/, '')
    const timezone = text(p.form, 'timezone')
    let error: string | undefined
    try { const url = new URL(baseUrl); if (!['https:', 'http:'].includes(url.protocol)) error = 'The address must start with https://.' } catch { error = 'Enter the site address, such as https://status.example.com.' }
    if (!title) error = 'Enter a site title.'
    else if (!isValidTimeZone(timezone)) error = `"${timezone}" is not a recognised timezone.`
    const next: AdminConfig = { ...p.config, title, baseUrl, timezone }
    error ??= (await save(p.viewer, next)) ?? undefined
    if (error) return general(c, { ...p, config: next }, error, 400)
    return done(c, '/admin', 'general-saved')
  })

  app.post('/admin/updates', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    const next: AdminConfig = { ...p.config }
    if (text(p.form, 'updates') === '1') next.updates = { ...(p.config.updates ?? {}), enabled: true }
    else delete next.updates
    const error = await save(p.viewer, next)
    if (error) return general(c, p, error, 400)
    return done(c, '/admin', 'updates-saved')
  })

  app.post('/admin/updates/check', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    const result = await checkForUpdate({ db: deps.db, config: deps.config, fetch: deps.fetch, now: nowSeconds(), force: true })
    await appendAudit(deps.db, { actor: p.viewer.email, action: 'update.check', target: result.targetVersion ? `release:${result.targetVersion}` : 'release:none', before: null, after: null, at: nowSeconds() })
    return done(c, '/admin', `update-${result.result}`)
  })

  // ── Monitors ──────────────────────────────────────────────────────────────────────────────

  const kindParam = (value: string | undefined): MonitorInput['kind'] => (value === 'push' || value === 'tcp' ? value : 'http')
  const groupNames = (config: AdminConfig) => (config.groups ?? []).map((g) => g.name)
  const sinkNames = (config: AdminConfig) => Object.keys(config.sinks ?? {})

  app.get('/admin/monitors', async (c) => {
    const v = await view(c)
    if (v instanceof Response) return v
    return html(c, monitorsPage({ viewer: v.viewer, rows: monitorRows(v.config), notice: v.notice }))
  })

  app.get('/admin/monitors/new', async (c) => {
    const v = await view(c)
    if (v instanceof Response) return v
    return html(c, monitorForm({ viewer: v.viewer, csrf: v.csrf, kind: kindParam(c.req.query('kind')), group: groupNames(v.config)[0] ?? 'Services', groups: groupNames(v.config), sinks: sinkNames(v.config), timezone: v.config.timezone ?? 'UTC' }))
  })

  app.post('/admin/monitors/new', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    const kind = kindParam(text(p.form, 'kind'))
    let error: string
    try {
      const monitor = monitorFromForm(p.form, undefined, new Set(monitorRows(p.config).map((r) => r.monitor.id)))
      const result = await save(p.viewer, putMonitor(p.config, monitor, text(p.form, 'group')))
      if (!result) return done(c, '/admin/monitors', 'monitor-added')
      error = result
    } catch (e) { if (!(e instanceof FormError)) throw e; error = e.message }
    return html(c, monitorForm({ viewer: p.viewer, csrf: p.csrf, kind, values: formValues(p.form), group: text(p.form, 'group'), groups: groupNames(p.config), sinks: sinkNames(p.config), timezone: p.config.timezone ?? 'UTC', error }), 400)
  })

  app.get('/admin/monitors/:id', async (c) => {
    const v = await view(c)
    if (v instanceof Response) return v
    const row = findMonitor(v.config, c.req.param('id'))
    if (!row) return notFound(c)
    return html(c, monitorForm({ viewer: v.viewer, csrf: v.csrf, kind: row.monitor.kind, monitor: row.monitor, group: row.group, groups: groupNames(v.config), sinks: sinkNames(v.config), timezone: v.config.timezone ?? 'UTC' }))
  })

  app.post('/admin/monitors/:id', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    const row = findMonitor(p.config, c.req.param('id'))
    if (!row) return notFound(c)
    let error: string
    try {
      const monitor = monitorFromForm(p.form, row.monitor, new Set())
      const result = await save(p.viewer, putMonitor(p.config, monitor, text(p.form, 'group')))
      if (!result) return done(c, '/admin/monitors', 'monitor-saved')
      error = result
    } catch (e) { if (!(e instanceof FormError)) throw e; error = e.message }
    return html(c, monitorForm({ viewer: p.viewer, csrf: p.csrf, kind: row.monitor.kind, monitor: row.monitor, values: formValues(p.form), group: text(p.form, 'group'), groups: groupNames(p.config), sinks: sinkNames(p.config), timezone: p.config.timezone ?? 'UTC', error }), 400)
  })

  app.post('/admin/monitors/:id/delete', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    const id = c.req.param('id')
    if (!findMonitor(p.config, id)) return notFound(c)
    const error = await save(p.viewer, removeMonitor(p.config, id))
    if (error) return html(c, monitorsPage({ viewer: p.viewer, rows: monitorRows(p.config), error }), 400)
    return done(c, '/admin/monitors', 'monitor-deleted')
  })

  app.post('/admin/ping-tokens/:id/rotate', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    const id = c.req.param('id')
    const token = await rotatePingToken(deps.db, id, p.viewer.email, nowSeconds())
    if (!token) return notFound(c)
    const name = findMonitor(p.config, id)?.monitor.name ?? id
    return html(c, pingUrlPage({ viewer: p.viewer, monitorName: name, monitorId: id, pingUrl: `${deps.config.baseUrl.replace(/\/+$/, '')}/ping/${token}` }))
  })

  // ── Status pages ──────────────────────────────────────────────────────────────────────────

  const monitorChoices = (config: AdminConfig) => monitorRows(config).map((r) => ({ id: r.monitor.id, name: r.monitor.name }))

  app.get('/admin/pages', async (c) => {
    const v = await view(c)
    if (v instanceof Response) return v
    return html(c, pagesPage({ viewer: v.viewer, csrf: v.csrf, pages: pageList(v.config), home: v.config.home ?? pageList(v.config)[0]?.slug, notice: v.notice }))
  })

  app.get('/admin/pages/new', async (c) => {
    const v = await view(c)
    if (v instanceof Response) return v
    return html(c, pageForm({ viewer: v.viewer, csrf: v.csrf, monitors: monitorChoices(v.config) }))
  })

  const savePage = async (c: Context, existing: PageInput | undefined) => {
    const p = await post(c)
    if (p instanceof Response) return p
    let error: string
    try {
      const page = pageFromForm(p.form, existing, new Set(pageList(p.config).map((x) => x.slug)))
      const next = putPage(p.config, page)
      const result = await save(p.viewer, next)
      if (!result) return done(c, '/admin/pages', existing ? 'page-saved' : 'page-added')
      error = result
    } catch (e) { if (!(e instanceof FormError)) throw e; error = e.message }
    return html(c, pageForm({ viewer: p.viewer, csrf: p.csrf, page: existing, monitors: monitorChoices(p.config), values: formValues(p.form), error }), 400)
  }

  app.post('/admin/pages/new', (c) => savePage(c, undefined))

  app.get('/admin/pages/:slug', async (c) => {
    const v = await view(c)
    if (v instanceof Response) return v
    const page = pageList(v.config).find((x) => x.slug === c.req.param('slug'))
    if (!page) return notFound(c)
    return html(c, pageForm({ viewer: v.viewer, csrf: v.csrf, page, monitors: monitorChoices(v.config) }))
  })

  app.post('/admin/pages/:slug', async (c) => {
    const page = pageList(await storedConfig()).find((x) => x.slug === c.req.param('slug'))
    return page ? savePage(c, page) : notFound(c)
  })

  app.post('/admin/pages/:slug/home', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    const slug = c.req.param('slug')
    if (!pageList(p.config).some((x) => x.slug === slug)) return notFound(c)
    const error = await save(p.viewer, { ...p.config, home: slug })
    if (error) return html(c, pagesPage({ viewer: p.viewer, csrf: p.csrf, pages: pageList(p.config), home: p.config.home, error }), 400)
    return done(c, '/admin/pages', 'home-saved')
  })

  app.post('/admin/pages/:slug/delete', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    let error: string | null
    try { error = await save(p.viewer, removePage(p.config, c.req.param('slug'))) } catch (e) { if (!(e instanceof FormError)) throw e; error = e.message }
    if (error) return html(c, pagesPage({ viewer: p.viewer, csrf: p.csrf, pages: pageList(p.config), home: p.config.home, error }), 400)
    return done(c, '/admin/pages', 'page-deleted')
  })

  // ── Alert channels ────────────────────────────────────────────────────────────────────────

  const channelRows = (config: AdminConfig) => Object.entries(config.sinks ?? {}).map(([name, sink]) => ({ name, type: sink.type }))
  const typeParam = (value: string | undefined): SinkType => (value && value in SINK_FIELDS ? value as SinkType : 'slack')

  /** Where each credential of a channel comes from. Values are never read for display. */
  const sources = (sink: SinkInput | undefined): Record<string, { source: SecretSource; envName?: string }> => {
    const out: Record<string, { source: SecretSource; envName?: string }> = {}
    if (!sink) return out
    const s = sink as unknown as Record<string, unknown>
    const refs: Record<string, unknown> = { ...s, ...(s.via && typeof s.via === 'object' ? s.via as Record<string, unknown> : {}) }
    for (const [key, value] of Object.entries(refs)) {
      const name = value && typeof value === 'object' && typeof (value as { $env?: unknown }).$env === 'string' ? (value as { $env: string }).$env : undefined
      if (!name) continue
      out[key] = { envName: name, source: deps.hasRealEnv(name) ? 'env' : isStorableEnv(name) && deps.storedEnv[name] ? 'db' : false }
    }
    return out
  }

  app.get('/admin/channels', async (c) => {
    const v = await view(c)
    if (v instanceof Response) return v
    return html(c, channelsPage({ viewer: v.viewer, csrf: v.csrf, sinks: channelRows(v.config), notice: v.notice }))
  })

  app.get('/admin/channels/new', async (c) => {
    const v = await view(c)
    if (v instanceof Response) return v
    return html(c, channelForm({ viewer: v.viewer, csrf: v.csrf, type: typeParam(c.req.query('type')), sources: {} }))
  })

  const saveChannel = async (c: Context, name: string | undefined) => {
    const p = await post(c)
    if (p instanceof Response) return p
    const existing = name ? p.config.sinks?.[name] : undefined
    if (name && !existing) return notFound(c)
    const type = existing?.type ?? typeParam(text(p.form, 'type'))
    let error: string
    try {
      const channel = name ?? text(p.form, 'name')
      if (!name) {
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(channel)) throw new FormError('Use letters, numbers, - and _ for the channel name.')
        if (p.config.sinks?.[channel]) throw new FormError(`A channel named "${channel}" already exists.`)
      }
      const { sink, secrets } = sinkFromForm(p.form, channel, existing)
      // Validate with the new values visible, so a just-entered credential counts as set.
      const pending = Object.fromEntries(secrets.map((s) => [s.name, s.value]))
      const getEnv = (env: string) => pending[env] ?? deps.getEnv(env)
      try { validateAdminConfig({ ...putSink(p.config, channel, sink), admin: true }, getEnv) } catch (e) { throw new FormError((e as Error).message) }
      const result = await save(p.viewer, putSink(p.config, channel, sink), secrets)
      if (!result) return done(c, '/admin/channels', name ? 'channel-saved' : 'channel-added')
      error = result
    } catch (e) { if (!(e instanceof FormError)) throw e; error = e.message }
    return html(c, channelForm({ viewer: p.viewer, csrf: p.csrf, type, name, sink: existing, sources: sources(existing), values: formValues(p.form), error }), 400)
  }

  app.post('/admin/channels/new', (c) => saveChannel(c, undefined))

  app.get('/admin/channels/:name', async (c) => {
    const v = await view(c)
    if (v instanceof Response) return v
    const name = c.req.param('name')
    const sink = v.config.sinks?.[name]
    if (!sink) return notFound(c)
    return html(c, channelForm({ viewer: v.viewer, csrf: v.csrf, type: sink.type, name, sink, sources: sources(sink) }))
  })

  app.post('/admin/channels/:name', (c) => saveChannel(c, c.req.param('name')))

  app.post('/admin/channels/:name/delete', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    const name = c.req.param('name')
    if (!p.config.sinks?.[name]) return notFound(c)
    const error = await save(p.viewer, removeSink(p.config, name))
    if (error) return html(c, channelsPage({ viewer: p.viewer, csrf: p.csrf, sinks: channelRows(p.config), error }), 400)
    // Erase the credentials this channel stored (exact prefix match; LIKE would treat _ as a wildcard).
    const prefix = storedEnvKey(sinkEnvName(name, ''))
    await deps.db.run(`DELETE FROM instance_secrets WHERE substr(name, 1, ?) = ?`, [prefix.length, prefix])
    await refreshAdminConfig(deps, nowSeconds())
    return done(c, '/admin/channels', 'channel-deleted')
  })

  app.post('/admin/sinks/:name/test', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    const name = c.req.param('name')
    try {
      await sendSinkTest(name, p.config, deps.getEnv, deps.fetch, deps)
      await appendAudit(deps.db, { actor: p.viewer.email, action: 'sink.test', target: `sink:${name}`, before: null, after: null, at: nowSeconds() })
      return done(c, '/admin/channels', 'test-sent')
    } catch (error) {
      return html(c, channelsPage({ viewer: p.viewer, csrf: p.csrf, sinks: channelRows(p.config), error: `The test alert to "${name}" failed: ${(error as Error).message}` }), 400)
    }
  })

  // ── Access ────────────────────────────────────────────────────────────────────────────────

  app.get('/admin/access', async (c) => {
    const v = await view(c)
    if (v instanceof Response) return v
    return html(c, accessPage({ viewer: v.viewer, csrf: v.csrf, providerSummary: providerSummary(v.config), admins: v.config.access?.admins?.emails ?? [], notice: v.notice }))
  })

  app.post('/admin/access', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    const emails = text(p.form, 'admins').split(/[\n,]/).map((line) => line.trim().toLowerCase()).filter(Boolean)
    const admins = { ...(p.config.access?.admins ?? {}), emails }
    const error = !emails.length && !p.config.access?.admins?.teams?.length ? 'Keep at least one administrator.'
      : p.config.access ? await save(p.viewer, { ...p.config, access: { ...p.config.access, admins } }) : 'No sign-in method is configured.'
    if (error) return html(c, accessPage({ viewer: p.viewer, csrf: p.csrf, providerSummary: providerSummary(p.config), admins: p.config.access?.admins?.emails ?? [], values: formValues(p.form), error }), 400)
    return done(c, '/admin/access', 'admins-saved')
  })

  mountAccessSwitch(app, deps, { view, post, html, done })

  // ── Import / export / activity ────────────────────────────────────────────────────────────

  /** Parses an import. The sign-in method always stays as it is: changing it could lock everyone out. */
  const parseImport = (yaml: string, current: AdminConfig): AdminConfig => {
    const parsed = parseAdminYaml(yaml)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new FormError('The file must contain a StatusPing configuration.')
    const next = { ...(parsed as AdminConfig), admin: true }
    if (current.access) next.access = { ...(next.access ?? {}), provider: current.access.provider } as AdminConfig['access']
    return next
  }

  const configuration = (c: Context, v: { viewer: Viewer; csrf: string; config: AdminConfig; notice?: string }, importYaml?: string, error?: string) =>
    html(c, configurationPage({ viewer: v.viewer, csrf: v.csrf, yaml: stringifyAdminYaml(v.config), importYaml, error, notice: v.notice }), error ? 400 : 200)

  app.get('/admin/configuration', async (c) => {
    const v = await view(c)
    return v instanceof Response ? v : configuration(c, v)
  })
  // Import and Export were separate pages before v0.2.15.
  app.get('/admin/import', (c) => c.redirect('/admin/configuration#import', 302))
  app.get('/admin/export', (c) => c.redirect('/admin/configuration', 302))

  app.post('/admin/import', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    const yaml = text(p.form, 'config')
    try {
      const next = parseImport(yaml, p.config)
      const normalized = validateAdminConfig(next, deps.getEnv).normalized
      if (!canAdmin(p.viewer, normalized)) throw new FormError('This configuration would remove your own access to Settings.')
      const changes = describeChanges(p.config, next)
      if (JSON.stringify((parseAdminYaml(yaml) as AdminConfig).access?.provider ?? null) !== JSON.stringify(p.config.access?.provider ?? null)) {
        changes.push('Keeps the current sign-in method (the file’s sign-in method is ignored)')
      }
      return html(c, importPreview({ viewer: p.viewer, csrf: p.csrf, yaml, changes }))
    } catch (error) {
      return configuration(c, p, yaml, (error as Error).message)
    }
  })

  app.post('/admin/import/apply', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    const yaml = text(p.form, 'config')
    let error: string | null
    try { error = await save(p.viewer, parseImport(yaml, p.config)) } catch (e) { error = (e as Error).message }
    if (error) return configuration(c, p, yaml, error)
    return done(c, '/admin/configuration', 'imported')
  })

  app.get('/admin/export/statusping.yaml', async (c) => {
    const v = await view(c)
    if (v instanceof Response) return v
    return c.body(stringifyAdminYaml(v.config), 200, { ...noStore, 'content-type': 'application/yaml; charset=utf-8', 'content-disposition': 'attachment; filename="statusping.yaml"' })
  })

  // ── MCP ───────────────────────────────────────────────────────────────────────────────────

  app.get('/admin/mcp', async (c) => {
    const v = await view(c)
    if (v instanceof Response) return v
    return html(c, mcpPage({ viewer: v.viewer, csrf: v.csrf, baseUrl: deps.config.baseUrl, tokens: await listApiTokens(deps.db), notice: v.notice }))
  })

  app.post('/admin/mcp', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    const name = text(p.form, 'name').slice(0, 60)
    const raw = p.form.scopes
    const scopes = [...new Set((Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter(isMcpScope))]
    const error = !name ? 'Give the token a name.' : !scopes.length ? 'Choose at least one thing the token can do.' : null
    if (error) {
      return html(c, mcpPage({ viewer: p.viewer, csrf: p.csrf, baseUrl: deps.config.baseUrl, tokens: await listApiTokens(deps.db), values: { name, scopes: scopes.length ? scopes : [] }, error }), 400)
    }
    const token = await createApiToken(deps.db, name, scopes, p.viewer.email, nowSeconds())
    return html(c, mcpTokenCreated({ viewer: p.viewer, baseUrl: deps.config.baseUrl, name, token, scopes }))
  })

  app.post('/admin/mcp/:id/revoke', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    if (!(await revokeApiToken(deps.db, Number(c.req.param('id')), p.viewer.email, nowSeconds()))) return notFound(c)
    return done(c, '/admin/mcp', 'mcp-token-revoked')
  })

  app.get('/admin/activity', async (c) => {
    const v = await view(c)
    if (v instanceof Response) return v
    return html(c, activityPage({ viewer: v.viewer, audit: await listAudit(deps.db, 100) }))
  })

  // ── Reset to the setup wizard (the danger-zone card on General) ───────────────────────────

  app.post('/admin/reset', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    if (text(p.form, 'confirm').toLowerCase() !== 'reset') return general(c, p, undefined, 400, 'Type reset to confirm.')
    await beginSetup(deps.db, p.viewer.email, nowSeconds())
    await refreshAdminConfig(deps, nowSeconds())
    deleteCookie(c, 'sp_session', { path: '/' })
    deps.log('info', `Instance reset to setup mode by ${p.viewer.email}. Open ${new URL(c.req.url).origin}/setup to finish setup.`)
    const res = c.redirect('/setup', 303)
    res.headers.set('cache-control', 'no-store')
    return res
  })

  // ── JSON API (bearer ADMIN_TOKEN) ─────────────────────────────────────────────────────────

  app.get('/api/admin/config', async (c) => {
    const ok = apiAdmin(c)
    if (ok === null) return notFound(c)
    if (!ok) return c.text('Unauthorized', 401, noStore)
    return c.json({ config: await storedConfig() }, 200, noStore)
  })
  app.put('/api/admin/config', async (c) => {
    const ok = apiAdmin(c)
    if (ok === null) return notFound(c)
    if (!ok) return c.text('Unauthorized', 401, noStore)
    const raw = await bodyJson(c)
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) && 'config' in raw ? (raw as { config: unknown }).config : raw
    try {
      const saved = await saveAdminConfig(deps.db, value, 'api-token', nowSeconds(), deps.getEnv)
      await refreshAdminConfig(deps, nowSeconds())
      return c.json({ config: saved.config, updatedAt: saved.updatedAt }, 200, noStore)
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400, noStore)
    }
  })
  app.get('/api/admin/audit', async (c) => {
    const ok = apiAdmin(c)
    if (ok === null) return notFound(c)
    if (!ok) return c.text('Unauthorized', 401, noStore)
    return c.json({ audit: await listAudit(deps.db, Number(c.req.query('limit') ?? '100')) }, 200, noStore)
  })
  app.post('/api/admin/ping-tokens/:id/rotate', async (c) => {
    const ok = apiAdmin(c)
    if (ok === null) return notFound(c)
    if (!ok) return c.text('Unauthorized', 401, noStore)
    const id = c.req.param('id')
    const token = await rotatePingToken(deps.db, id, 'api-token', nowSeconds())
    return token ? c.json({ monitorId: id, token }, 201, noStore) : notFound(c)
  })
  app.post('/api/admin/sinks/:name/test', async (c) => {
    const ok = apiAdmin(c)
    if (ok === null) return notFound(c)
    if (!ok) return c.text('Unauthorized', 401, noStore)
    const name = c.req.param('name')
    try {
      await sendSinkTest(name, await storedConfig(), deps.getEnv, deps.fetch, deps)
      await appendAudit(deps.db, { actor: 'api-token', action: 'sink.test', target: `sink:${name}`, before: null, after: null, at: nowSeconds() })
      return c.json({ ok: true }, 200, noStore)
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400, noStore)
    }
  })
}
