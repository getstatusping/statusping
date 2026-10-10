import { afterEach, describe, expect, it } from 'vitest'
import { dispatchNotifications } from '../src/notify/dispatch.ts'
import { handlePing, parseSignal } from '../src/ping.ts'
import { runRetention } from '../src/retention.ts'
import { tick } from '../src/tick.ts'
import {
  type CountingDb,
  DB_KINDS,
  TEST_TOKENS,
  at,
  createTestDb,
  fakeFetch,
  makeDeps,
  sec,
  testConfig,
} from './helpers.ts'

const meta = { body: null, ip: '1.2.3.4', userAgent: 'curl/8' }

describe.each(DB_KINDS)('flows on %s', (kind) => {
  let db: CountingDb
  let close: () => Promise<void>

  const setup = async () => {
    ;({ db, close } = await createTestDb(kind))
  }
  afterEach(async () => close?.())

  const ntfyCalls = (calls: { url: string; body: string | null }[]) =>
    calls.filter((c) => c.url === 'https://ntfy.sh/').map((c) => JSON.parse(c.body!) as { title: string; message: string })

  const states = async () =>
    Object.fromEntries(
      (await db.all<{ monitor_id: string; status: string }>(`SELECT monitor_id, status FROM monitor_state`)).map((r) => [
        r.monitor_id,
        r.status,
      ]),
    )

  it('push monitor: ping → missed → one alert per sink → recovery alert', async () => {
    await setup()
    const f = fakeFetch((c) => (c.url.startsWith('https://site.test') ? new Response('ok') : new Response('{}')))
    const deps = makeDeps(db, { fetch: f.fn })

    await tick(deps, at('2026-10-07T00:00:00Z'))
    expect(await states()).toMatchObject({ 'backup-db': 'new', heartbeat: 'new', site: 'up' })

    // Backup runs at 03:00 on the 7th.
    const ok = await handlePing(deps, TEST_TOKENS['backup-db'], parseSignal(undefined)!, meta, sec('2026-10-07T03:00:30Z'))
    expect(ok).toMatchObject({ status: 200, from: 'new', to: 'up' })

    // Next run due 2026-10-08 03:00, grace 30m. Nothing arrives.
    await tick(deps, at('2026-10-08T03:10:00Z'))
    expect((await states())['backup-db']).toBe('late')
    expect(ntfyCalls(f.calls).filter((m) => m.title.includes('Backup'))).toHaveLength(0)

    await tick(deps, at('2026-10-08T03:31:00Z'))
    expect((await states())['backup-db']).toBe('down')
    const downAlerts = ntfyCalls(f.calls).filter((m) => m.title.includes('Backup'))
    expect(downAlerts).toHaveLength(1)
    expect(downAlerts[0]!.title).toBe('🔴 Backup missed a ping')
    expect(downAlerts[0]!.message).toBe('Missed its 03:00 run (0 3 * * *, UTC).')

    // Further ticks while still down: no repeat alerts, no new incidents.
    await tick(deps, at('2026-10-08T03:32:00Z'))
    await tick(deps, at('2026-10-08T04:00:00Z'))
    expect(ntfyCalls(f.calls).filter((m) => m.title.includes('Backup'))).toHaveLength(1)
    expect((await db.all(`SELECT * FROM incidents WHERE monitor_id = 'backup-db'`)).length).toBe(1)

    // Late ping recovers it; dispatch sends one "recovered".
    await handlePing(deps, TEST_TOKENS['backup-db'], parseSignal(undefined)!, meta, sec('2026-10-08T04:12:00Z'))
    await dispatchNotifications(deps, sec('2026-10-08T04:12:00Z'), 'backup-db')
    const all = ntfyCalls(f.calls).filter((m) => m.title.includes('Backup'))
    expect(all).toHaveLength(2)
    expect(all[1]!.title).toBe('✅ Backup recovered')
    expect(all[1]!.message).toContain('Back up after 41m')
    const inc = await db.first<{ resolved_at: number }>(`SELECT resolved_at FROM incidents WHERE monitor_id = 'backup-db'`)
    expect(inc?.resolved_at).toBe(sec('2026-10-08T04:12:00Z'))
  })

  it('duplicate tick for the same minute is a no-op', async () => {
    await setup()
    const deps = makeDeps(db)
    const first = await tick(deps, at('2026-10-08T10:00:05Z'))
    const second = await tick(deps, at('2026-10-08T10:00:40Z'))
    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
  })

  it('fail signal with exit code and log → down immediately with excerpt', async () => {
    await setup()
    const f = fakeFetch()
    const deps = makeDeps(db, { fetch: f.fn })
    await tick(deps, at('2026-10-08T00:00:00Z'))
    await handlePing(deps, TEST_TOKENS.heartbeat, parseSignal('start')!, meta, sec('2026-10-08T00:01:00Z'))
    const res = await handlePing(
      deps,
      TEST_TOKENS.heartbeat,
      parseSignal('2')!,
      { ...meta, body: 'pg_dump: connection refused\nmore lines' },
      sec('2026-10-08T00:01:30Z'),
    )
    expect(res).toMatchObject({ status: 200, to: 'down' })
    const st = await db.first<{ status: string; down_reason: string; last_duration_ms: number; last_start_at: number | null }>(
      `SELECT * FROM monitor_state WHERE monitor_id = 'heartbeat'`,
    )
    expect(st).toMatchObject({ status: 'down', down_reason: 'failed', last_duration_ms: 30_000, last_start_at: null })
    await dispatchNotifications(deps, sec('2026-10-08T00:01:30Z'), 'heartbeat')
    const [alert] = ntfyCalls(f.calls)
    expect(alert!.title).toBe('🔴 Heartbeat reported a failure')
    expect(alert!.message).toContain('exit code 2: pg_dump: connection refused')
    const ping = await db.first<{ kind: string; exit_code: number; body: string }>(
      `SELECT * FROM pings WHERE monitor_id = 'heartbeat' ORDER BY id DESC`,
    )
    expect(ping).toMatchObject({ kind: 'fail', exit_code: 2 })
  })

  it('start without finish → hung after maxRuntime', async () => {
    await setup()
    const deps = makeDeps(db)
    await tick(deps, at('2026-10-08T00:00:00Z'))
    await handlePing(deps, TEST_TOKENS['backup-db'], parseSignal('start')!, meta, sec('2026-10-08T03:00:00Z'))
    await tick(deps, at('2026-10-08T05:01:00Z'))
    const st = await db.first<{ status: string; down_reason: string }>(`SELECT * FROM monitor_state WHERE monitor_id = 'backup-db'`)
    expect(st).toMatchObject({ status: 'down', down_reason: 'hung' })
  })

  it('unknown token → 404; bad length → 404', async () => {
    await setup()
    const deps = makeDeps(db)
    await tick(deps, at('2026-10-08T00:00:00Z'))
    expect((await handlePing(deps, 'x'.repeat(24), parseSignal(undefined)!, meta, 1)).status).toBe(404)
    expect((await handlePing(deps, 'short', parseSignal(undefined)!, meta, 1)).status).toBe(404)
  })

  it('http monitor: retries, then down, then recovers', async () => {
    await setup()
    let healthy = true
    const f = fakeFetch((c) => {
      if (c.url.startsWith('https://site.test')) return healthy ? new Response('all ok') : new Response('boom', { status: 503 })
      return new Response('{}')
    })
    const deps = makeDeps(db, { fetch: f.fn })
    await tick(deps, at('2026-10-08T10:00:00Z'))
    expect((await states()).site).toBe('up')

    healthy = false
    await tick(deps, at('2026-10-08T10:01:00Z')) // 1st failure tolerated (retries: 1)
    expect((await states()).site).toBe('up')
    await tick(deps, at('2026-10-08T10:02:00Z'))
    expect((await states()).site).toBe('down')
    expect(ntfyCalls(f.calls).map((m) => m.title)).toContain('🔴 Site is down')
    expect(ntfyCalls(f.calls).find((m) => m.title === '🔴 Site is down')!.message).toBe('HTTP 503')

    healthy = true
    await tick(deps, at('2026-10-08T10:05:00Z'))
    expect((await states()).site).toBe('up')
    expect(ntfyCalls(f.calls).map((m) => m.title)).toContain('✅ Site recovered')
  })

  it('keyword mismatch and timeouts are failures', async () => {
    await setup()
    const f = fakeFetch((c) => {
      if (c.url.startsWith('https://site.test')) return new Response('maintenance page')
      return new Response('{}')
    })
    const deps = makeDeps(db, { fetch: f.fn })
    await tick(deps, at('2026-10-08T10:00:00Z'))
    await tick(deps, at('2026-10-08T10:01:00Z'))
    const st = await db.first<{ status: string; last_error: string }>(`SELECT * FROM monitor_state WHERE monitor_id = 'site'`)
    expect(st).toMatchObject({ status: 'down', last_error: 'keyword "ok" not found' })
    const results = await db.first<{ results_json: string }>(`SELECT results_json FROM tick_results ORDER BY tick_at DESC`)
    expect(JSON.parse(results!.results_json)[0]).toMatchObject({ id: 'site', ok: false, code: 200 })
  })

  it('concurrent tick and ping on the same monitor produce exactly one incident and one alert', async () => {
    await setup()
    const f = fakeFetch()
    const deps = makeDeps(db, { fetch: f.fn })
    await tick(deps, at('2026-10-08T00:00:00Z'))
    // heartbeat never pinged: deadline at 00:07. Race a failing ping with the tick that detects "missed".
    await Promise.all([
      tick(deps, at('2026-10-08T00:08:00Z')),
      handlePing(deps, TEST_TOKENS.heartbeat, parseSignal('fail')!, meta, sec('2026-10-08T00:08:00Z')),
    ])
    await Promise.all([
      dispatchNotifications(deps, sec('2026-10-08T00:08:01Z')),
      dispatchNotifications(deps, sec('2026-10-08T00:08:01Z')),
    ])
    expect((await db.all(`SELECT * FROM incidents WHERE monitor_id = 'heartbeat'`)).length).toBe(1)
    expect(ntfyCalls(f.calls).filter((m) => m.title.includes('Heartbeat'))).toHaveLength(1)
  })

  it('failed notifications are retried on later ticks, up to 3 attempts', async () => {
    await setup()
    let ntfyUp = false
    const f = fakeFetch((c) => {
      if (c.url === 'https://ntfy.sh/') return ntfyUp ? new Response('{}') : new Response('rate limited', { status: 429 })
      return new Response('ok')
    })
    const deps = makeDeps(db, { fetch: f.fn })
    await tick(deps, at('2026-10-08T00:00:00Z'))
    await tick(deps, at('2026-10-08T00:08:00Z')) // heartbeat missed → attempt 1 fails
    let n = await db.first<{ attempts: number; ok: number; error: string }>(`SELECT * FROM notifications`)
    expect(n).toMatchObject({ attempts: 1, ok: 0 })
    expect(n!.error).toContain('HTTP 429')
    expect(n!.error).not.toContain('tk_secret_ntfy')

    ntfyUp = true
    await tick(deps, at('2026-10-08T00:09:00Z')) // attempt 2 succeeds
    n = await db.first(`SELECT * FROM notifications`)
    expect(n).toMatchObject({ attempts: 2, ok: 1 })
    await tick(deps, at('2026-10-08T00:10:00Z'))
    expect(ntfyCalls(f.calls).filter((m) => m.title.includes('Heartbeat'))).toHaveLength(2) // 1 failed + 1 ok
  })

  it('removing a monitor from config pauses it and resolves its incident silently', async () => {
    await setup()
    const f = fakeFetch()
    let deps = makeDeps(db, { fetch: f.fn })
    await tick(deps, at('2026-10-08T00:00:00Z'))
    await tick(deps, at('2026-10-08T00:08:00Z')) // heartbeat down
    const cfg = testConfig()
    cfg.groups[0]!.monitors = cfg.groups[0]!.monitors.filter((m) => m.id !== 'heartbeat')
    deps = makeDeps(db, { config: cfg, fetch: f.fn })
    await tick(deps, at('2026-10-08T00:09:00Z'))
    expect((await states()).heartbeat).toBe('paused')
    const inc = await db.first<{ resolved_at: number | null }>(`SELECT resolved_at FROM incidents WHERE monitor_id = 'heartbeat'`)
    expect(inc?.resolved_at).not.toBeNull()
    expect(ntfyCalls(f.calls).filter((m) => m.title.includes('recovered'))).toHaveLength(0)
  })

  it('watchdog: silent while the primary is healthy, alerts when it is not', async () => {
    await setup()
    const f = fakeFetch((c) => (c.url.startsWith('https://site.test') ? new Response('down', { status: 500 }) : new Response('{}')))
    const cfg = testConfig({
      groups: [
        {
          name: 'Watch',
          monitors: [
            { id: 'peer', kind: 'push', name: 'Primary heartbeat', period: '1m', grace: '2m' },
            { id: 'site', kind: 'http', name: 'Site', url: 'https://site.test/health', critical: true },
            { id: 'heartbeat', kind: 'push', name: 'Not critical', period: '5m' },
          ],
        },
      ],
      peer: { heartbeatMonitor: 'peer', pingUrl: 'https://primary.test/ping/abc' },
    })
    const deps = makeDeps(db, { config: cfg, fetch: f.fn, env: { STATUSPING_ROLE: 'watchdog' } })

    await tick(deps, at('2026-10-08T00:00:00Z'))
    expect((await states()).heartbeat).toBe('paused') // not critical → not run by the watchdog
    expect(f.calls.some((c) => c.url === 'https://primary.test/ping/abc' && c.method === 'POST')).toBe(true)
    await handlePing(deps, TEST_TOKENS.peer, parseSignal(undefined)!, meta, sec('2026-10-08T00:00:30Z'))
    await tick(deps, at('2026-10-08T00:01:00Z'))
    expect((await states()).site).toBe('down')
    expect(ntfyCalls(f.calls)).toHaveLength(0) // primary healthy → watchdog stays quiet

    // Primary stops pinging: heartbeat missed at 00:03:30 → peer down → watchdog speaks up.
    await tick(deps, at('2026-10-08T00:04:00Z'))
    const titles = ntfyCalls(f.calls).map((m) => m.title)
    expect(titles).toContain('[watchdog] 🔴 Primary heartbeat missed a ping')
    expect(titles).toContain('[watchdog] 🔴 Site is down')
  })

  it('retention keeps recent pings and drops old tick results', async () => {
    await setup()
    const deps = makeDeps(db)
    await tick(deps, at('2026-10-01T00:00:00Z'))
    for (let i = 0; i < 120; i++) {
      await handlePing(deps, TEST_TOKENS.heartbeat, parseSignal(undefined)!, meta, sec('2026-08-01T00:00:00Z') + i * 60)
    }
    await tick(deps, at('2026-10-08T00:10:00Z'))
    await runRetention(deps, sec('2026-10-09T00:10:00Z'))
    const pings = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM pings WHERE monitor_id = 'heartbeat'`)
    expect(pings?.n).toBe(100) // all older than 30d → keep the newest 100
    const ticks = await db.all<{ tick_at: number }>(`SELECT tick_at FROM tick_results`)
    expect(ticks.map((t) => t.tick_at)).toEqual([sec('2026-10-08T00:10:00Z')])
  })
})
