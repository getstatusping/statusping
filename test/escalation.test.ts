import { afterEach, describe, expect, it } from 'vitest'
import { acknowledgeIncident, createAcknowledgeToken, verifyAcknowledgeToken } from '../src/acknowledgements.ts'
import { ConfigError, normalizeConfig } from '../src/config.ts'
import { dispatchNotifications } from '../src/notify/dispatch.ts'
import { handlePing, parseSignal } from '../src/ping.ts'
import { tick } from '../src/tick.ts'
import { createApp } from '../src/web/app.ts'
import { hashPassword } from '../src/auth/providers.ts'
import { type CountingDb, TEST_TOKENS, at, createTestDb, fakeFetch, makeDeps, sec, testConfig } from './helpers.ts'

describe('escalation', () => {
  let db: CountingDb
  let close: () => Promise<void>
  afterEach(async () => close?.())

  const config = () => {
    const value = testConfig()
    const group = value.groups[0]!
    group.monitors = group.monitors.map((monitor) => monitor.id === 'heartbeat'
      ? { ...monitor, escalation: [{ after: '0s', notify: ['ntfy'] }, { after: '10m', notify: ['ntfy'] }] }
      : monitor)
    return value
  }

  it('validates an immediate strictly ordered, non-duplicated policy', () => {
    // ACK_SECRET is optional: without it the links are signed with a key the site stores.
    expect(() => makeDeps({} as never, { config: config() })).not.toThrow()
    const valid = config()
    valid.groups[0]!.monitors = valid.groups[0]!.monitors.map((monitor) => monitor.id === 'heartbeat'
      ? { ...monitor, renotifyEvery: undefined, escalation: [{ after: '1m', notify: ['ntfy', 'ntfy'] }, { after: '1m', notify: ['ntfy'] }] }
      : monitor)
    expect(() => normalizeConfig(valid)).toThrow(ConfigError)
    try { normalizeConfig(valid) } catch (error) {
      expect((error as ConfigError).problems).toEqual(expect.arrayContaining([
        'monitor "heartbeat": escalation[0].after must be 0s',
        'monitor "heartbeat": escalation[0].notify must not contain duplicates',
        'monitor "heartbeat": escalation[1].after must be strictly greater than the previous step',
      ]))
    }
  })

  it('sends each due escalation once, stops after acknowledgement, and recovers to escalation sinks', async () => {
    ;({ db, close } = await createTestDb('libsql'))
    const f = fakeFetch()
    const cfg = config()
    cfg.groups[0]!.monitors = cfg.groups[0]!.monitors.map((monitor) => monitor.id === 'heartbeat'
      ? { ...monitor, renotifyEvery: undefined }
      : monitor)
    const deps = makeDeps(db, { config: cfg, fetch: f.fn, env: { ACK_SECRET: 'ack_test_secret_0123456789' } })
    const start = sec('2026-10-08T00:00:00Z')
    await tick(deps, at('2026-10-08T00:00:00Z'))
    await handlePing(deps, TEST_TOKENS.heartbeat, parseSignal('1')!, { body: null, ip: null, userAgent: null }, start)
    await dispatchNotifications(deps, start, 'heartbeat')
    await dispatchNotifications(deps, start, 'heartbeat')
    let sent = await db.all<{ event: string; sink: string; ok: number }>(`SELECT event, sink, ok FROM notifications ORDER BY id`)
    expect(sent).toEqual([{ event: 'escalate:0', sink: 'ntfy', ok: 1 }])
    const initialCall = f.calls.find((call) => call.url === 'https://ntfy.sh/')!
    const initial = JSON.parse(initialCall.body!) as { actions: { label: string; url: string }[] }
    expect(initial.actions[0]?.label).toBe('Acknowledge')
    expect(initial.actions[0]?.url).toMatch(/^https:\/\/status\.test\/ack\//)

    await dispatchNotifications(deps, start + 600, 'heartbeat')
    sent = await db.all(`SELECT event, sink, ok FROM notifications ORDER BY id`)
    expect(sent).toEqual([
      { event: 'escalate:0', sink: 'ntfy', ok: 1 },
      { event: 'escalate:1', sink: 'ntfy', ok: 1 },
    ])
    const incident = await db.first<{ id: number }>(`SELECT id FROM incidents WHERE monitor_id = 'heartbeat' AND resolved_at IS NULL`)
    expect(await acknowledgeIncident(db, incident!.id, 'alert-link', 'alert-link', start + 601)).toBe(true)
    expect(await acknowledgeIncident(db, incident!.id, 'alert-link', 'alert-link', start + 602)).toBe(false)
    await dispatchNotifications(deps, start + 3600, 'heartbeat')
    expect(await db.all(`SELECT event FROM notifications WHERE event LIKE 'escalate:%'`)).toHaveLength(2)

    await handlePing(deps, TEST_TOKENS.heartbeat, parseSignal(undefined)!, { body: null, ip: null, userAgent: null }, start + 3601)
    await dispatchNotifications(deps, start + 3601, 'heartbeat')
    expect(await db.all<{ event: string }>(`SELECT event FROM notifications ORDER BY id`)).toEqual([
      { event: 'escalate:0' }, { event: 'escalate:1' }, { event: 'up' },
    ])
  })

  it('signs expiring capabilities and the acknowledgement row is single-use', async () => {
    ;({ db, close } = await createTestDb('libsql'))
    const secret = 'ack_test_secret_0123456789'
    const token = await createAcknowledgeToken(42, 100, secret)
    expect(await verifyAcknowledgeToken(token, 100, secret)).toBe(42)
    expect(await verifyAcknowledgeToken(`${token}x`, 100, secret)).toBeNull()
    expect(await verifyAcknowledgeToken(token, 100 + 24 * 60 * 60 + 1, secret)).toBeNull()
  })

  it('uses a non-mutating GET confirmation and a single-use POST capability', async () => {
    ;({ db, close } = await createTestDb('libsql'))
    const cfg = config()
    cfg.groups[0]!.monitors = cfg.groups[0]!.monitors.map((monitor) => monitor.id === 'heartbeat' ? { ...monitor, renotifyEvery: undefined } : monitor)
    const deps = makeDeps(db, { config: cfg, env: { ACK_SECRET: 'ack_test_secret_0123456789' } })
    const now = Math.floor(Date.now() / 1000)
    await tick(deps, now * 1000)
    await handlePing(deps, TEST_TOKENS.heartbeat, parseSignal('1')!, { body: null, ip: null, userAgent: null }, now)
    const incident = await db.first<{ id: number }>(`SELECT id FROM incidents WHERE monitor_id = 'heartbeat' AND resolved_at IS NULL`)
    const token = await createAcknowledgeToken(incident!.id, now, 'ack_test_secret_0123456789')
    const app = createApp(deps)
    const confirmation = await app.request(`/ack/${token}`)
    expect(confirmation.status).toBe(200)
    expect(await db.all(`SELECT * FROM acknowledgements`)).toEqual([])
    const post = await app.request('/ack', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() })
    expect(post.status).toBe(200)
    expect(await db.all<{ incident_id: number; by: string; via: string }>(`SELECT incident_id, by, via FROM acknowledgements`)).toEqual([{ incident_id: incident!.id, by: 'alert-link', via: 'alert-link' }])
    expect((await app.request('/ack', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() })).status).toBe(200)
    expect(await db.all(`SELECT * FROM acknowledgements`)).toHaveLength(1)
  })

  it('shows and accepts the monitor-page acknowledgement only for configured admins', async () => {
    ;({ db, close } = await createTestDb('libsql'))
    const cfg = config()
    cfg.groups[0]!.monitors = cfg.groups[0]!.monitors.map((monitor) => monitor.id === 'heartbeat' ? { ...monitor, renotifyEvery: undefined } : monitor)
    cfg.access = { provider: { type: 'basic' }, admins: { emails: ['ops@example.com'] } }
    const password = await hashPassword('test-password', 'test-salt')
    const deps = makeDeps(db, { config: cfg, env: { ACK_SECRET: 'ack_test_secret_0123456789', BASIC_AUTH_USERS: JSON.stringify({ 'ops@example.com': password }) } })
    const now = Math.floor(Date.now() / 1000)
    await tick(deps, now * 1000)
    await handlePing(deps, TEST_TOKENS.heartbeat, parseSignal('1')!, { body: null, ip: null, userAgent: null }, now)
    const incident = await db.first<{ id: number }>(`SELECT id FROM incidents WHERE monitor_id = 'heartbeat' AND resolved_at IS NULL`)
    const app = createApp(deps)
    const auth = `Basic ${btoa('ops@example.com:test-password')}`
    expect(await (await app.request('/pages/status/m/heartbeat', { headers: { authorization: auth } })).text()).toContain('Acknowledge incident')
    expect((await app.request('/pages/status/m/heartbeat/ack', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `incidentId=${incident!.id}` })).status).toBe(403)
    expect((await app.request('/pages/status/m/heartbeat/ack', { method: 'POST', headers: { authorization: auth, origin: 'https://evil.test', 'content-type': 'application/x-www-form-urlencoded' }, body: `incidentId=${incident!.id}` })).status).toBe(403)
    expect(await db.all(`SELECT * FROM acknowledgements`)).toEqual([])
    // A missing Origin (and Referer) is not taken as same-origin.
    expect((await app.request('/pages/status/m/heartbeat/ack', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' }, body: `incidentId=${incident!.id}` })).status).toBe(403)
    const acknowledged = await app.request('/pages/status/m/heartbeat/ack', { method: 'POST', headers: { authorization: auth, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' }, body: `incidentId=${incident!.id}` })
    expect(acknowledged.status).toBe(303)
    expect(await db.first<{ by: string; via: string }>(`SELECT by, via FROM acknowledgements WHERE incident_id = ?`, [incident!.id])).toEqual({ by: 'ops@example.com', via: 'admin-page' })
  })
})
