import { Hono } from 'hono'
import type { Context } from 'hono'
import { currentViewer, hasCredentials, mountAuthRoutes, signInResponse } from '../auth/providers.ts'
import { type Viewer, canOpen } from '../auth/viewer.ts'
import type { NormalizedPage } from '../config.ts'
import type { Deps } from '../deps.ts'
import { dispatchNotifications } from '../notify/dispatch.ts'
import { MAX_PING_BODY, handlePing, parseSignal } from '../ping.ts'
import { ensureSchema } from '../schema.ts'
import { tick } from '../tick.ts'
import { timingSafeEqual } from '../util/crypto.ts'
import { nowSeconds } from '../util/time.ts'
import { type StatusData, lastTickAt, loadMonitorDetail, loadStatusData } from './data.ts'
import { buildChrome } from './chrome.ts'
import { type PageCtx, messagePage, monitorPage, statusPage } from './pages.ts'

const STALE_TICK_SECONDS = 180
const PUBLIC_MAX_AGE = 30

type Cacheable = { cacheable: boolean }

/**
 * Serves public pages through the edge cache (Cloudflare Cache API) to save CPU and DB
 * reads. Only ever used for responses that are identical for every visitor.
 */
async function withEdgeCache(c: Context, render: () => Promise<Response>): Promise<Response> {
  const cacheApi = (globalThis as { caches?: CacheStorage }).caches
  let cache: Cache | undefined
  if (cacheApi) {
    try {
      cache = await cacheApi.open('statusping')
      const hit = await cache.match(c.req.url)
      // Check freshness ourselves: not every Cache API implementation expires entries.
      const cachedAt = Number(hit?.headers.get('x-statusping-cached-at') ?? 0)
      if (hit && Date.now() - cachedAt < PUBLIC_MAX_AGE * 1000) return hit
      if (hit) await cache.delete(c.req.url)
    } catch {
      cache = undefined
    }
  }
  const res = await render()
  res.headers.set('cache-control', `public, max-age=${PUBLIC_MAX_AGE}`)
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
  const { config } = deps
  const hasRestricted = config.pages.some((p) => p.access !== 'public')

  app.use('*', async (_c, next) => {
    await ensureSchema(deps.db)
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
    const outcome = await handlePing(
      deps,
      c.req.param('token') ?? '',
      signal,
      {
        body,
        ip: c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
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
      return c.json({ ok, role: deps.role, lastTickAt: last, lagSeconds: lag }, ok ? 200 : 503, {
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

  // ── Sign-in ────────────────────────────────────────────────────────────────────────────────
  mountAuthRoutes(app, deps)

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

  // ── JSON API (same access rules and fields as the page) ────────────────────────────────────
  const pageJson = (data: StatusData, page: NormalizedPage) => {
    const f = new Set(page.show)
    return {
      page: page.slug,
      title: page.title,
      generatedAt: data.now,
      lastTickAt: data.lastTickAt,
      counts: data.counts,
      monitors: data.groups.flatMap((g) =>
        g.monitors.map((m) => ({
          id: m.monitor.id,
          name: m.monitor.name,
          group: g.name,
          kind: m.monitor.kind,
          status: m.state.status,
          since: m.state.status_since,
          ...(f.has('uptime') ? { uptime24h: m.uptime24h, uptime90d: m.uptime90 } : {}),
          ...(f.has('pings') && m.monitor.kind === 'push'
            ? { lastPingAt: m.state.last_ping_at, lastDurationMs: m.state.last_duration_ms }
            : {}),
          ...(f.has('errors') ? { lastError: m.state.last_error } : {}),
          ...(f.has('target') && m.monitor.kind === 'http' ? { url: m.monitor.url } : {}),
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
  app.get('/api/status', async (c) => (config.home ? renderJson(c, config.home) : c.json({ error: 'no home page' }, 404)))

  app.notFound((c) => notFound(c, 'There is nothing here.'))
  return app
}
