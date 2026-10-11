import type { Context, Hono } from 'hono'
import { currentViewer, sameOrigin, signInResponse } from '../auth/providers.ts'
import type { Deps } from '../deps.ts'
import { refreshAdminConfig } from '../deps.ts'
import { nowSeconds } from '../util/time.ts'
import { adminPage, pingTokenPage } from './ui.ts'
import { appendAudit, listAudit, loadAdminConfig, rotatePingToken, saveAdminConfig, sendSinkTest } from './service.ts'
import { authorizeAdminToken, canAdmin, issueCsrfToken, verifyCsrfToken } from './security.ts'
import { parseAdminYaml } from './yaml.ts'
import { checkForUpdate } from '../updates.ts'
import { APP_VERSION } from '../version.ts'

const noStore = { 'cache-control': 'no-store' }

function notFound(c: Context) { return c.text('Not found', 404) }

/** Adds the disabled-by-default browser admin and its bearer-token JSON API. */
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
  const storedConfig = async () => (await loadAdminConfig(deps.db))?.config ?? deps.configInput
  const ui = async (viewer: NonNullable<Awaited<ReturnType<typeof currentViewer>>>, csrf: string, message?: string, configText?: string) => {
    const config = await storedConfig()
    // Config values are safe here: validation admits only environment *names* for every secret
    // field. Audit records use redaction separately. Presentation-only fields would break an
    // unchanged textarea round-trip, so never add them here.
    const update = await checkForUpdate({ db: deps.db, config: deps.config, fetch: deps.fetch, now: nowSeconds() })
    return adminPage({ viewer, csrf, config, configText, audit: await listAudit(deps.db, 50), message, sinkNames: Object.keys(config.sinks ?? {}), monitorIds: deps.config.monitors.filter((monitor) => monitor.kind === 'push').map((monitor) => monitor.id), installedVersion: APP_VERSION, instanceUrl: deps.config.baseUrl, update })
  }
  const bodyJson = async (c: Context): Promise<unknown | null> => {
    try { return await c.req.json() } catch { return null }
  }

  app.get('/admin', async (c) => {
    const viewer = await browserAdmin(c)
    if (viewer === null) return notFound(c)
    if (viewer instanceof Response) return viewer
    const csrf = await issueCsrfToken(deps.db, c, nowSeconds())
    if (!csrf) return c.text('Your session is invalid. Please sign in again.', 401, noStore)
    return c.html(await ui(viewer, csrf, c.req.query('message')), 200, noStore)
  })

  app.post('/admin/config', async (c) => {
    const viewer = await browserAdmin(c)
    if (viewer === null) return notFound(c)
    if (viewer instanceof Response) return viewer
    if (!sameOrigin(c, deps)) return c.text('Forbidden', 403, noStore)
    const form = await c.req.parseBody().catch(() => ({})) as Record<string, unknown>
    if (!(await verifyCsrfToken(deps.db, c, form.csrf, nowSeconds()))) return c.text('Forbidden', 403, noStore)
    const configText = typeof form.config === 'string' ? form.config : ''
    let parsed: unknown
    try { parsed = parseAdminYaml(configText) } catch (error) {
      const csrf = await issueCsrfToken(deps.db, c, nowSeconds())
      return c.html(await ui(viewer, csrf ?? '', error instanceof Error ? error.message : String(error), configText), 400, noStore)
    }
    try {
      await saveAdminConfig(deps.db, parsed, viewer.email, nowSeconds(), deps.getEnv)
      await refreshAdminConfig(deps, nowSeconds())
    } catch (error) {
      const csrf = await issueCsrfToken(deps.db, c, nowSeconds())
      return c.html(await ui(viewer, csrf ?? '', (error as Error).message, configText), 400, noStore)
    }
    return c.redirect('/admin', 303)
  })

  app.post('/admin/updates/check', async (c) => {
    const viewer = await browserAdmin(c)
    if (viewer === null) return notFound(c)
    if (viewer instanceof Response) return viewer
    if (!sameOrigin(c, deps)) return c.text('Forbidden', 403, noStore)
    const form = await c.req.parseBody().catch(() => ({})) as Record<string, unknown>
    if (!(await verifyCsrfToken(deps.db, c, form.csrf, nowSeconds()))) return c.text('Forbidden', 403, noStore)
    const result = await checkForUpdate({ db: deps.db, config: deps.config, fetch: deps.fetch, now: nowSeconds(), force: true })
    await appendAudit(deps.db, { actor: viewer.email, action: 'update.check', target: result.targetVersion ? `release:${result.targetVersion}` : 'release:none', before: null, after: null, at: nowSeconds() })
    return c.redirect(`/admin?message=${encodeURIComponent(result.result === 'available' ? `Update v${result.targetVersion} is available.` : result.result === 'current' ? 'This installation is up to date.' : result.result === 'incompatible' ? 'A newer release is incompatible with this installation.' : result.result === 'disabled' ? 'Update checks are disabled.' : 'The update manifest could not be verified.')}`, 303)
  })

  app.post('/admin/ping-tokens/:id/rotate', async (c) => {
    const viewer = await browserAdmin(c)
    if (viewer === null) return notFound(c)
    if (viewer instanceof Response) return viewer
    if (!sameOrigin(c, deps)) return c.text('Forbidden', 403, noStore)
    const form = await c.req.parseBody().catch(() => ({})) as Record<string, unknown>
    if (!(await verifyCsrfToken(deps.db, c, form.csrf, nowSeconds()))) return c.text('Forbidden', 403, noStore)
    const id = c.req.param('id')
    const token = await rotatePingToken(deps.db, id, viewer.email, nowSeconds())
    return token ? c.html(pingTokenPage(id, token), 200, noStore) : notFound(c)
  })

  app.post('/admin/sinks/:name/test', async (c) => {
    const viewer = await browserAdmin(c)
    if (viewer === null) return notFound(c)
    if (viewer instanceof Response) return viewer
    if (!sameOrigin(c, deps)) return c.text('Forbidden', 403, noStore)
    const form = await c.req.parseBody().catch(() => ({})) as Record<string, unknown>
    if (!(await verifyCsrfToken(deps.db, c, form.csrf, nowSeconds()))) return c.text('Forbidden', 403, noStore)
    const name = c.req.param('name')
    try {
      await sendSinkTest(name, await storedConfig(), deps.getEnv, deps.fetch, deps.cloudflareEmail)
      await appendAudit(deps.db, { actor: viewer.email, action: 'sink.test', target: `sink:${name}`, before: null, after: null, at: nowSeconds() })
      return c.redirect('/admin?message=Test+alert+sent', 303)
    } catch (error) {
      const csrf = await issueCsrfToken(deps.db, c, nowSeconds())
      return c.html(await ui(viewer, csrf ?? '', (error as Error).message), 400, noStore)
    }
  })

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
      await sendSinkTest(name, await storedConfig(), deps.getEnv, deps.fetch, deps.cloudflareEmail)
      await appendAudit(deps.db, { actor: 'api-token', action: 'sink.test', target: `sink:${name}`, before: null, after: null, at: nowSeconds() })
      return c.json({ ok: true }, 200, noStore)
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400, noStore)
    }
  })
}

