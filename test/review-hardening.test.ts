import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { ConfigError, normalizeConfig, type StatusPingConfig } from '../src/config.ts'
import { assertJson, MAX_PRINTED_JSON } from '../src/evaluate/json.ts'
import { dispatchNotifications } from '../src/notify/dispatch.ts'
import { createSink, escapeChatText, escapeMattermost, type AlertMessage } from '../src/notify/sinks.ts'
import { buildMessage as buildSmtpMessage } from '../src/notify/smtp.ts'
import { handlePing, MAX_PING_BODY, parseSignal } from '../src/ping.ts'
import { truncate } from '../src/state.ts'
import { tick } from '../src/tick.ts'
import { formatMailbox } from '../src/util/email.ts'
import { clipText, MAX_CHECK_ERROR } from '../src/util/text.ts'
import { loadMonitorDetail } from '../src/web/data.ts'
import { BODY_LIMITS } from '../src/web/body-limit.ts'
import { createApp, PER_MONITOR_PING_LIMIT } from '../src/web/app.ts'
import type { Db } from '../src/db/types.ts'
import { DB_KINDS, type DbKind, TEST_TOKENS, at, createTestDb, fakeFetch, makeDeps, sec, testConfig } from './helpers.ts'

vi.mock('cloudflare:email', () => ({ EmailMessage: class EmailMessage {} }))

const hasLoneSurrogate = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined })

async function testDb(kind: DbKind = 'libsql') {
  const t = await createTestDb(kind)
  close = t.close
  return t.db
}

function pinClock(iso = '2026-10-11T00:00:05Z') {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(iso))
  onTestFinished(() => { vi.useRealTimers() })
}

describe('B1: bounded check errors', () => {
  it('clipText cuts on a code-point boundary and never leaves a lone surrogate', () => {
    const emoji = '😀'.repeat(400) // 800 UTF-16 units
    for (let max = 1; max < 30; max++) {
      for (const ellipsis of ['…', '']) {
        const out = clipText(`a${emoji}`, max, ellipsis)
        expect(out.length).toBeLessThanOrEqual(max)
        expect(hasLoneSurrogate(out), `max ${max}`).toBe(false)
      }
    }
    expect(clipText('short', 10)).toBe('short')
    expect(truncate(`x${emoji}`, 4)).toBe('x😀…')
    expect(hasLoneSurrogate(truncate(emoji, 500)!)).toBe(false)
  })

  it('assertJson quotes at most a short excerpt of the value and of the expectation', () => {
    const huge = { data: 'x'.repeat(1_000_000) }
    const failure = assertJson(huge, [{ path: '$.data', equals: 'y'.repeat(10_000) }])!
    expect(failure.length).toBeLessThan(2 * MAX_PRINTED_JSON + 100)
    expect(assertJson({ data: '😀'.repeat(1000) }, [{ path: '$.data', equals: 1 }])).toSatisfy((s: string) => !hasLoneSurrogate(s))
    expect(assertJson({ n: 5 }, [{ path: '$.n', lessThan: 3 }])).toBe('$.n is 5, expected less than 3')
  })

  it('a huge JSON value gives a short last_error and a short tick_results row', async () => {
    const db = await testDb()
    const big = JSON.stringify({ data: 'x'.repeat(900_000) })
    const config = testConfig({ groups: [{ name: 'API', monitors: [{ id: 'api', kind: 'http', name: 'API', url: 'https://api.test', json: [{ path: '$.data', equals: 'ok' }] }] }] })
    const deps = makeDeps(db, { config, fetch: fakeFetch(() => new Response(big, { headers: { 'content-type': 'application/json' } })).fn })
    await tick(deps, at('2026-10-08T00:00:00Z'))
    const state = await db.first<{ status: string; last_error: string }>(`SELECT status, last_error FROM monitor_state WHERE monitor_id = 'api'`)
    expect(state!.status).toBe('down')
    expect(state!.last_error.length).toBeLessThanOrEqual(MAX_CHECK_ERROR)
    const row = await db.first<{ n: number }>(`SELECT length(results_json) AS n FROM tick_results`)
    expect(row!.n).toBeLessThan(2 * MAX_CHECK_ERROR)
    const incident = await db.first<{ detail: string }>(`SELECT detail FROM incidents WHERE monitor_id = 'api'`)
    expect(incident!.detail.length).toBeLessThanOrEqual(MAX_CHECK_ERROR)
  })

  it.each(DB_KINDS)('a monitor page loads only its own, bounded results, even from rows an older release stored (%s)', async (kind) => {
    const db = await testDb(kind)
    const deps = makeDeps(db)
    await tick(deps, at('2026-10-08T00:00:00Z'))
    const huge = 'e'.repeat(2_000_000)
    for (let i = 1; i <= 5; i++) {
      // Legacy rows: an unbounded error for this monitor, and many other monitors' results.
      const results = [{ id: 'site', ok: false, ms: 12, code: 500, err: huge }, ...Array.from({ length: 50 }, (_, n) => ({ id: `other-${n}`, ok: true, ms: 1, code: 200, err: null }))]
      await db.run(`INSERT INTO tick_results (tick_at, results_json) VALUES (?, ?)`, [sec('2026-10-08T00:00:00Z') + i * 60, JSON.stringify(results)])
    }
    const detail = await loadMonitorDetail(deps, 'site', sec('2026-10-08T00:10:00Z'))
    expect(detail!.checks.length).toBeGreaterThanOrEqual(5)
    expect(detail!.checks.every((c) => c.id === 'site')).toBe(true)
    const legacy = detail!.checks.filter((c) => c.code === 500)
    expect(legacy).toHaveLength(5)
    for (const c of legacy) {
      expect(c.ok).toBe(false)
      expect(c.ms).toBe(12)
      expect(c.err!.length).toBeLessThanOrEqual(MAX_CHECK_ERROR)
    }
    expect(JSON.stringify(detail!.checks).length).toBeLessThan(10 * (MAX_CHECK_ERROR + 200))
  })

  it('stores a ping body cut on a code-point boundary', async () => {
    const db = await testDb()
    const deps = makeDeps(db)
    await tick(deps, at('2026-10-08T00:00:00Z'))
    const body = `a${'😀'.repeat(MAX_PING_BODY)}`
    await handlePing(deps, TEST_TOKENS.heartbeat, parseSignal('fail')!, { body, ip: null, userAgent: null }, sec('2026-10-08T00:00:30Z'))
    const ping = await db.first<{ body: string }>(`SELECT body FROM pings`)
    expect(ping!.body.length).toBeLessThanOrEqual(MAX_PING_BODY)
    expect(hasLoneSurrogate(ping!.body)).toBe(false)
    const incident = await db.first<{ detail: string }>(`SELECT detail FROM incidents`)
    expect(hasLoneSurrogate(incident!.detail)).toBe(false)
  })
})

describe('B2: escalation without ACK_SECRET, and tick phase isolation', () => {
  const escalating = () => {
    const value = testConfig()
    value.groups[0]!.monitors = value.groups[0]!.monitors.map((m) => m.id === 'heartbeat' ? { ...m, escalation: [{ after: '0s', notify: ['ntfy'] }] } : m)
    return value
  }

  it('accepts escalation without ACK_SECRET and signs working links with a stored key', async () => {
    pinClock('2026-10-08T00:00:10Z')
    const db = await testDb()
    const f = fakeFetch()
    const deps = makeDeps(db, { config: escalating(), fetch: f.fn })
    const start = sec('2026-10-08T00:00:00Z')
    await tick(deps, at('2026-10-08T00:00:00Z'))
    await handlePing(deps, TEST_TOKENS.heartbeat, parseSignal('1')!, { body: null, ip: null, userAgent: null }, start)
    expect(await dispatchNotifications(deps, start, 'heartbeat')).toBe(1)
    const sent = await db.first<{ ok: number; error: string | null }>(`SELECT ok, error FROM notifications`)
    expect(sent).toEqual({ ok: 1, error: null })
    const key = await db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = 'ack_key'`)
    expect(key!.value.length).toBeGreaterThanOrEqual(32)

    const payload = JSON.parse(f.calls.find((c) => c.url === 'https://ntfy.sh/')!.body!) as { actions: { url: string }[] }
    const link = new URL(payload.actions[0]!.url)
    const app = createApp(deps)
    expect((await app.request(`https://status.test${link.pathname}`)).status).toBe(200)
    const token = decodeURIComponent(link.pathname.slice('/ack/'.length))
    const ack = await app.request('https://status.test/ack', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() })
    expect(ack.status).toBe(200)
    expect(await db.first(`SELECT incident_id FROM acknowledgements`)).toBeTruthy()
  })

  it('an /ack link is not found while no key was ever created', async () => {
    const db = await testDb()
    const app = createApp(makeDeps(db))
    expect((await app.request('https://status.test/ack/abc.def')).status).toBe(404)
    expect(await db.first(`SELECT value FROM instance_secrets WHERE name = 'ack_key'`)).toBeNull()
  })

  it('records a failure to sign the link on the notification instead of aborting the tick', async () => {
    const real = await testDb()
    // A database whose instance_secrets reads fail: signing the acknowledgement link throws.
    const db: Db = {
      all: (sql, params) => real.all(sql, params),
      first: (sql, params) => (sql.includes('instance_secrets') && params?.[0] === 'ack_key' ? Promise.reject(new Error('secrets unavailable')) : real.first(sql, params)),
      run: (sql, params) => real.run(sql, params),
      batch: (statements) => real.batch(statements),
    }
    const deps = makeDeps(db, { config: escalating() })
    await tick(deps, at('2026-10-08T00:10:00Z'))
    await handlePing(deps, TEST_TOKENS.heartbeat, parseSignal('1')!, { body: null, ip: null, userAgent: null }, sec('2026-10-08T00:10:30Z'))
    await real.run(`DELETE FROM meta WHERE key = 'retention_day'`)
    const summary = await tick(deps, at('2026-10-08T00:11:00Z'))
    expect(summary.notifications).toBe(0)
    const row = await real.first<{ ok: number; attempts: number; error: string }>(`SELECT ok, attempts, error FROM notifications`)
    expect(row).toEqual({ ok: 0, attempts: 1, error: 'secrets unavailable' })
    // The phases after notifications still ran.
    expect(await real.first(`SELECT value FROM meta WHERE key = 'retention_day'`)).toBeTruthy()
  })

  it('a phase that throws is logged and the later phases still run', async () => {
    const real = await testDb()
    const db: Db = {
      all: (sql, params) => (sql.includes('FROM incidents i JOIN monitors m') ? Promise.reject(new Error('boom')) : real.all(sql, params)),
      first: (sql, params) => real.first(sql, params),
      run: (sql, params) => real.run(sql, params),
      batch: (statements) => real.batch(statements),
    }
    const deps = makeDeps(db)
    const logs: string[] = []
    deps.log = (level, message) => { if (level === 'error') logs.push(message) }
    const summary = await tick(deps, at('2026-10-08T00:10:00Z'))
    expect(summary.duplicate).toBe(false)
    expect(logs).toContain('tick: notifications failed')
    expect(await real.first(`SELECT value FROM meta WHERE key = 'retention_day'`)).toBeTruthy()
  })
})

describe('B3: chat formatting from incident details', () => {
  const hostile: AlertMessage = {
    kind: 'down', title: '🔴 Job reported a failure', priority: 'high', url: 'https://status.test/m/job',
    body: 'exit code 1: <!channel> <https://evil.test|click> & @here @all [x](https://evil.test) **bold** # head',
  }

  it('escapes &, < and > for Slack and Google Chat', async () => {
    const f = fakeFetch()
    await createSink('s', { type: 'slack', webhookUrl: 'https://hooks.slack.com/services/x' }, () => undefined).send(hostile, f.fn)
    const slack = JSON.parse(f.calls[0]!.body!) as { blocks: { type: string; text?: { text: string } }[] }
    const section = slack.blocks.find((b) => b.type === 'section')!.text!.text
    expect(section).not.toMatch(/[<>]/)
    expect(section).toContain('&lt;!channel&gt;')
    expect(section).toContain('&amp; @here')

    await createSink('g', { type: 'googlechat', webhookUrl: 'https://chat.googleapis.com/v1/spaces/X/messages' }, () => undefined).send(hostile, f.fn)
    const chat = (JSON.parse(f.calls[1]!.body!) as { text: string }).text
    expect(chat).toContain('&lt;https://evil.test|click&gt;')
    // Only our own link remains a <url|text> link.
    expect(chat.match(/</g)).toHaveLength(1)
    expect(escapeChatText('a<b>&c')).toBe('a&lt;b&gt;&amp;c')
  })

  it('neutralises Mattermost Markdown and mentions', async () => {
    const f = fakeFetch()
    await createSink('m', { type: 'mattermost', webhookUrl: 'https://mm.test/hooks/x' }, () => undefined).send(hostile, f.fn)
    const text = (JSON.parse(f.calls[0]!.body!) as { text: string }).text
    const body = text.split('\n')[1]!
    expect(body).not.toMatch(/@(here|all|channel)/)
    expect(body).toContain('@​here')
    expect(body).toContain('\\[x\\]\\(https://evil.test\\)')
    expect(body).toContain('\\*\\*bold\\*\\*')
    expect(body).toContain('\\<\\!channel\\>')
    expect(escapeMattermost('@channel')).toBe('@​channel')
    // Our own link line stays a working link.
    expect(text.split('\n')[2]).toBe('[Open status page](https://status.test/m/job)')
  })
})

describe('hardening: request body caps before sign-in', () => {
  const ORIGIN = 'http://localhost'
  const big = () => 'x'.repeat(BODY_LIMITS.public + 1024)

  it('gives anonymous requests the public cap on configuration routes, and signed requests the config cap', async () => {
    const db = await testDb()
    const app = createApp(makeDeps(db, { env: { ADMIN_TOKEN: 'admin-token-0123456789' } }))
    const put = (headers: Record<string, string>) => app.request(`${ORIGIN}/api/admin/config`, { method: 'PUT', headers: { 'content-type': 'application/yaml', ...headers }, body: big() })
    expect((await put({})).status).toBe(413)
    expect((await put({ cookie: 'other=1' })).status).toBe(413)
    expect((await put({ authorization: 'Bearer admin-token-0123456789' })).status).not.toBe(413)
    expect((await put({ cookie: 'sp_session=abc' })).status).not.toBe(413)
    expect((await put({ cookie: 'CF_Authorization=abc' })).status).not.toBe(413)
    const setupApi = await app.request(`${ORIGIN}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big() })
    expect(setupApi.status).toBe(413)
  })

  it('lets /api/setup take a configuration-sized body while setup is pending', async () => {
    const db = await testDb()
    const deps = makeDeps(db, { env: { STATUSPING_RESET_TOKEN: 'reset-token-0123456789abcdef' } })
    const app = createApp(deps)
    const reset = await app.request(`${ORIGIN}/setup/reset`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'reset-token-0123456789abcdef', confirm: 'reset' }).toString(),
    })
    expect(reset.status).toBe(303)
    const res = await app.request(`${ORIGIN}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'WRNG-WRNG-WRNG', yaml: big() }) })
    expect(res.status).not.toBe(413)
  })
})

describe('hardening: pings are not starved by anonymous floods', () => {
  it('counts a known push token against its own monitor bucket once the shared bucket is used up', async () => {
    pinClock()
    const db = await testDb()
    const deps = makeDeps(db)
    const app = createApp(deps)
    await tick(deps, Date.now())
    const now = sec('2026-10-11T00:00:05Z')
    await db.run(`INSERT INTO ping_rate_limits (ip, window_at, count) VALUES ('ping:unknown', ?, 100000)`, [now - (now % 60)])
    expect((await app.request('http://localhost/ping/bogus-token-0123456789')).status).toBe(429)
    expect((await app.request(`http://localhost/ping/${TEST_TOKENS.heartbeat}`)).status).toBe(200)
    for (let i = 1; i < PER_MONITOR_PING_LIMIT; i++) await app.request(`http://localhost/ping/${TEST_TOKENS.heartbeat}/log`)
    // The per-monitor allowance is bounded too, and is separate for each monitor.
    expect((await app.request(`http://localhost/ping/${TEST_TOKENS.heartbeat}`)).status).toBe(429)
    expect((await app.request(`http://localhost/ping/${TEST_TOKENS['backup-db']}`)).status).toBe(200)
  })
})

describe('hardening: numeric settings and list validation', () => {
  const problems = (config: StatusPingConfig, save = false) => {
    try {
      normalizeConfig(config, { save })
      return []
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e
      return e.problems
    }
  }

  it('refuses out-of-range tick limits and session lengths', () => {
    expect(problems(testConfig({ limits: { maxChecksPerTick: 0 } }))).toContain('limits.maxChecksPerTick must be a whole number from 1 to 1000')
    expect(problems(testConfig({ limits: { maxChecksPerTick: 2.5 } }))).toContain('limits.maxChecksPerTick must be a whole number from 1 to 1000')
    expect(problems(testConfig({ limits: { tickBudgetMs: -1 } }))).toContain('limits.tickBudgetMs must be a whole number from 1000 to 300000')
    expect(problems(testConfig({ limits: { tickBudgetMs: 'fast' as never } }))).toContain('limits.tickBudgetMs must be a whole number from 1000 to 300000')
    expect(problems(testConfig({ limits: { maxChecksPerTick: 50, tickBudgetMs: 25_000 } }))).toEqual([])
    const access = (sessionHours: unknown) => testConfig({ access: { provider: { type: 'basic' }, sessionHours: sessionHours as number } })
    expect(problems(access(0))).toContain('access.sessionHours must be a number of hours from 1 to 720')
    expect(problems(access(10_000))).toContain('access.sessionHours must be a number of hours from 1 to 720')
    expect(problems(access('12'))).toContain('access.sessionHours must be a number of hours from 1 to 720')
    expect(problems(access(24))).toEqual([])
  })

  it('reports non-string entries in notify, emails and teams lists instead of throwing', () => {
    const notify = testConfig()
    notify.groups[0]!.monitors[0] = { ...notify.groups[0]!.monitors[0]!, notify: [42 as never] }
    expect(problems(notify)).toContain('monitor "backup-db".notify: every entry must be a string')

    const defaults = testConfig({ defaults: { notify: 'ntfy' as never } })
    expect(problems(defaults)).toContain('defaults.notify: must be a list of strings')

    const escalation = testConfig()
    escalation.groups[0]!.monitors[1] = { ...escalation.groups[0]!.monitors[1]!, escalation: [{ after: '0s', notify: [{}] as never }] }
    expect(problems(escalation)).toContain('monitor "heartbeat": escalation[0].notify: every entry must be a string')

    const emails = testConfig({ access: { provider: { type: 'basic' }, admins: { emails: [1 as never] } } })
    expect(problems(emails)).toContain('access.admins.emails: every entry must be a string')

    const teams = testConfig({ access: { provider: { type: 'basic' }, teams: { ops: { emails: 'ops@example.test' as never } }, admins: { teams: [null as never] } } })
    expect(problems(teams)).toEqual(expect.arrayContaining(['access.teams.ops.emails: must be a list of strings', 'access.admins.teams: every entry must be a string']))

    const page = testConfig({ access: { provider: { type: 'basic' } }, pages: [{ slug: 'ops', title: 'Ops', monitors: ['*'], access: { teams: [7 as never] } }] })
    expect(problems(page)).toContain('page "ops": access.teams: every entry must be a string')

    const proto = testConfig()
    proto.groups[0]!.monitors[0] = { ...proto.groups[0]!.monitors[0]!, notify: ['toString'] }
    expect(problems(proto)).toContain('monitor "backup-db": notify references unknown sink "toString"')
  })
})

describe('hardening: display names with specials in From', () => {
  it('quotes a display name holding , or : for Resend and in the SMTP From header', async () => {
    expect(formatMailbox('Ops, Inc <alerts@example.test>')).toBe('"Ops, Inc" <alerts@example.test>')
    expect(formatMailbox('Status: prod <alerts@example.test>')).toBe('"Status: prod" <alerts@example.test>')
    expect(formatMailbox('"Ops, Inc" <alerts@example.test>')).toBe('"Ops, Inc" <alerts@example.test>')
    expect(formatMailbox('Say "hi", ok <a@example.test>')).toBe('"Say \\"hi\\", ok" <a@example.test>')
    expect(formatMailbox('StatusPing <alerts@example.test>')).toBe('StatusPing <alerts@example.test>')
    expect(formatMailbox('alerts@example.test')).toBe('alerts@example.test')

    const f = fakeFetch()
    await createSink('mail', { type: 'email', to: ['ops@example.test'], via: { provider: 'resend', apiKey: 're_key_0123456789', from: 'Ops, Inc <alerts@example.test>' } }, () => undefined)
      .send({ kind: 'test', title: 'Test', body: 'b', url: 'https://status.test', priority: 'normal' }, f.fn)
    expect(JSON.parse(f.calls[0]!.body!).from).toBe('"Ops, Inc" <alerts@example.test>')

    const message = buildSmtpMessage({ from: 'Ops, Inc: alerts <alerts@example.test>', to: ['ops@example.test'], subject: 's', text: 't', html: 'h' })
    expect(message).toContain('From: "Ops, Inc: alerts" <alerts@example.test>\r\n')
    expect(buildSmtpMessage({ from: 'Statüs, Ops <alerts@example.test>', to: ['ops@example.test'], subject: 's', text: 't', html: 'h' })).toMatch(/From: =\?UTF-8\?B\?[^?]+\?= <alerts@example\.test>/)
    expect(buildSmtpMessage({ from: 'StatusPing <alerts@example.test>', to: ['ops@example.test'], subject: 's', text: 't', html: 'h' })).toContain('From: StatusPing <alerts@example.test>')
  })
})
