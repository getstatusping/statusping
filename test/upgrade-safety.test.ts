import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateAdminConfig } from '../src/admin/security.ts'
import { hashPassword } from '../src/auth/providers.ts'
import { sign } from '../src/auth/session.ts'
import { ConfigError, normalizeConfig } from '../src/config.ts'
import { createDeps, refreshAdminConfig } from '../src/deps.ts'
import { tick } from '../src/tick.ts'
import { createApp } from '../src/web/app.ts'
import { createTestDb, fakeFetch, testConfig } from './helpers.ts'

/**
 * Upgrade safety (eighth review, B1). A configuration an earlier release stored must keep loading:
 * rules added since are enforced when saving and relaxed (dropped, clamped, logged) when loading.
 * A configuration that still cannot load must never take the site down with it.
 */

const FIXTURES = join(import.meta.dirname, 'fixtures', 'stored-configs')
const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort()
  .map((file) => ({ file, ...(JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as { note: string; config: Record<string, unknown> }) }))

/** Environment-backed values resolve to placeholders, as a deployed site's secrets would. */
const getEnv = (name: string) => (/^(SINK_|OIDC_|RESEND_|HOOK_|API_)/.test(name) ? `https://env.example.test/${name}` : undefined)

const OWNER = 'owner@example.test'
const PASSWORD = 'owner-password-123'

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined })

/**
 * A deployed site (configured only through its database) whose saved versions are `revisions`,
 * oldest first; the newest is also the stored configuration. Each entry is stored verbatim.
 */
async function storedSite(revisions: Array<Record<string, unknown> | string>, env: Record<string, string> = {}) {
  const t = await createTestDb('libsql')
  close = t.close
  const now = 1_760_000_000
  const json = revisions.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)))
  await t.db.batch([
    { sql: `INSERT INTO setup_state (id, status, code, session_key, draft_json, failed_attempts, previous_config_json, updated_at) VALUES (1, 'complete', NULL, NULL, '{}', 0, NULL, ?)`, params: [now] },
    { sql: `INSERT INTO admin_config (id, config_json, updated_at, updated_by) VALUES (1, ?, ?, 'old-release')`, params: [json.at(-1)!, now] },
    ...json.map((config, i) => ({ sql: `INSERT INTO config_revisions (id, config_json, yaml, actor, action, at) VALUES (?, ?, NULL, 'old-release', 'config.save', ?)`, params: [i + 1, config, now + i] })),
  ])
  const users = JSON.stringify({ [OWNER]: await hashPassword(PASSWORD) })
  const logs: Array<{ level: string; message: string }> = []
  const allEnv: Record<string, string> = { BASIC_AUTH_USERS: users, SESSION_SECRET: 'session-secret-0123456789abcdefghijklmnop', ...env }
  const deps = createDeps({ db: t.db, getEnv: (n) => allEnv[n] ?? getEnv(n), fetch: fakeFetch().fn, log: (level, message) => void logs.push({ level, message }) })
  const app = createApp(deps)
  const session = await sign({ exp: Math.floor(Date.now() / 1000) + 3600, email: OWNER, groups: [], provider: 'basic' }, allEnv.SESSION_SECRET!)
  const asOwner = { cookie: `sp_session=${session}` }
  return { db: t.db, deps, app, logs, asOwner }
}

const site = (overrides: Record<string, unknown> = {}) => ({
  title: 'Old Site', baseUrl: 'https://status.example.test', timezone: 'UTC', admin: true,
  access: { provider: { type: 'basic' }, admins: { emails: [OWNER] } },
  groups: [{ name: 'Web', monitors: [{ id: 'site', kind: 'http', name: 'Site', url: 'https://www.example.test/' }, { id: 'job', kind: 'push', name: 'Job', period: '1h' }] }],
  ...overrides,
})

/** Refused when loaded, and on purpose: a webhook header that would send a server secret away. */
const unsafe = (title: string) => site({ title, sinks: { hook: { type: 'webhook', url: 'https://hooks.example.test/', headers: { 'X-Key': { $env: 'ADMIN_TOKEN' } } } } })

describe('stored configurations from earlier releases still load', () => {
  it('has a fixture for each rule a release added since 0.3.6', () => {
    expect(fixtures.map((f) => f.file)).toEqual(expect.arrayContaining([
      'dangling-default-notify.json', 'tick-limits-out-of-range.json', 'loose-email-addresses.json', 'prototype-sink-name.json',
      'loose-list-shapes.json', 'frequent-maintenance.json', 'ntfy-plain-http.json', 'full-featured.json',
    ]))
  })

  for (const fixture of fixtures) {
    it(`loads ${fixture.file}: ${fixture.note}`, async () => {
      const loaded = validateAdminConfig(structuredClone(fixture.config), getEnv, 'load')
      expect(loaded.normalized.monitors.length).toBeGreaterThan(0)

      // As a whole site: requests and ticks work, and nothing falls back.
      const { app, deps, asOwner } = await storedSite([fixture.config])
      expect((await app.request('https://status.example.test/')).status).toBe(200)
      expect((await app.request('https://status.example.test/healthz')).status).not.toBe(500)
      const summary = await tick(deps, Date.parse('2026-10-12T12:00:00Z'))
      expect(summary.failedPhases).toEqual([])
      expect(deps.configFallback).toBeUndefined()
      expect(deps.config.title).toBe('Example Status')
      const admin = await app.request('https://status.example.test/admin', { headers: asOwner })
      if (fixture.config.access && (fixture.config.access as { provider: { type: string } }).provider.type === 'basic') expect(admin.status).toBe(200)
      else expect(admin.status).not.toBe(500)
    })
  }

  it('drops a dangling defaults.notify entry on load, logs it, shows it in Settings, and still refuses it on save', async () => {
    const fixture = fixtures.find((f) => f.file === 'dangling-default-notify.json')!
    expect(() => validateAdminConfig(structuredClone(fixture.config), getEnv)).toThrow('defaults.notify references unknown sink "pager-old"')
    const { app, deps, logs, asOwner } = await storedSite([fixture.config])
    await refreshAdminConfig(deps, 1)
    expect(deps.configWarnings).toEqual(['defaults.notify references unknown sink "pager-old" (left out)'])
    expect(deps.config.monitors.map((m) => m.notify)).toEqual([['ops'], ['ops']])
    expect(logs.some((l) => l.level === 'warn' && /left out or adjusted/.test(l.message))).toBe(true)
    const page = await (await app.request('https://status.example.test/admin', { headers: asOwner })).text()
    expect(page).toContain('Some stored settings were left out or adjusted')
    expect(page).toContain('defaults.notify references unknown sink &quot;pager-old&quot; (left out)')
  })

  it('clamps every limit on load, including confirmations and pings per minute, and refuses them on save', () => {
    const limits = { maxChecksPerTick: 0, tickBudgetMs: 10, maxConfirmationsPerTick: 99, pingPerIpPerMinute: 0 }
    const warnings: string[] = []
    const loaded = normalizeConfig(testConfig({ limits }), { warnings })
    expect(loaded.limits).toEqual({ maxChecksPerTick: 1, tickBudgetMs: 1000, maxConfirmationsPerTick: 35, pingPerIpPerMinute: 1 })
    expect(warnings).toHaveLength(4)
    expect(normalizeConfig(testConfig({ limits: { maxConfirmationsPerTick: 2.5 as never, pingPerIpPerMinute: 'many' as never } })).limits)
      .toMatchObject({ maxConfirmationsPerTick: 6, pingPerIpPerMinute: 60 })
    const saved = (() => { try { normalizeConfig(testConfig({ limits }), { save: true }) } catch (e) { return (e as ConfigError).problems } return [] })()
    expect(saved).toEqual(expect.arrayContaining([
      'limits.maxConfirmationsPerTick must be a whole number from 1 to 35',
      'limits.pingPerIpPerMinute must be a whole number from 1 to 10000',
    ]))
  })

  it('drops unknown sinks and prototype-named teams on load, keeping restricted pages restricted', () => {
    const config = testConfig({
      sinks: { ops: { type: 'slack', webhookUrl: 'https://hooks.slack.test/x' } },
      announcements: { notify: ['ops', 'toString'] },
      access: { provider: { type: 'basic' }, admins: { emails: ['a@example.test'], teams: ['constructor'] } },
      pages: [{ slug: 'ops', title: 'Ops', monitors: ['*'], access: { teams: ['constructor'] } }],
    })
    config.groups[0]!.monitors[1] = { ...config.groups[0]!.monitors[1]!, escalation: [{ after: '0s', notify: ['ops'] }, { after: '10m', notify: ['gone'] }] }
    const warnings: string[] = []
    const loaded = normalizeConfig(config, { warnings })
    expect(loaded.announcements.notify).toEqual(['ops'])
    expect(loaded.access!.admins!.teams).toEqual([])
    // The page lists nobody now: still restricted, so it fails closed.
    expect(loaded.pages[0]!.access).toEqual({ emails: [], groups: [], teams: [] })
    expect(loaded.monitors.find((m) => m.id === 'heartbeat')!.escalation).toEqual([{ after: 0, notify: ['ops'] }, { after: 600, notify: [] }])
    expect(warnings).toHaveLength(4)
    expect(() => normalizeConfig(config, { save: true })).toThrow(ConfigError)
  })

  it('reads number header values an early release stored as text, and still refuses them on save', () => {
    const config = site({ groups: [{ name: 'Web', monitors: [{ id: 'site', kind: 'http', name: 'Site', url: 'https://www.example.test/', headers: { 'X-Version': 2 } }] }] })
    const loaded = validateAdminConfig(config, getEnv, 'load')
    expect(loaded.normalized.monitors[0]).toMatchObject({ headers: { 'X-Version': '2' } })
    expect(() => validateAdminConfig(config, getEnv)).toThrow()
    // A credential-named header is still refused, loaded or not.
    const credential = site({ groups: [{ name: 'Web', monitors: [{ id: 'site', kind: 'http', name: 'Site', url: 'https://www.example.test/', headers: { 'X-Api-Key': 12345 } }] }] })
    expect(() => validateAdminConfig(credential, getEnv, 'load')).toThrow(/X-Api-Key: holds a credential/)
  })
})

describe('a stored configuration that cannot load never takes the site down', () => {
  it('falls back to the newest earlier version that loads, keeps working, and says so in Settings', async () => {
    const { app, deps, logs, asOwner, db } = await storedSite([site({ title: 'Version one' }), site({ title: 'Version two' }), unsafe('Version three')])
    expect((await app.request('https://status.example.test/')).status).toBe(200)
    expect(deps.configFallback).toMatchObject({ revision: 2 })
    expect(deps.configFallback!.problem).toContain('ADMIN_TOKEN is a server secret')
    expect(deps.config.title).toBe('Version two')
    expect(logs.some((l) => l.level === 'error' && /Using saved version 2/.test(l.message))).toBe(true)

    const summary = await tick(deps, Date.parse('2026-10-12T12:00:00Z'))
    expect(summary.failedPhases).toEqual([])
    expect(summary.checks).toBe(1)

    const page = await (await app.request('https://status.example.test/admin', { headers: asOwner })).text()
    expect(page).toContain('The stored configuration is invalid and could not be loaded.')
    expect(page).toContain('Version 2 from')
    expect(page).toContain('ADMIN_TOKEN is a server secret')

    // Fixing it (here: a save through the API) loads it and clears the banner.
    await db.run(`UPDATE admin_config SET config_json = ?, updated_at = updated_at + 1 WHERE id = 1`, [JSON.stringify(site({ title: 'Fixed' }))])
    await db.run(`INSERT INTO config_revisions (id, config_json, yaml, actor, action, at) VALUES (4, ?, NULL, 'owner', 'config.save', 1)`, [JSON.stringify(site({ title: 'Fixed' }))])
    const fixed = await (await app.request('https://status.example.test/admin', { headers: asOwner })).text()
    expect(deps.configFallback).toBeUndefined()
    expect(deps.config.title).toBe('Fixed')
    expect(fixed).not.toContain('could not be loaded')
  })

  it('treats a stored row that is not JSON the same way', async () => {
    const { app, deps } = await storedSite([site({ title: 'Good' }), '{not json'])
    expect((await app.request('https://status.example.test/')).status).toBe(200)
    expect(deps.configFallback).toMatchObject({ revision: 1, problem: 'The stored configuration is not a JSON object.' })
    expect(deps.config.title).toBe('Good')
  })

  it('with no version that loads, keeps sign-in, Settings and reset working and runs no checks', async () => {
    const { app, deps, db, asOwner } = await storedSite([unsafe('One'), unsafe('Two')], { STATUSPING_RESET_TOKEN: 'reset-token-0123456789abcdef' })
    // The monitors an earlier release created stay as they were.
    await db.run(`INSERT INTO monitors (id, kind, name, group_name, sort_order, config_json, ping_token_hash, paused, created_at) VALUES ('site', 'http', 'Site', 'Web', 0, '{}', NULL, 0, 1)`)
    expect((await app.request('https://status.example.test/')).status).toBe(200)
    expect(deps.configFallback).toMatchObject({ revision: null })
    // Only the sign-in settings are in use.
    expect(deps.config.title).toBe('Two')
    expect(deps.config.monitors).toEqual([])
    expect(deps.config.access?.provider.type).toBe('basic')

    const admin = await app.request('https://status.example.test/admin', { headers: asOwner })
    expect(admin.status).toBe(200)
    const body = await admin.text()
    expect(body).toContain('no checks are running')
    expect((await app.request('https://status.example.test/admin/configuration', { headers: asOwner })).status).toBe(200)
    expect((await app.request('https://status.example.test/setup/reset')).status).toBe(200)

    const summary = await tick(deps, Date.parse('2026-10-12T12:00:00Z'))
    expect(summary.failedPhases).toEqual(['config'])
    expect(summary.checks).toBe(0)
    expect(await db.first(`SELECT paused FROM monitors WHERE id = 'site'`)).toEqual({ paused: 0 })
  })

  it('keeps /admin and /setup/reset responding even when not even the sign-in settings load', async () => {
    const broken = { ...unsafe('Broken'), access: { provider: { type: 'cloudflare-access', teamDomain: 'not-a-team', audience: { $env: 'ADMIN_TOKEN' } }, admins: { emails: [OWNER] } } }
    const { app, deps } = await storedSite([broken, '[]'], { STATUSPING_RESET_TOKEN: 'reset-token-0123456789abcdef' })
    for (const path of ['/admin', '/setup/reset', '/setup/recover', '/healthz', '/']) {
      expect((await app.request(`https://status.example.test${path}`)).status, path).not.toBe(500)
    }
    expect((await app.request('https://status.example.test/setup/reset')).status).toBe(200)
    expect(deps.configFallback).toMatchObject({ revision: null })
    expect((await tick(deps, Date.parse('2026-10-12T12:00:00Z'))).failedPhases).toEqual(['config'])
  })

  it('serves requests even if loading the configuration throws for another reason', async () => {
    const { app, deps, db } = await storedSite([site({ title: 'Loaded' })])
    expect((await app.request('https://status.example.test/')).status).toBe(200)
    const original = db.first.bind(db)
    db.first = (async (sql: string, params?: never[]) => {
      if (sql.includes('FROM config_revisions) AS rev')) throw new Error('database unavailable')
      return original(sql, params)
    }) as typeof db.first
    expect((await app.request('https://status.example.test/healthz')).status).not.toBe(500)
    expect(deps.config.title).toBe('Loaded')
  })
})
