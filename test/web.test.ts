import { afterEach, describe, expect, it } from 'vitest'
import { type StatusPingConfig, normalizeConfig } from '../src/config.ts'
import { tick } from '../src/tick.ts'
import { createApp } from '../src/web/app.ts'
import { loadStatusData } from '../src/web/data.ts'
import { APP_VERSION } from '../src/version.ts'
import { type CountingDb, TEST_TOKENS, createTestDb, fakeFetch, makeDeps, testConfig } from './helpers.ts'

describe('HTTP routes (no sign-in configured)', () => {
  let db: CountingDb
  let close: () => Promise<void>
  afterEach(async () => close?.())

  const setup = async (opts: { env?: Record<string, string>; config?: StatusPingConfig } = {}) => {
    ;({ db, close } = await createTestDb('libsql'))
    const f = fakeFetch((c) => (c.url.startsWith('https://site.test') ? new Response('ok') : new Response('{}')))
    const deps = makeDeps(db, { fetch: f.fn, env: opts.env, config: opts.config })
    await tick(deps)
    return { app: createApp(deps), deps, f }
  }

  it('ping endpoints: GET/POST, start, exit codes, 404 and 400', async () => {
    const { app } = await setup()
    const t = TEST_TOKENS.heartbeat
    expect((await app.request(`/ping/${t}`)).status).toBe(200)
    expect(await (await app.request(`/ping/${t}/start`, { method: 'POST' })).text()).toBe('OK')
    expect((await app.request(`/ping/${t}/1`, { method: 'POST', body: 'disk full' })).status).toBe(200)
    expect((await app.request(`/ping/${'x'.repeat(24)}`)).status).toBe(404)
    expect((await app.request(`/ping/${t}/explode`)).status).toBe(400)
    const pings = await db.all<{ kind: string; body: string | null; exit_code: number | null }>(
      `SELECT kind, body, exit_code FROM pings ORDER BY id`,
    )
    expect(pings.map((p) => p.kind)).toEqual(['success', 'start', 'fail'])
    expect(pings[2]).toMatchObject({ body: 'disk full', exit_code: 1 })
  })

  it('default page at / shows status + uptime + incidents, but never logs or error text', async () => {
    const { app } = await setup()
    await app.request(`/ping/${TEST_TOKENS.heartbeat}/fail`, { method: 'POST', body: 'secret-path <script>x</script>' })
    const home = await app.request('/')
    expect(home.status).toBe(200)
    expect(home.headers.get('cache-control')).toBe('public, max-age=30')
    const body = await home.text()
    expect(body).toContain('Heartbeat')
    expect(body).toContain('We’re currently experiencing issues')
    // Affected monitor chip + an incident card with title and meta line.
    expect(body).toContain('<a class="chip down" href="/pages/status/m/heartbeat">Heartbeat</a>')
    expect(body).toContain('Heartbeat reported a failure</a>')
    expect(body).toMatch(/Down<span aria-hidden="true">·<\/span>Started <time[^>]*>[^<]+<\/time><span aria-hidden="true">·<\/span>Ongoing for \d+ seconds?/)
    expect(body).not.toContain('class="incident-body"') // public page: no 'errors' field
    expect(body).not.toContain('secret-path')

    const detail = await (await app.request('/pages/status/m/heartbeat')).text()
    expect(detail).toContain('Incidents')
    expect(detail).not.toContain('secret-path')
    expect(detail).not.toContain('Recent runs')
    expect(detail).not.toContain('<script>x</script>')
  })

  it('maps page-scoped latency rollups into daily bars and the 24-hour response-time trend', async () => {
    const config = testConfig({ pages: [{ slug: 'status', title: 'Status', show: ['uptime', 'response-time'], monitors: ['site'] }] })
    const { app, deps } = await setup({ config })
    const now = Math.floor(Date.now() / 1000)
    const hour = Math.floor(now / 3600) * 3600 - 3600
    const day = now - (now % 86_400) - 86_400
    await db.run(`INSERT INTO latency_hourly (monitor_id, hour, avg_ms, p95_ms, samples) VALUES (?, ?, ?, ?, ?)`, ['site', hour, 123, 180, 4])
    await db.run(`INSERT INTO latency_daily (monitor_id, day, avg_ms, samples) VALUES (?, ?, ?, ?)`, ['site', day, 111, 96])
    // This must not leak through a page scoped to Site.
    await db.run(`INSERT INTO latency_hourly (monitor_id, hour, avg_ms, p95_ms, samples) VALUES (?, ?, ?, ?, ?)`, ['backup-db', hour, 999, 999, 1])

    const data = await loadStatusData(deps, now, ['site'])
    const site = data.groups.flatMap((group) => group.monitors).find((monitor) => monitor.monitor.id === 'site')!
    expect(site.latency24h.at(-1)).toMatchObject({ hour, avgMs: 123, p95Ms: 180, samples: 4 })
    expect(site.bars.find((bar) => bar.day === new Date(day * 1000).toISOString().slice(0, 10))?.avgLatencyMs).toBe(111)

    const body = await (await app.request('/')).text()
    expect(body).toContain('class="latency-trend"')
    expect(body).toContain('Response time <span>24h</span>')
    expect(body).toContain('Average response 111 ms')
    expect(body).not.toContain('999 ms')
  })

  it('times are emitted as <time datetime> elements plus a script that localizes them', async () => {
    const { app } = await setup()
    const body = await (await app.request('/')).text()
    expect(body).toMatch(/Last updated <time datetime="\d{4}-\d{2}-\d{2}T[\d:.]+Z" data-fmt="at">today, \d{1,2}:\d{2} [AP]M</)
    expect(body.indexOf('<footer')).toBeLessThan(body.indexOf('<script>')) // footer times get localized too
    expect(body).toContain("document.querySelectorAll('time[data-fmt]')")
  })

  it('every page shares the header bar (menu + account) and the footer', async () => {
    const { app } = await setup()
    for (const path of ['/', '/pages/status/m/site', '/pages/nope', '/nothing-here']) {
      const body = await (await app.request(path)).text()
      expect(body, path).toContain('class="site-header"')
      expect(body, path).toContain('Times shown in')
      expect(body, path).toContain('Powered by <a href="https://statusp.ing">StatusPing</a>')
    }
  })

  it('page title is a dropdown switcher only when 2+ pages are available', async () => {
    const one = await setup()
    expect(await (await one.app.request('/')).text()).not.toContain('class="switcher"')
    await close()
    const config = testConfig({
      pages: [
        { slug: 'web', title: 'Web', monitors: ['site'] },
        { slug: 'jobs', title: 'Jobs page', monitors: ['group:Jobs'] },
      ],
    })
    const two = await setup({ config })
    const body = await (await two.app.request('/pages/jobs')).text()
    expect(body).toContain('<details class="switcher">')
    expect(body).toMatch(/<h1>Jobs page<svg class="chevron"/)
    expect(body).toContain('href="/pages/web"')
    expect(body).toMatch(/aria-checked="true" href="\/pages\/jobs" class="menu-item" aria-current="page"/)
  })

  it("show: 'all' on a public page exposes logs, escaped", async () => {
    const config = testConfig({ pages: [{ slug: 'status', title: 'S', show: 'all', monitors: ['*'] }] })
    const { app } = await setup({ config })
    await app.request(`/ping/${TEST_TOKENS.heartbeat}/fail`, { method: 'POST', body: '<script>x</script>' })
    const detail = await (await app.request('/pages/status/m/heartbeat')).text()
    expect(detail).toContain('Recent runs')
    expect(detail).toContain('&lt;script&gt;x&lt;/script&gt;')
    // Rows show Started + Result; the caret unfolds run time / exit code / log in a row below.
    expect(detail).toContain('<thead><tr><th>Started</th><th class="num">Result</th></tr></thead>')
    expect(detail).toContain('<details class="run"><summary>')
    expect(detail).toMatch(/<tr class="detail-row"><td colspan="2">[\s\S]*?<pre>&lt;script&gt;/)
    expect(detail).not.toContain('<script>x</script>')
  })

  it('a monitor can appear on several pages; pages only show their own monitors', async () => {
    const config = testConfig({
      pages: [
        { slug: 'web', title: 'Web', monitors: ['site'] },
        { slug: 'jobs', title: 'Jobs page', monitors: ['group:Jobs', 'site'] },
      ],
    })
    const { app } = await setup({ config })
    const web = await (await app.request('/pages/web')).text()
    expect(web).toContain('Site')
    expect(web).not.toContain('Heartbeat')
    const jobs = await (await app.request('/pages/jobs')).text()
    expect(jobs).toContain('Site')
    expect(jobs).toContain('Heartbeat')
    expect((await app.request('/pages/web/m/heartbeat')).status).toBe(404)
    expect((await app.request('/pages/nope')).status).toBe(404)
  })

  it('renders cached, escaped SVG badges only for listed monitors on public pages', async () => {
    const config = testConfig({
      groups: [{ name: 'Web', monitors: [{ id: 'site', kind: 'http', name: 'Site & <prod>', url: 'https://site.test/health' }] }],
      access: { provider: { type: 'basic' } },
      pages: [
        { slug: 'public', title: 'Public', access: 'public', monitors: ['site'] },
        { slug: 'private', title: 'Private', access: { emails: ['owner@example.test'] }, monitors: ['site'] },
      ],
    })
    const { app } = await setup({ config })
    await db.run(`UPDATE monitors SET created_at = ? WHERE id = ?`, [Math.floor(Date.now() / 1000) - 3600, 'site'])
    const status = await app.request('/badge/public/site.svg')
    expect(status.status).toBe(200)
    expect(status.headers.get('content-type')).toContain('image/svg+xml')
    expect(status.headers.get('cache-control')).toBe('public, max-age=60')
    const svg = await status.text()
    expect(svg).toContain('Site &amp; &lt;prod&gt;')
    expect(svg).toContain('operational')
    expect(svg).not.toContain('Site & <prod>')

    const uptime = await (await app.request('/badge/public/site.svg?style=uptime')).text()
    expect(uptime).toContain('uptime')
    expect(uptime).toMatch(/\d{2,3}\.\d{2}%/)

    const restricted = await app.request('/badge/private/site.svg')
    const missing = await app.request('/badge/public/nope.svg')
    const unknownPage = await app.request('/badge/nope/site.svg')
    expect([restricted.status, missing.status, unknownPage.status]).toEqual([404, 404, 404])
    expect(await Promise.all([restricted.text(), missing.text(), unknownPage.text()])).toEqual(['Not found', 'Not found', 'Not found'])
  })

  it('banner says "We’re fully operational" when nothing is down', async () => {
    const config = testConfig({ pages: [{ slug: 'web', title: 'Web', monitors: ['site'] }] })
    const { app } = await setup({ config })
    const body = await (await app.request('/pages/web')).text()
    expect(body).toContain('We’re fully operational')
    expect(body).toContain('We’re not aware of any issues affecting our systems.')
  })

  it('shows expiry warnings in amber without changing availability or uptime', async () => {
    const { app } = await setup()
    const now = Math.floor(Date.now() / 1000)
    await db.run(
      `INSERT INTO incidents (monitor_id, reason, severity, detail, started_at) VALUES (?, ?, ?, ?, ?)`,
      ['site', 'ssl_expiring', 'warning', 'certificate expires in 7 days: internal.example', now],
    )

    const status = await (await app.request('/')).text()
    expect(status).toContain('We’re fully operational')
    expect(status).toContain('A monitoring warning needs attention')
    expect(status).toContain('Site has a certificate expiring soon')
    expect(status).not.toContain('<span class="pill down">Down</span>')
    expect(status).not.toContain('internal.example')

    const detail = await (await app.request('/pages/status/m/site')).text()
    expect(detail).toContain('Active warnings')
    expect(detail).toContain('Certificate expiring')
    expect(detail).not.toContain('internal.example')
    expect(detail).not.toContain('<span class="pill down">Ongoing</span>')
  })

  it('shows active and upcoming maintenance, marks affected monitors, and excludes overlapping windows from uptime', async () => {
    // Keep the synthetic clock just ahead of setup's initial tick, so the monitor already
    // exists when loadStatusData computes the 24-hour denominator.
    const clock = Math.floor(Date.now() / 1000)
    const now = clock + 120
    const iso = (second: number) => new Date(second * 1000).toISOString()
    const config = testConfig({
      maintenance: [
        // The two historical exclusions overlap. Their union fully covers the outage below;
        // treating them independently would incorrectly subtract the shared 20 minutes twice.
        { title: 'Database migration', monitors: ['site'], start: iso(now - 3_600), end: iso(now - 1_800) },
        { title: 'Network work', monitors: ['site'], start: iso(now - 3_000), end: iso(now - 1_200) },
        { title: 'Live deploy', monitors: ['site'], start: iso(clock - 30), end: iso(clock + 3_600) },
        { title: 'Next deploy', monitors: ['site'], start: iso(clock + 2 * 86_400), end: iso(clock + 2 * 86_400 + 1_800) },
      ],
    })
    const { app, deps } = await setup({ config })
    await db.run(`UPDATE monitors SET created_at = ? WHERE id = ?`, [now - 86_400, 'site'])
    await db.run(
      `INSERT INTO incidents (monitor_id, reason, detail, started_at, resolved_at) VALUES (?, ?, ?, ?, ?)`,
      ['site', 'check_failed', 'planned deploy outage', now - 3_300, now - 1_500],
    )

    const data = await loadStatusData(deps, now, ['site'])
    const site = data.groups[0]!.monitors[0]!
    expect(site.uptime24h).toBe(1)
    expect(site.bars.at(-1)!.maintenance).toHaveLength(3)
    expect(data.activeMaintenance).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Live deploy' })]))

    // Use a distinct request URL so this public response cannot be a 30-second edge-cache
    // entry left by another app instance in the same test process.
    const body = await (await app.request('https://maintenance.status.test/')).text()
    expect(body).toContain('Maintenance in progress')
    expect(body).toContain('Live deploy')
    expect(body).toContain('Upcoming maintenance')
    expect(body).toContain('Next deploy')
    expect(body).toContain('<span class="pill maintenance">Maintenance</span>')
    expect(body).toContain('class="bar up maintenance"')

    const json = (await (await app.request('https://maintenance.status.test/api/status')).json()) as {
      maintenance: { active: { title: string; monitors: string[] }[]; upcoming: { title: string }[] }
      monitors: { id: string; uptime24h?: number; maintenance: { title: string }[] }[]
    }
    expect(json.maintenance.active).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Live deploy', monitors: ['site'] })]))
    expect(json.maintenance.upcoming).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Next deploy' })]))
    expect(json.monitors.find((monitor) => monitor.id === 'site')).toMatchObject({ uptime24h: 1, maintenance: [{ title: 'Live deploy' }] })
  })

  it('JSON API follows the page fields', async () => {
    const { app } = await setup()
    const json = (await (await app.request('/api/status')).json()) as {
      monitors: Record<string, unknown>[]
      lastTickAt: number
    }
    expect(json.monitors.map((m) => m.id)).toEqual(['backup-db', 'heartbeat', 'site'])
    expect(json.monitors[2]).toHaveProperty('uptime90d')
    expect(json.monitors[2]).not.toHaveProperty('lastError')
    expect(json.monitors[2]).not.toHaveProperty('url')
    expect((await app.request('/api/pages/status')).status).toBe(200)
  })

  it('healthz and POST /tick', async () => {
    const off = await setup()
    expect(await (await off.app.request('/healthz')).json()).toMatchObject({ ok: true, version: APP_VERSION, role: 'primary' })
    expect((await off.app.request('/tick', { method: 'POST' })).status).toBe(404)
    await close()
    const on = await setup({ env: { TICK_SECRET: 's3cret-value' } })
    expect((await on.app.request('/tick', { method: 'POST', headers: { authorization: 'Bearer nope' } })).status).toBe(401)
    const ok = await on.app.request('/tick', { method: 'POST', headers: { authorization: 'Bearer s3cret-value' } })
    expect(await ok.json()).toHaveProperty('tickAt')
  })
})

describe('bar popovers', () => {
  let db: CountingDb
  let close: () => Promise<void>
  afterEach(async () => close?.())

  const setup = async (config?: StatusPingConfig) => {
    ;({ db, close } = await createTestDb('libsql'))
    const deps = makeDeps(db, { config, fetch: fakeFetch((c) => (c.url.startsWith('https://site.test') ? new Response('ok') : new Response('{}'))).fn })
    const now = Math.floor(Date.now() / 1000)
    await tick(deps, (now - 100 * 86400) * 1000) // monitors exist for 100 days
    const add = (id: string, reason: string, detail: string, daysAgo: number, minutes: number | null) => {
      const start = now - daysAgo * 86400
      return db.run(`INSERT INTO incidents (monitor_id, reason, detail, started_at, resolved_at) VALUES (?, ?, ?, ?, ?)`, [
        id, reason, detail, start, minutes === null ? null : start + minutes * 60,
      ])
    }
    await add('site', 'check_failed', 'HTTP 502 from origin-secret', 3, 26)
    await add('site', 'check_failed', 'timeout after 10s', 40, 90)
    await add('heartbeat', 'missed', 'missed a ping', 200, 30) // outside every period except none
    await add('backup-db', 'failed', 'exit code 2', 0.01, null) // ongoing
    return { app: createApp(deps) }
  }

  it('bars with outages get a popover with the duration; details only with errors', async () => {
    const { app } = await setup(
      testConfig({ pages: [{ slug: 'status', title: 'S', monitors: ['*'] }, { slug: 'full', title: 'F', show: 'all', monitors: ['*'] }] }),
    )
    const pub = await (await app.request('/')).text()
    expect(pub).toContain('class="pop')
    expect(pub).toContain('26m down') // day total in the popover header
    expect(pub).toMatch(/class="pop-dur ?">26m</) // duration of the outage
    expect(pub).toContain('Check failed')
    expect(pub).not.toContain('origin-secret')
    // Healthy days get a popover too (hover/tap only, not in the Tab order).
    expect(pub).toMatch(/<span class="bar up" tabindex="-1" aria-label="[^"]+: 100% uptime · No downtime"><span class="pop[^"]*" role="tooltip">/)
    const full = await (await app.request('/pages/full')).text()
    expect(full).toContain('HTTP 502 from origin-secret')
  })
})

describe('page config validation', () => {
  const problems = (cfg: StatusPingConfig) => {
    try {
      normalizeConfig(cfg)
      return []
    } catch (e) {
      return (e as { problems: string[] }).problems
    }
  }

  it('rejects restricted pages without a provider, unknown monitors/teams, bad fields', () => {
    const p = problems(
      testConfig({
        pages: [
          { slug: 'a', title: 'A', access: { emails: ['x@y.test'] }, monitors: ['nope'] },
          { slug: 'b', title: 'B', show: ['uptime', 'gossip' as never], monitors: ['group:Missing'] },
          { slug: 'b', title: 'Dup', monitors: [] },
        ],
        home: 'zzz',
      }),
    ).join('\n')
    expect(p).toContain('requires an `access.provider`')
    expect(p).toContain('unknown monitor "nope"')
    expect(p).toContain('unknown field(s) gossip')
    expect(p).toContain('no monitors in group "Missing"')
    expect(p).toContain('duplicate slug')
    expect(p).toContain('home: unknown page "zzz"')
  })

  it('groups are SSO-only; basic and Cloudflare Access use email allowlists', () => {
    const p = problems(
      testConfig({
        access: { provider: { type: 'basic' }, teams: { ops: { groups: ['Ops'] } } },
        pages: [{ slug: 'ops', title: 'Ops', access: { groups: ['Ops'], teams: ['ghost'] }, monitors: ['*'] }],
      }),
    ).join('\n')
    expect(p).toContain('access.teams.ops: groups are only available with SSO')
    expect(p).toContain('page "ops": access: groups are only available with SSO')
    expect(p).toContain('unknown team "ghost"')
  })

  it('restricted pages default to all fields, public pages to uptime + incidents', () => {
    const c = normalizeConfig(
      testConfig({
        access: { provider: { type: 'basic' } },
        pages: [
          { slug: 'pub', title: 'P', monitors: ['*'] },
          { slug: 'ops', title: 'O', access: { emails: ['*@corp.test'] }, monitors: ['*'] },
        ],
      }),
    )
    expect(c.pages[0]!.show).toEqual(['uptime', 'incidents'])
    expect(c.pages[1]!.show).toContain('logs')
    expect(c.home).toBe('pub')
  })
})
