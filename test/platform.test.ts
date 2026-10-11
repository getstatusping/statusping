import { afterEach, describe, expect, it } from 'vitest'
import { validateAdminConfig } from '../src/admin/security.ts'
import { EXPORT_TABLES } from '../src/export.ts'
import {
  PLATFORM_SIGNATURE_HEADER,
  type TenantPolicy,
  parseTenantPolicy,
  signPlatformRequest,
  verifyPlatformRequest,
} from '../src/platform.ts'
import { runRetention } from '../src/retention.ts'
import { tick } from '../src/tick.ts'
import { DAY, nowSeconds } from '../src/util/time.ts'
import { createApp } from '../src/web/app.ts'
import { type CountingDb, TEST_TOKENS, createTestDb, fakeFetch, makeDeps, testConfig } from './helpers.ts'

const SECRET = 'platform-secret-for-tests'

const policy = (overrides: Partial<TenantPolicy> = {}): TenantPolicy => ({
  tenantId: 'inkglance',
  plan: 'free',
  maxMonitors: 10,
  minIntervalMin: 5,
  maxPages: 1,
  historyDays: 30,
  suspended: false,
  suspendedMessage: null,
  ...overrides,
})

const tenantEnv = (p: TenantPolicy) => ({ STATUSPING_TENANT: JSON.stringify(p), STATUSPING_PLATFORM_SECRET: SECRET })

describe('tenant policy', () => {
  it('is absent on self-hosted instances and strict about its shape', () => {
    expect(parseTenantPolicy(undefined)).toBeUndefined()
    expect(parseTenantPolicy('')).toBeUndefined()
    expect(parseTenantPolicy(JSON.stringify(policy()))).toEqual(policy())
    expect(() => parseTenantPolicy('{')).toThrow(/valid JSON/)
    expect(() => parseTenantPolicy(JSON.stringify({ ...policy(), tenantId: 'Bad Name' }))).toThrow(/tenantId/)
    expect(() => parseTenantPolicy(JSON.stringify({ ...policy(), maxMonitors: 0 }))).toThrow(/maxMonitors/)
    expect(() => parseTenantPolicy(JSON.stringify({ ...policy(), suspended: 'yes' }))).toThrow(/suspended/)
  })
})

describe('signed platform requests', () => {
  it('verify only for the same method, path, tenant and a fresh timestamp', async () => {
    const now = 1_800_000_000
    const header = await signPlatformRequest(SECRET, 'POST', '/internal/tick', 'inkglance', now)
    expect(await verifyPlatformRequest(SECRET, header, 'POST', '/internal/tick', 'inkglance', now + 10)).toBe(true)
    expect(await verifyPlatformRequest(SECRET, header, 'GET', '/internal/tick', 'inkglance', now)).toBe(false)
    expect(await verifyPlatformRequest(SECRET, header, 'POST', '/internal/export', 'inkglance', now)).toBe(false)
    expect(await verifyPlatformRequest(SECRET, header, 'POST', '/internal/tick', 'other', now)).toBe(false)
    expect(await verifyPlatformRequest('wrong', header, 'POST', '/internal/tick', 'inkglance', now)).toBe(false)
    expect(await verifyPlatformRequest(SECRET, header, 'POST', '/internal/tick', 'inkglance', now + 301)).toBe(false)
    expect(await verifyPlatformRequest(SECRET, undefined, 'POST', '/internal/tick', 'inkglance', now)).toBe(false)
  })
})

describe('hosted tenant instance', () => {
  let db: CountingDb
  let close: () => Promise<void>
  afterEach(async () => close?.())

  const setup = async (p: TenantPolicy | null, configOverrides = {}) => {
    ;({ db, close } = await createTestDb('libsql'))
    const f = fakeFetch((c) => (c.url.startsWith('https://site.test') ? new Response('ok') : new Response('{}')))
    const deps = makeDeps(db, { fetch: f.fn, env: p ? tenantEnv(p) : {}, config: testConfig(configOverrides) })
    return { deps, app: createApp(deps), f }
  }

  const signed = async (method: string, path: string, tenantId = 'inkglance') => ({
    method,
    headers: { [PLATFORM_SIGNATURE_HEADER]: await signPlatformRequest(SECRET, method, path, tenantId, nowSeconds()) },
  })

  it('fits config-as-code into the plan instead of failing', async () => {
    const { deps } = await setup(policy({ maxMonitors: 2, minIntervalMin: 5 }))
    expect(deps.config.monitors.map((m) => m.id)).toEqual(['backup-db', 'heartbeat'])
    const { deps: wide } = await setup(policy({ maxMonitors: 3, minIntervalMin: 5 }))
    const site = wide.config.monitors.find((m) => m.id === 'site')
    expect(site?.kind === 'http' && site.intervalMin).toBe(5)
    expect(wide.config.pages[0]!.monitorIds).toContain('site')
  })

  it('rejects an admin save over the plan, but loads a stored one clamped', () => {
    const env = tenantEnv(policy({ maxMonitors: 2 }))
    const getEnv = (name: string) => (env as Record<string, string>)[name]
    const config = { ...testConfig({ sinks: {} }), admin: true }
    expect(() => validateAdminConfig(config, getEnv)).toThrow(/free plan allows 2 monitors/)
    expect(validateAdminConfig(config, getEnv, 'load').normalized.monitors).toHaveLength(2)
    const fast = { ...config, groups: [{ name: 'Web', monitors: [{ id: 'site', kind: 'http', name: 'Site', url: 'https://site.test/', interval: '1m' }] }] }
    expect(() => validateAdminConfig(fast, getEnv)).toThrow(/at most every 5 min/)
    // No interval given (the setup wizard, a quick admin add): the plan's fastest, not a rejection.
    const unset = { ...config, groups: [{ name: 'Web', monitors: [{ id: 'site', kind: 'http', name: 'Site', url: 'https://site.test/' }] }] }
    const saved = validateAdminConfig(unset, getEnv).normalized.monitors[0]!
    expect(saved.kind === 'http' && saved.intervalMin).toBe(5)
    // Self-hosted: no plan, no limits.
    expect(validateAdminConfig(config, () => undefined).normalized.monitors).toHaveLength(3)
  })

  it('a freshly provisioned tenant starts in the setup wizard, claimed with the platform token', async () => {
    ;({ db, close } = await createTestDb('libsql'))
    const starter = { title: 'inkglance', baseUrl: 'https://inkglance.statusp.ing', groups: [] }
    const deps = makeDeps(db, { config: starter, env: { ...tenantEnv(policy()), STATUSPING_SETUP_TOKEN: 'owner-setup-token-123' } })
    const app = createApp(deps)
    const res = await app.request('/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/setup')
    expect(await (await app.request('/setup')).text()).toContain('STATUSPING_SETUP_TOKEN')
    // The platform keeps ticking it (no checks yet) and can export it while setup is pending.
    const ticked = await app.request('/internal/tick', await signed('POST', '/internal/tick'))
    expect(ticked.status).toBe(200)
    expect((await app.request('/internal/export', await signed('GET', '/internal/export'))).status).toBe(200)
  })

  it('internal routes do not exist on self-hosted instances', async () => {
    const { app } = await setup(null)
    expect((await app.request('/internal/tick', await signed('POST', '/internal/tick'))).status).toBe(404)
    expect((await app.request('/internal/export', await signed('GET', '/internal/export'))).status).toBe(404)
  })

  it('ticks only on a valid platform signature for this tenant', async () => {
    // A 1-minute plan, so the HTTP check is due on whichever minute the test runs.
    const { app, f } = await setup(policy({ minIntervalMin: 1 }))
    expect((await app.request('/internal/tick', { method: 'POST' })).status).toBe(401)
    expect((await app.request('/internal/tick', await signed('POST', '/internal/tick', 'someone-else'))).status).toBe(401)
    const res = await app.request('/internal/tick', await signed('POST', '/internal/tick'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ duplicate: false, checks: 1 })
    expect(f.calls.some((c) => c.url.startsWith('https://site.test'))).toBe(true)
  })

  it('a suspended tenant shows a banner, runs no checks and refuses pings', async () => {
    const { deps, app, f } = await setup(policy({ suspended: true, suspendedMessage: 'Payment overdue.' }))
    const summary = await tick(deps)
    expect(summary).toMatchObject({ suspended: true, checks: 0 })
    expect(f.calls).toHaveLength(0)
    expect((await app.request(`/ping/${TEST_TOKENS.heartbeat}`)).status).toBe(503)
    const page = await (await app.request('/')).text()
    expect(page).toContain('class="site-notice"')
    expect(page).toContain('Payment overdue.')
  })

  it('exports tenant data without credentials or sign-in state', async () => {
    const { deps, app } = await setup(policy())
    await tick(deps)
    await app.request(`/ping/${TEST_TOKENS.heartbeat}`)
    await db.run(`INSERT INTO instance_secrets (name, value, created_at) VALUES ('env:SINK_X_TOKEN', 'do-not-export', 0)`)
    const res = await app.request('/internal/export', await signed('GET', '/internal/export'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { format: string; tenantId: string; tables: Record<string, unknown[]> }
    expect(body).toMatchObject({ format: 'statusping-export-v1', tenantId: 'inkglance' })
    expect(Object.keys(body.tables).sort()).toEqual([...EXPORT_TABLES].sort())
    expect(body.tables.pings).toHaveLength(1)
    expect(JSON.stringify(body)).not.toContain('do-not-export')
  })

  it('keeps no more history than the plan allows', async () => {
    const { deps } = await setup(policy({ historyDays: 30 }))
    const now = nowSeconds()
    await db.run(`INSERT INTO incidents (monitor_id, started_at, resolved_at, reason) VALUES ('site', ?, ?, 'check_failed')`, [now - 60 * DAY, now - 59 * DAY])
    await db.run(`INSERT INTO incidents (monitor_id, started_at, resolved_at, reason) VALUES ('site', ?, ?, 'check_failed')`, [now - 20 * DAY, now - 19 * DAY])
    await runRetention(deps, now)
    expect(await db.all(`SELECT id FROM incidents`)).toHaveLength(1)
  })
})
