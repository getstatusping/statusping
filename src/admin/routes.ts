import type { Context, Hono } from 'hono'
import { currentViewer, fromThisSite, signInResponse } from '../auth/providers.ts'
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
  accessPage, activityPage, mcpPage, mcpTokenCreated, channelForm, channelsPage, diffBlock, generalPage, configurationPage, importPreview, monitorForm, monitorsPage,
  pageForm, pagesPage, pingUrlPage, revisionPage, type SecretSource,
} from './ui.ts'
import {
  appendAudit, currentRevision, currentYamlText, listAudit, listRevisions, loadAdminConfig, loadRevision, RevisionConflict, rotatePingToken, saveAdminConfig,
  type SaveOptions, sendSinkTest,
} from './service.ts'
import { type AdminConfig, authorizeAdminToken, canAdmin, envReferences, issueCsrfToken, validateAdminConfig, verifyCsrfToken } from './security.ts'
import { exportAdminYaml, locateProblems, parseAdminYaml, stringifyAdminYaml } from './yaml.ts'
import { configSchema } from './config-schema.ts'
import { lineDiff, withContext } from './diff.ts'
import { syncConfig } from '../sync.ts'
import { readRecoverySession } from '../setup/recovery.ts'
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
  restored: 'Earlier version restored.',
  'setup-ping-urls': 'Setup is complete. Scheduled jobs marked "No ping URL yet" need one: open each and create its ping URL.',
  recovered: 'Recovery session started. Set up a sign-in method that works; the rest of Settings opens once you switch.',
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

const CONFLICT = 'Someone else changed the configuration after you opened this page, so nothing was saved. The page now shows the latest settings with your changes; save again to apply them, or see Configuration → History for what changed.'

/** The revision a page was rendered from, per request; written into every form beside the CSRF value. */
const formRevision = new WeakMap<Request, number>()

/** Adds the browser Settings pages and the bearer-token JSON API. */
export function mountAdminRoutes(app: Hono, deps: Deps): void {
  const enabled = () => deps.adminEnabled
  const browserAdmin = async (c: Context) => {
    if (!enabled()) return null
    const viewer = await currentViewer(c, deps)
    if (!viewer) {
      // Break-glass recovery (/setup/recover) may only change the sign-in method.
      const recovery = await readRecoverySession(c, deps)
      if (recovery && c.req.path.startsWith('/admin/access/method')) return recovery
      if (recovery) return c.redirect('/admin/access/method', 303)
      return signInResponse(c, deps)
    }
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

  /**
   * A same-origin form post with a valid CSRF value, plus a fresh value to re-render with. `base`
   * is the revision the form was rendered from; a save refuses to overwrite a newer one.
   */
  const post = async (c: Context): Promise<Response | Post> => {
    const viewer = await browserAdmin(c)
    if (viewer === null) return notFound(c)
    if (viewer instanceof Response) return viewer
    if (!fromThisSite(c, deps)) return c.text('Forbidden', 403, noStore)
    const form = await c.req.parseBody({ all: true }).catch(() => ({})) as Form
    if (!(await verifyCsrfToken(deps.db, c, form.csrf, nowSeconds()))) return c.text('Forbidden', 403, noStore)
    const base = /^\d+$/.test(text(form, 'revision')) ? Number(text(form, 'revision')) : undefined
    if (base !== undefined) formRevision.set(c.req.raw, base)
    return { viewer, form, csrf: (await issueCsrfToken(deps.db, c, nowSeconds())) ?? '', config: await storedConfig(), base, c }
  }
  type Post = { viewer: Viewer; form: Form; csrf: string; config: AdminConfig; base?: number; c: Context }

  const done = (c: Context, path: string, notice: string) => {
    const res = c.redirect(`${path}?notice=${notice}`, 303)
    res.headers.set('cache-control', 'no-store')
    return res
  }

  /**
   * Validates and saves a whole new config. Refuses changes that would lock the saving
   * administrator out. Returns an error message for the form, or null when saved.
   */
  const save = async (p: Post, next: AdminConfig, secrets: Array<{ name: string; value: string }> = [], opts: SaveOptions = {}): Promise<string | null> => {
    const viewer = p.viewer
    let normalized
    try { normalized = validateAdminConfig({ ...next, admin: true }, deps.getEnv).normalized } catch (error) { return opts.yaml ? locateProblems(opts.yaml, (error as Error).message) : (error as Error).message }
    if (!canAdmin(viewer, normalized)) return 'This change would remove your own access to Settings. Ask another administrator to make it.'
    const now = nowSeconds()
    // Checked before secrets are stored, so a refused save leaves nothing behind.
    if (p.base !== undefined) {
      const current = await currentRevision(deps.db)
      if (current !== p.base) { formRevision.set(p.c.req.raw, current); return CONFLICT }
    }
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
      await saveAdminConfig(deps.db, { ...next, admin: true }, viewer.email, now, deps.getEnv, { ...opts, base: p.base })
    } catch (error) {
      if (error instanceof RevisionConflict) { formRevision.set(p.c.req.raw, error.current); return CONFLICT }
      return (error as Error).message
    }
    await refreshAdminConfig(deps, now)
    formRevision.set(p.c.req.raw, deps.configRevision)
    return null
  }

  /** Warns when Settings is open at a different address than the configured site address. */
  const addressBanner = (c: Context): string => {
    let configured: string
    try { configured = new URL(deps.config.baseUrl).origin } catch { return '' }
    const here = new URL(c.req.url).origin
    if (configured === here) return ''
    const oidc = deps.config.access?.provider.type === 'oidc'
    const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    return `<div class="alert warning banner" role="status"><strong>This site is open at ${esc(here)}, but its address is set to ${esc(configured)}.</strong>
Alert links, ping URLs and sign-in callbacks use ${esc(configured)}. If the site has moved, <a href="/admin">change the address</a>.${oidc ? ` Single sign-on also needs the new callback URL, <code>${esc(here)}/auth/callback</code>, registered with your identity provider.` : ''}</div>`
  }

  /** Every form carries the revision it was rendered from, next to its CSRF value. */
  const html = (c: Context, body: string, status: 200 | 400 = 200) => {
    const revision = formRevision.get(c.req.raw) ?? deps.configRevision
    const page = body.replace(/(<input type="hidden" name="csrf" value="[^"]*">)/g, `$1<input type="hidden" name="revision" value="${revision}">`).replace('<!--banner-->', addressBanner(c))
    return c.html(page, status, noStore)
  }
  const formValues = (form: Form): Record<string, string> =>
    Object.fromEntries(Object.entries(form).filter(([key, value]) => key !== 'csrf' && typeof value === 'string').map(([key, value]) => [key, value as string]))

  // ── General ───────────────────────────────────────────────────────────────────────────────

  const general = async (c: Context, v: { viewer: Viewer; csrf: string; config: AdminConfig; notice?: string }, error?: string, status: 200 | 400 = 200, resetError?: string) => {
    const update = await checkForUpdate({ db: deps.db, config: deps.config, fetch: deps.fetch, targetGuard: deps.targetGuard, now: nowSeconds() })
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
    error ??= (await save(p, next)) ?? undefined
    if (error) return general(c, { ...p, config: next }, error, 400)
    return done(c, '/admin', 'general-saved')
  })

  app.post('/admin/updates', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    const next: AdminConfig = { ...p.config }
    if (text(p.form, 'updates') === '1') next.updates = { ...(p.config.updates ?? {}), enabled: true }
    else delete next.updates
    const error = await save(p, next)
    if (error) return general(c, p, error, 400)
    return done(c, '/admin', 'updates-saved')
  })

  app.post('/admin/updates/check', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    const result = await checkForUpdate({ db: deps.db, config: deps.config, fetch: deps.fetch, targetGuard: deps.targetGuard, now: nowSeconds(), force: true })
    await appendAudit(deps.db, { actor: p.viewer.email, action: 'update.check', target: result.targetVersion ? `release:${result.targetVersion}` : 'release:none', before: null, after: null, at: nowSeconds() })
    return done(c, '/admin', `update-${result.result}`)
  })

  // ── Monitors ──────────────────────────────────────────────────────────────────────────────

  const kindParam = (value: string | undefined): MonitorInput['kind'] => (value === 'push' || value === 'tcp' ? value : 'http')
  const groupNames = (config: AdminConfig) => (config.groups ?? []).map((g) => g.name)
  const sinkNames = (config: AdminConfig) => Object.keys(config.sinks ?? {})

  /** Push monitors that cannot be pinged yet: no token from PING_TOKENS and none created here. */
  const withoutPingUrl = async () => new Set((await deps.db.all<{ id: string }>(`SELECT id FROM monitors WHERE kind = 'push' AND paused = 0 AND ping_token_hash IS NULL`)).map((r) => r.id))

  app.get('/admin/monitors', async (c) => {
    const v = await view(c)
    if (v instanceof Response) return v
    return html(c, monitorsPage({ viewer: v.viewer, rows: monitorRows(v.config), withoutPingUrl: await withoutPingUrl(), notice: v.notice }))
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
      const result = await save(p, putMonitor(p.config, monitor, text(p.form, 'group')))
      if (!result && monitor.kind === 'push' && !deps.pingTokens[monitor.id]) {
        // A new scheduled job gets its ping URL right away; it is shown only this once.
        await syncConfig(deps, nowSeconds())
        const token = await rotatePingToken(deps.db, monitor.id, p.viewer.email, nowSeconds())
        if (token) return html(c, pingUrlPage({ viewer: p.viewer, monitorName: monitor.name, monitorId: monitor.id, pingUrl: `${deps.config.baseUrl.replace(/\/+$/, '')}/ping/${token}`, created: true }))
      }
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
      const result = await save(p, putMonitor(p.config, monitor, text(p.form, 'group')))
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
    const error = await save(p, removeMonitor(p.config, id))
    if (error) return html(c, monitorsPage({ viewer: p.viewer, rows: monitorRows(p.config), withoutPingUrl: await withoutPingUrl(), error }), 400)
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
      const result = await save(p, next)
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
    const error = await save(p, { ...p.config, home: slug })
    if (error) return html(c, pagesPage({ viewer: p.viewer, csrf: p.csrf, pages: pageList(p.config), home: p.config.home, error }), 400)
    return done(c, '/admin/pages', 'home-saved')
  })

  app.post('/admin/pages/:slug/delete', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    let error: string | null
    try { error = await save(p, removePage(p.config, c.req.param('slug'))) } catch (e) { if (!(e instanceof FormError)) throw e; error = e.message }
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
      const result = await save(p, putSink(p.config, channel, sink), secrets)
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
    const error = await save(p, removeSink(p.config, name))
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
      : p.config.access ? await save(p, { ...p.config, access: { ...p.config.access, admins } }) : 'No sign-in method is configured.'
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

  /** Where each $env name the configuration uses is set. Names only, never values. */
  const envStatus = (config: AdminConfig) => envReferences(config).map(({ name, paths }) => ({
    name, paths, source: (deps.hasRealEnv(name) ? 'env' : isStorableEnv(name) && deps.storedEnv[name] ? 'db' : false) as SecretSource,
  }))
  const schemaUrl = () => `${deps.config.baseUrl.replace(/\/+$/, '')}/admin/schema.json`
  const currentYaml = async (config: AdminConfig) => exportAdminYaml(config, await currentYamlText(deps.db), schemaUrl())

  const configuration = async (c: Context, v: { viewer: Viewer; csrf: string; config: AdminConfig; notice?: string }, importYaml?: string, error?: string) =>
    html(c, configurationPage({
      viewer: v.viewer, csrf: v.csrf, yaml: await currentYaml(v.config), revision: deps.configRevision, history: await listRevisions(deps.db),
      env: envStatus(v.config), importYaml, error, notice: v.notice,
    }), error ? 400 : 200)

  app.get('/admin/configuration', async (c) => {
    const v = await view(c)
    return v instanceof Response ? v : configuration(c, v)
  })
  // Import and Export were separate pages before v0.2.15.
  app.get('/admin/import', (c) => c.redirect('/admin/configuration#import', 302))
  app.get('/admin/export', (c) => c.redirect('/admin/configuration', 302))

  /** The pasted YAML, or the uploaded file when one was chosen (the no-JavaScript path). */
  const importText = async (form: Form): Promise<string> => {
    const file = form.file
    if (file instanceof File && file.size > 0) {
      if (file.size > 262_144) throw new FormError('Configuration files must be 256 KB or smaller.')
      return file.text()
    }
    return typeof form.config === 'string' ? form.config : ''
  }

  app.post('/admin/import', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    let yaml = ''
    try {
      yaml = await importText(p.form)
      if (!yaml.trim()) throw new FormError('Paste a configuration or choose a YAML file.')
      const next = parseImport(yaml, p.config)
      let normalized
      try { normalized = validateAdminConfig(next, deps.getEnv).normalized } catch (e) { throw new FormError(locateProblems(yaml, (e as Error).message)) }
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
    try { error = await save(p, parseImport(yaml, p.config), [], { yaml, action: 'config.import' }) } catch (e) { error = (e as Error).message }
    if (error) return configuration(c, p, yaml, error)
    return done(c, '/admin/configuration', 'imported')
  })

  app.get('/admin/export/statusping.yaml', async (c) => {
    const v = await view(c)
    if (v instanceof Response) return v
    return c.body(await currentYaml(v.config), 200, { ...noStore, 'content-type': 'application/yaml; charset=utf-8', 'content-disposition': 'attachment; filename="statusping.yaml"' })
  })

  // Not secret: the same schema is published with every release. Editors fetch it without signing in.
  app.get('/admin/schema.json', (c) => (enabled() ? c.json(configSchema(), 200, { 'cache-control': 'public, max-age=3600' }) : notFound(c)))

  // ── Configuration history ────────────────────────────────────────────────────────────────

  const revisionYaml = (r: { config: AdminConfig; yaml: string | null }) => r.yaml ?? stringifyAdminYaml(r.config)
  const revisionParam = (c: Context) => (/^\d{1,9}$/.test(c.req.param('id') ?? '') ? Number(c.req.param('id')) : -1)

  app.get('/admin/configuration/revisions/:id', async (c) => {
    const v = await view(c)
    if (v instanceof Response) return v
    const revision = await loadRevision(deps.db, revisionParam(c))
    if (!revision) return notFound(c)
    const current = await currentYamlText(deps.db) ?? stringifyAdminYaml(v.config)
    return html(c, revisionPage({ viewer: v.viewer, csrf: v.csrf, revision, current: deps.configRevision, diff: diffBlock(withContext(lineDiff(revisionYaml(revision), current))), notice: v.notice }))
  })

  app.post('/admin/configuration/revisions/:id/restore', async (c) => {
    const p = await post(c)
    if (p instanceof Response) return p
    const revision = await loadRevision(deps.db, revisionParam(c))
    if (!revision) return notFound(c)
    // Like an import, a restore keeps today's sign-in method: an old one may no longer work.
    const next: AdminConfig = { ...revision.config, admin: true }
    if (p.config.access) next.access = { ...(next.access ?? {}), provider: p.config.access.provider } as AdminConfig['access']
    const error = await save(p, next, [], { yaml: revision.yaml, action: 'config.restore' })
    if (error) {
      const current = await currentYamlText(deps.db) ?? stringifyAdminYaml(p.config)
      return html(c, revisionPage({ viewer: p.viewer, csrf: p.csrf, revision, current: await currentRevision(deps.db), diff: diffBlock(withContext(lineDiff(revisionYaml(revision), current))), error }), 400)
    }
    return done(c, '/admin/configuration', 'restored')
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

  /** YAML when the client asks for it (Accept or ?format=yaml); JSON otherwise. */
  const wantsYaml = (c: Context) => c.req.query('format') === 'yaml' || /\b(application|text)\/(x-)?yaml\b/.test(c.req.header('accept') ?? '')
  const etag = (revision: number) => `"${revision}"`

  app.get('/api/admin/config', async (c) => {
    const ok = apiAdmin(c)
    if (ok === null) return notFound(c)
    if (!ok) return c.text('Unauthorized', 401, noStore)
    const config = await storedConfig()
    const headers = { ...noStore, etag: etag(deps.configRevision) }
    if (wantsYaml(c)) return c.body(await currentYaml(config), 200, { ...headers, 'content-type': 'application/yaml; charset=utf-8' })
    return c.json({ config, revision: deps.configRevision }, 200, headers)
  })
  app.put('/api/admin/config', async (c) => {
    const ok = apiAdmin(c)
    if (ok === null) return notFound(c)
    if (!ok) return c.text('Unauthorized', 401, noStore)
    const ifMatch = c.req.header('if-match')?.trim()
    let base: number | undefined
    if (ifMatch && ifMatch !== '*') {
      const match = /^(?:W\/)?"?(\d+)"?$/.exec(ifMatch)
      if (!match) return c.json({ error: 'If-Match must be a revision number from ETag, such as "12".' }, 400, noStore)
      base = Number(match[1])
    }
    const yamlBody = /\b(application|text)\/(x-)?yaml\b/.test(c.req.header('content-type') ?? '')
    let value: unknown
    let yaml: string | undefined
    try {
      if (yamlBody) {
        yaml = await c.req.text()
        value = parseAdminYaml(yaml)
      } else {
        const raw = await bodyJson(c)
        value = raw && typeof raw === 'object' && !Array.isArray(raw) && 'config' in raw ? (raw as { config: unknown }).config : raw
      }
      // Admin mode is always on for a stored configuration; a file may leave the flag out.
      if (value && typeof value === 'object' && !Array.isArray(value) && !('admin' in value)) value = { ...value, admin: true }
      const saved = await saveAdminConfig(deps.db, value, 'api-token', nowSeconds(), deps.getEnv, { base, yaml, action: 'config.api' })
      await refreshAdminConfig(deps, nowSeconds())
      return c.json({ config: saved.config, updatedAt: saved.updatedAt, revision: saved.revision }, 200, { ...noStore, etag: etag(saved.revision) })
    } catch (error) {
      if (error instanceof RevisionConflict) return c.json({ error: 'The configuration changed since that revision. Fetch it again and retry.', revision: error.current }, 412, { ...noStore, etag: etag(error.current) })
      const message = (error as Error).message
      return c.json({ error: yaml ? locateProblems(yaml, message) : message }, 400, noStore)
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
