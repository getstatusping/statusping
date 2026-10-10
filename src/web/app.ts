import { Hono } from 'hono'
import type { Context } from 'hono'
import { currentViewer, hasCredentials, mountAuthRoutes, sameOrigin, signInResponse } from '../auth/providers.ts'
import { type Viewer, canAcknowledge, canOpen } from '../auth/viewer.ts'
import { acknowledgeIncident, verifyAcknowledgeToken } from '../acknowledgements.ts'
import type { NormalizedPage } from '../config.ts'
import type { Deps } from '../deps.ts'
import { dispatchNotifications } from '../notify/dispatch.ts'
import { dispatchAnnouncementNotifications, enqueueAnnouncementNotifications } from '../notify/announcements.ts'
import { MAX_PING_BODY, handlePing, parseSignal } from '../ping.ts'
import { ensureSchema } from '../schema.ts'
import { tick } from '../tick.ts'
import { timingSafeEqual } from '../util/crypto.ts'
import { createAnnouncement, listAnnouncements, parseAnnouncementCreate, parseAnnouncementPatch, patchAnnouncement } from '../announcements.ts'
import { nowSeconds } from '../util/time.ts'
import { APP_VERSION, SCHEMA_VERSION } from '../version.ts'
import { type StatusData, lastTickAt, loadMonitorDetail, loadStatusData } from './data.ts'
import { buildChrome } from './chrome.ts'
import { renderBadge } from './badge.ts'
import { acknowledgePage, type PageCtx, messagePage, monitorPage, statusPage } from './pages.ts'
import { confirmSubscription, consumeSubscribeLimit, dispatchSubscriberOutbox, enqueueAnnouncement, startSubscription, unsubscribe } from '../subscribers.ts'
import { refreshAdminConfig } from '../deps.ts'
import { mountAdminRoutes } from '../admin/routes.ts'
import { consumePingRateLimit } from '../rate-limit.ts'

const STALE_TICK_SECONDS = 180
const PUBLIC_MAX_AGE = 30

type Cacheable = { cacheable: boolean }

/**
 * Serves public pages through the edge cache (Cloudflare Cache API) to save CPU and DB
 * reads. Only ever used for responses that are identical for every visitor.
 */
async function withEdgeCache(c: Context, render: () => Promise<Response>, maxAge = PUBLIC_MAX_AGE): Promise<Response> {
  const cacheApi = (globalThis as { caches?: CacheStorage }).caches
  let cache: Cache | undefined
  if (cacheApi) {
    try {
      cache = await cacheApi.open('statusping')
      const hit = await cache.match(c.req.url)
      // Check freshness ourselves: not every Cache API implementation expires entries.
      const cachedAt = Number(hit?.headers.get('x-statusping-cached-at') ?? 0)
      if (hit && Date.now() - cachedAt < maxAge * 1000) return hit
      if (hit) await cache.delete(c.req.url)
    } catch {
      cache = undefined
    }
  }
  const res = await render()
  res.headers.set('cache-control', `public, max-age=${maxAge}`)
  res.headers.set('x-statusping-cached-at', String(Date.now()))
  if (cache && res.status === 200) {
    const put = cache.put(c.req.url, res.clone()).catch(() => {})
    try {
      c.executionCtx.waitUntil(put)
    } catch {
      await put
    }
  }
  return res
}

function runAfterResponse(c: Context, deps: Deps, p: Promise<unknown>) {
  const guarded = p.catch((e) => deps.log('error', 'background task failed', { error: (e as Error).message }))
  try {
    c.executionCtx.waitUntil(guarded)
  } catch {
    // No ExecutionContext (Node): the promise keeps running on its own.
  }
}

export function createApp(deps: Deps): Hono {
  const app = new Hono()
  let config = deps.config
  // An admins list also needs a sign-in affordance on otherwise-public monitor pages.
  let hasRestricted = config.pages.some((p) => p.access !== 'public') || Boolean(config.access?.admins)

  app.use('*', async (_c, next) => {
    await ensureSchema(deps.db)
    await refreshAdminConfig(deps, nowSeconds())
    config = deps.config
    hasRestricted = config.pages.some((p) => p.access !== 'public') || Boolean(config.access?.admins)
    await next()
  })

  app.onError((err, c) => {
    deps.log('error', 'request failed', { path: c.req.path, error: err.message })
    return c.text('Internal error', 500)
  })

  // ── Push endpoints (Healthchecks.io-compatible paths) ──────────────────────────────────────
  const ping = async (c: Context) => {
    const signal = parseSignal(c.req.param('action'))
    if (!signal) return c.text('Unknown signal', 400)
    let body: string | null = null
    if (c.req.method === 'POST' || c.req.method === 'PUT') {
      const text = await c.req.text()
      body = text ? text.slice(0, MAX_PING_BODY) : null
    }
    const now = nowSeconds()
    const ip = deps.clientIp(c.req.raw)
    if (ip && !(await consumePingRateLimit(deps.db, ip, now, config.limits.pingPerIpPerMinute))) {
      return c.text('Too many requests', 429, { 'cache-control': 'no-store', 'retry-after': String(60 - (now % 60)) })
    }
    const outcome = await handlePing(
      deps,
      c.req.param('token') ?? '',
      signal,
      {
        body,
        ip,
        userAgent: c.req.header('user-agent') ?? null,
      },
      now,
    )
    if (outcome.status !== 200) return c.text(outcome.status === 404 ? 'Not found' : 'Bad request', outcome.status)
    if (outcome.from !== outcome.to && (outcome.to === 'down' || outcome.from === 'down')) {
      runAfterResponse(c, deps, dispatchNotifications(deps, now, outcome.monitorId))
    }
    return c.text('OK', 200, { 'cache-control': 'no-store' })
  }
  app.on(['GET', 'POST', 'PUT', 'HEAD'], '/ping/:token', ping)
  app.on(['GET', 'POST', 'PUT', 'HEAD'], '/ping/:token/:action', ping)

  // ── Health & scheduler hooks ───────────────────────────────────────────────────────────────
  app.get('/healthz', async (c) => {
    const now = nowSeconds()
    try {
      const last = await lastTickAt(deps)
      const lag = last === null ? null : now - last
      const ok = lag !== null && lag <= STALE_TICK_SECONDS
      // These are intentionally public, non-secret deployment facts. They let an
      // operator (and a future update-review flow) identify compatibility without
      // disclosing configuration or credentials.
      const channel = deps.getEnv('STATUSPING_RELEASE_CHANNEL') ?? 'stable'
      const instanceId = deps.getEnv('STATUSPING_INSTANCE_ID') ?? null
      return c.json({ ok, version: APP_VERSION, schemaVersion: SCHEMA_VERSION, channel, instanceId, role: deps.role, lastTickAt: last, lagSeconds: lag }, ok ? 200 : 503, {
        'cache-control': 'no-store',
      })
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 503)
    }
  })

  app.post('/tick', async (c) => {
    const secret = deps.getEnv('TICK_SECRET')
    if (!secret) return c.text('Not found', 404)
    const auth = c.req.header('authorization') ?? ''
    if (!timingSafeEqual(auth, `Bearer ${secret}`)) return c.text('Unauthorized', 401)
    return c.json(await tick(deps))
  })

  // ── Management API: manual status announcements ────────────────────────────────────────────
  // Kept deliberately independent of the future browser admin UI.  A missing token is a 404 so
  // deployments do not advertise an administrative surface by accident.
  const adminAuthorized = (c: Context) => {
    const token = deps.getEnv('ADMIN_TOKEN')
    if (!token) return null
    return timingSafeEqual(c.req.header('authorization') ?? '', `Bearer ${token}`)
  }
  const parseJson = async (c: Context): Promise<unknown | null> => {
    try { return await c.req.json() } catch { return null }
  }
  app.post('/api/admin/incidents', async (c) => {
    const ok = adminAuthorized(c)
    if (ok === null) return c.text('Not found', 404)
    if (!ok) return c.text('Unauthorized', 401)
    const input = parseAnnouncementCreate(await parseJson(c))
    if (!input) return c.json({ error: 'Invalid incident payload' }, 400)
    const known = new Set(config.monitors.map((monitor) => monitor.id))
    if (input.monitors.some((id) => !known.has(id))) return c.json({ error: 'Unknown monitor' }, 400)
    const announcement = await createAnnouncement(deps.db, input, nowSeconds())
    runAfterResponse(c, deps, Promise.all([
      enqueueAnnouncement(deps, announcement, 'created', nowSeconds()).then(() => dispatchSubscriberOutbox(deps, nowSeconds())),
      enqueueAnnouncementNotifications(deps, announcement, nowSeconds()).then(() => dispatchAnnouncementNotifications(deps, nowSeconds())),
    ]))
    return c.json(announcement, 201)
  })
  const updateAnnouncement = async (c: Context, raw: unknown, routeId?: string) => {
    const ok = adminAuthorized(c)
    if (ok === null) return c.text('Not found', 404)
    if (!ok) return c.text('Unauthorized', 401)
    const id = Number(routeId ?? (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).id : NaN))
    if (!Number.isSafeInteger(id) || id < 1) return c.text('Not found', 404)
    const input = parseAnnouncementPatch(raw)
    if (!input) return c.json({ error: 'Invalid incident payload' }, 400)
    const known = new Set(config.monitors.map((monitor) => monitor.id))
    if (input.monitors?.some((monitor) => !known.has(monitor))) return c.json({ error: 'Unknown monitor' }, 400)
    const announcement = await patchAnnouncement(deps.db, id, input, nowSeconds())
    if (announcement && (input.status !== undefined || input.body !== undefined)) runAfterResponse(c, deps, Promise.all([
      enqueueAnnouncement(deps, announcement, `update:${announcement.updates[0]?.id ?? announcement.id}`, nowSeconds()).then(() => dispatchSubscriberOutbox(deps, nowSeconds())),
      enqueueAnnouncementNotifications(deps, announcement, nowSeconds()).then(() => dispatchAnnouncementNotifications(deps, nowSeconds())),
    ]))
    return announcement ? c.json(announcement) : c.text('Not found', 404)
  }
  // Accept both REST-style /:id and the documented collection endpoint with an id in JSON.
  app.patch('/api/admin/incidents/:id', async (c) => updateAnnouncement(c, await parseJson(c), c.req.param('id')))
  app.patch('/api/admin/incidents', async (c) => updateAnnouncement(c, await parseJson(c)))

  // ── Sign-in ────────────────────────────────────────────────────────────────────────────────
  mountAuthRoutes(app, deps)

  // ── Browser admin + management API (strictly opt-in via `admin: true`) ─────────────────────
  mountAdminRoutes(app, deps)

  // ── Pages ──────────────────────────────────────────────────────────────────────────────────

  /** Resolves the page and enforces its access rule. Returns a Response to send on denial. */
  async function openPage(c: Context, slug: string): Promise<{ page: NormalizedPage; viewer: Viewer | null } | Response> {
    const page = config.pages.find((p) => p.slug === slug)
    if (!page) return notFound(c, 'There is no such page.')
    if (page.access === 'public') {
      // Personalize public pages only for signed-in visitors; everyone else gets the cached copy.
      const viewer = hasRestricted && hasCredentials(c) ? await currentViewer(c, deps) : null
      return { page, viewer }
    }
    const viewer = await currentViewer(c, deps)
    if (!viewer) return signInResponse(c, deps)
    if (!canOpen(page, viewer, config.access)) {
      const chrome = await buildChrome(deps, { viewer, current: c.req.path })
      return c.html(messagePage(chrome, 'No access', `${viewer.email} doesn't have access to this page.`), 403, {
        'cache-control': 'no-store',
      })
    }
    return { page, viewer }
  }

  app.post('/pages/:slug/subscribe', async (c) => {
    const r = await openPage(c, c.req.param('slug'))
    if (r instanceof Response) return r
    if (!config.subscribers) return c.text('Not found', 404)
    if (!sameOrigin(c, deps)) return c.text('Invalid origin', 403)
    const form = await c.req.parseBody().catch(() => ({}))
    // A restricted-page subscription belongs to the authenticated viewer, never a form field.
    const email = r.page.access === 'public' ? String((form as Record<string, string | File>).email ?? '') : r.viewer!.email
    const bucket = c.req.header('cf-connecting-ip') ? `ip:${c.req.header('cf-connecting-ip')}` : `page:${r.page.slug}`
    if (!(await consumeSubscribeLimit(deps.db, bucket, nowSeconds()))) return c.text('Too many subscription attempts; try again later.', 429)
    const result = await startSubscription(deps, r.page.slug, email, nowSeconds())
    if (result === 'invalid') return c.text('Enter a valid email address.', 400)
    return c.redirect(`/pages/${encodeURIComponent(r.page.slug)}?subscription=${result === 'confirmed' ? 'already-confirmed' : 'check-email'}`, 303)
  })
  app.get('/subscribe/confirm', async (c) => {
    const ok = await confirmSubscription(deps, c.req.query('token') ?? '', nowSeconds())
    return c.text(ok ? 'Your subscription is confirmed.' : 'This confirmation link is invalid or has already been used.', ok ? 200 : 400, { 'cache-control': 'no-store' })
  })
  app.get('/unsubscribe', async (c) => {
    const ok = await unsubscribe(deps, c.req.query('token') ?? '')
    return c.text(ok ? 'You have been unsubscribed.' : 'This unsubscribe link is invalid or has already been used.', ok ? 200 : 400, { 'cache-control': 'no-store' })
  })

  const ctxFor = async (
    c: Context,
    page: NormalizedPage,
    viewer: Viewer | null,
    tick: { lastTickAt: number | null; now: number },
  ): Promise<PageCtx> => ({
    ...(await buildChrome(deps, { viewer, current: c.req.path, currentSlug: page.slug, ...tick })),
    page,
    fields: new Set(page.show),
    base: `/pages/${page.slug}`,
    subscribersEnabled: Boolean(config.subscribers),
    canAcknowledge: canAcknowledge(viewer, config.access),
  })

  // Alert capability links are deliberately confirmed with a non-mutating GET. The token is
  // signed and expires, while acknowledgements.incident_id makes the POST single-use.
  app.get('/ack/:token', async (c) => {
    const secret = deps.getEnv('ACK_SECRET')
    if (!secret) return c.text('Not found', 404)
    const incidentId = await verifyAcknowledgeToken(c.req.param('token'), nowSeconds(), secret)
    if (!incidentId) return c.text('Not found', 404)
    const incident = await deps.db.first<{ monitor_id: string; name: string; resolved_at: number | null }>(
      `SELECT i.monitor_id, m.name, i.resolved_at FROM incidents i JOIN monitors m ON m.id = i.monitor_id WHERE i.id = ?`, [incidentId],
    )
    if (!incident || incident.resolved_at !== null) return c.text('Not found', 404)
    const chrome = await buildChrome(deps, { viewer: null, current: c.req.path })
    return c.html(acknowledgePage(chrome, c.req.param('token'), incident.name), 200, { 'cache-control': 'no-store' })
  })
  app.post('/ack', async (c) => {
    const secret = deps.getEnv('ACK_SECRET')
    if (!secret) return c.text('Not found', 404)
    const body = await c.req.parseBody()
    const token = typeof body.token === 'string' ? body.token : ''
    const incidentId = await verifyAcknowledgeToken(token, nowSeconds(), secret)
    if (!incidentId) return c.text('Not found', 404)
    const incident = await deps.db.first<{ monitor_id: string; resolved_at: number | null }>(`SELECT monitor_id, resolved_at FROM incidents WHERE id = ?`, [incidentId])
    if (!incident || incident.resolved_at !== null) return c.text('Not found', 404)
    const created = await acknowledgeIncident(deps.db, incidentId, 'alert-link', 'alert-link', nowSeconds())
    const chrome = await buildChrome(deps, { viewer: null, current: c.req.path })
    return c.html(messagePage(chrome, created ? 'Incident acknowledged' : 'Already acknowledged', created ? 'Further escalation alerts have been stopped.' : 'This incident was already acknowledged.'), 200, { 'cache-control': 'no-store' })
  })

  /** "Not found" page with the shared header/footer (personalized only if signed in). */
  async function notFound(c: Context, message: string) {
    const viewer = hasRestricted && hasCredentials(c) ? await currentViewer(c, deps) : null
    const chrome = await buildChrome(deps, { viewer, current: c.req.path })
    return c.html(messagePage(chrome, 'Not found', message), 404, viewer ? { 'cache-control': 'no-store' } : {})
  }

  /** Anonymous views of public pages go through the shared edge cache; everything else is private. */
  const respond = (c: Context, page: NormalizedPage, render: () => Promise<Response>, viewer: Viewer | null = null) => {
    if (page.access === 'public' && !viewer) return withEdgeCache(c, render)
    return render().then(async (res) => {
      res.headers.set('cache-control', 'private, no-store')
      res.headers.set('vary', 'cookie, authorization')
      return res
    })
  }

  const renderPage = async (c: Context, slug: string) => {
    const r = await openPage(c, slug)
    if (r instanceof Response) return r
    return respond(
      c,
      r.page,
      async () => {
        const data = await loadStatusData(deps, nowSeconds(), r.page.monitorIds)
        return c.html(statusPage(data, await ctxFor(c, r.page, r.viewer, data)))
      },
      r.viewer,
    )
  }

  app.get('/', async (c) => {
    const home = config.home ?? config.pages[0]?.slug
    if (!home) return notFound(c, 'No status pages are configured.')
    return renderPage(c, home)
  })

  app.get('/pages/:slug', (c) => renderPage(c, c.req.param('slug')))

  app.get('/pages/:slug/m/:id', async (c) => {
    const r = await openPage(c, c.req.param('slug'))
    if (r instanceof Response) return r
    const id = c.req.param('id')
    if (!r.page.monitorIds.includes(id)) return notFound(c, 'No such monitor on this page.')
    return respond(
      c,
      r.page,
      async () => {
        const now = nowSeconds()
        const detail = await loadMonitorDetail(deps, id, now)
        if (!detail) return notFound(c, 'No such monitor on this page.')
        return c.html(monitorPage(detail, await ctxFor(c, r.page, r.viewer, { lastTickAt: detail.lastTickAt, now })))
      },
      r.viewer,
    )
  })

  app.post('/pages/:slug/m/:id/ack', async (c) => {
    const r = await openPage(c, c.req.param('slug'))
    if (r instanceof Response) return r
    const viewer = await currentViewer(c, deps)
    if (!canAcknowledge(viewer, config.access)) return c.text('Forbidden', 403)
    if (!sameOrigin(c, deps)) return c.text('Forbidden', 403)
    const id = c.req.param('id')
    if (!r.page.monitorIds.includes(id)) return c.text('Not found', 404)
    const monitor = config.monitors.find((candidate) => candidate.id === id)
    if (!monitor?.escalation) return c.text('Not found', 404)
    const body = await c.req.parseBody()
    const incidentId = Number(typeof body.incidentId === 'string' ? body.incidentId : NaN)
    if (!Number.isSafeInteger(incidentId) || incidentId < 1) return c.text('Not found', 404)
    const incident = await deps.db.first<{ id: number }>(`SELECT id FROM incidents WHERE id = ? AND monitor_id = ? AND severity = 'outage' AND resolved_at IS NULL`, [incidentId, id])
    if (!incident) return c.text('Not found', 404)
    await acknowledgeIncident(deps.db, incidentId, viewer!.email, 'admin-page', nowSeconds())
    return c.redirect(`/pages/${encodeURIComponent(r.page.slug)}/m/${encodeURIComponent(id)}`, 303)
  })

  // ── Public SVG badges ────────────────────────────────────────────────────────────────────
  // Keep every denial identical: badges must not reveal restricted pages or monitors.
  app.get('/badge/:page/:file', async (c) => {
    const file = c.req.param('file')
    const monitorId = file.endsWith('.svg') ? file.slice(0, -'.svg'.length) : ''
    const page = config.pages.find((candidate) => candidate.slug === c.req.param('page'))
    const style = c.req.query('style') ?? 'status'
    if (!page || page.access !== 'public' || !page.monitorIds.includes(monitorId) || (style !== 'status' && style !== 'uptime')) {
      return c.text('Not found', 404)
    }
    return withEdgeCache(c, async () => {
      const data = await loadStatusData(deps, nowSeconds(), [monitorId])
      const view = data.groups.flatMap((group) => group.monitors).find((monitor) => monitor.monitor.id === monitorId)
      if (!view) return c.text('Not found', 404)
      return c.body(renderBadge(view, style), 200, {
        'content-type': 'image/svg+xml; charset=utf-8',
      })
    }, 60)
  })

  // ── JSON API (same access rules and fields as the page) ────────────────────────────────────
  const pageJson = (data: StatusData, page: NormalizedPage) => {
    const f = new Set(page.show)
    return {
      page: page.slug,
      title: page.title,
      generatedAt: data.now,
      lastTickAt: data.lastTickAt,
      counts: data.counts,
      maintenance: {
        active: data.activeMaintenance.map((window) => ({
          title: window.title,
          start: window.start,
          end: window.end,
          recurring: window.recurring,
          monitors: window.monitorIds,
          excludeFromUptime: window.excludeFromUptime,
        })),
        upcoming: data.upcomingMaintenance.map((window) => ({
          title: window.title,
          start: window.start,
          end: window.end,
          recurring: window.recurring,
          monitors: window.monitorIds,
          excludeFromUptime: window.excludeFromUptime,
        })),
      },
      monitors: data.groups.flatMap((g) =>
        g.monitors.map((m) => ({
          id: m.monitor.id,
          name: m.monitor.name,
          group: g.name,
          kind: m.monitor.kind,
          status: m.state.status,
          since: m.state.status_since,
          maintenance: m.maintenance.map((window) => ({ title: window.title, start: window.start, end: window.end, recurring: window.recurring })),
          ...(f.has('uptime') ? { uptime24h: m.uptime24h, uptime90d: m.uptime90 } : {}),
          ...(f.has('pings') && m.monitor.kind === 'push'
            ? { lastPingAt: m.state.last_ping_at, lastDurationMs: m.state.last_duration_ms }
            : {}),
          ...(f.has('errors') ? { lastError: m.state.last_error } : {}),
          ...(f.has('target') && m.monitor.kind === 'http'
            ? { url: m.monitor.url }
            : f.has('target') && m.monitor.kind === 'tcp'
              ? { host: m.monitor.host, port: m.monitor.port }
              : {}),
        })),
      ),
    }
  }

  const renderJson = async (c: Context, slug: string) => {
    const r = await openPage(c, slug)
    if (r instanceof Response) return r
    return respond(c, r.page, async () =>
      c.json(pageJson(await loadStatusData(deps, nowSeconds(), r.page.monitorIds), r.page)),
    )
  }
  app.get('/api/pages/:slug', (c) => renderJson(c, c.req.param('slug')))
  app.get('/api/pages/:slug/incidents', async (c) => {
    const r = await openPage(c, c.req.param('slug'))
    if (r instanceof Response) return r
    // Do not make incident history an accidental public API for a page that deliberately hides it.
    if (!r.page.show.includes('incidents')) return c.text('Not found', 404)
    const status = c.req.query('status')
    const daysText = c.req.query('days')
    if (status !== undefined && status !== 'open' && status !== 'resolved') return c.json({ error: 'status must be open or resolved' }, 400)
    if (daysText !== undefined && daysText !== '7' && daysText !== '30' && daysText !== '90') return c.json({ error: 'days must be 7, 30, or 90' }, 400)
    const now = nowSeconds(); const since = now - Number(daysText ?? '90') * 86_400
    const ids = r.page.monitorIds
    const placeholders = ids.map(() => '?').join(', ')
    const automatic = ids.length
      ? await deps.db.all<{ id: number; monitor_id: string; reason: string; severity: string; detail: string | null; started_at: number; resolved_at: number | null }>(
          `SELECT id, monitor_id, reason, severity, detail, started_at, resolved_at FROM incidents WHERE monitor_id IN (${placeholders}) AND started_at >= ?${status === 'open' ? ' AND resolved_at IS NULL' : status === 'resolved' ? ' AND resolved_at IS NOT NULL' : ''} ORDER BY started_at DESC`,
          [...ids, since],
        )
      : []
    const announcements = (await listAnnouncements(deps.db, { status: status as 'open' | 'resolved' | undefined, since })).filter((item) => item.monitors.some((id) => ids.includes(id)))
    return respond(c, r.page, async () => c.json({ generatedAt: now, automatic: automatic.map((item) => ({ id: item.id, monitorId: item.monitor_id, reason: item.reason, severity: item.severity, ...(r.page.show.includes('errors') ? { detail: item.detail } : {}), startedAt: item.started_at, resolvedAt: item.resolved_at })), announcements }))
  })
  app.get('/api/status', async (c) => (config.home ? renderJson(c, config.home) : c.json({ error: 'no home page' }, 404)))

  app.notFound((c) => notFound(c, 'There is nothing here.'))
  return app
}
