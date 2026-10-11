import { afterEach, describe, expect, it } from 'vitest'
import { createDeps, LEGACY_CONFIG_KEY } from '../src/deps.ts'
import { createApp } from '../src/web/app.ts'
import { createTestDb, testConfig } from './helpers.ts'

describe('first run of v0.3.0 on a former config-as-code site (plan 011)', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => close?.())

  async function site(env: Record<string, string> = {}, saved?: unknown, file?: unknown) {
    const t = await createTestDb('libsql'); close = t.close
    const { migrate } = await import('../src/schema.ts')
    await migrate(t.db)
    if (saved) await t.db.run(`INSERT INTO instance_secrets (name, value, created_at) VALUES (?, ?, 0)`, [LEGACY_CONFIG_KEY, JSON.stringify(saved)])
    const logs: string[] = []
    const deps = createDeps({ db: t.db, getEnv: (name) => env[name], log: (_l, message) => { logs.push(message) }, legacyConfig: async () => file as never })
    return { db: t.db, app: createApp(deps), logs }
  }
  const admins = { access: { provider: { type: 'basic' as const }, admins: { emails: ['owner@example.test'] } } }

  it('adopts the copy v0.2.26 saved, ahead of STATUSPING_CONFIG, and removes the copy', async () => {
    const s = await site({ STATUSPING_CONFIG: JSON.stringify(testConfig({ sinks: {}, title: 'From the variable', ...admins })) }, { ...testConfig({ sinks: {}, title: 'From the saved copy', ...admins }), admin: true })
    const home = await s.app.request('/')
    expect(home.status).toBe(200)
    expect(await home.text()).toContain('From the saved copy')
    expect(await s.db.first(`SELECT name FROM instance_secrets WHERE name = ?`, [LEGACY_CONFIG_KEY])).toBeNull()
    expect(await s.db.first<{ status: string }>(`SELECT status FROM setup_state`)).toEqual({ status: 'complete' })
    expect(await s.db.first<{ actor: string }>(`SELECT actor FROM config_revisions`)).toEqual({ actor: 'migration' })
  })

  it('adopts an old statusping.config.ts directly, without an intermediate release, ahead of STATUSPING_CONFIG', async () => {
    const s = await site({ STATUSPING_CONFIG: JSON.stringify(testConfig({ sinks: {}, title: 'From the variable', ...admins })) }, undefined, testConfig({ sinks: {}, title: 'From the old file', ...admins }))
    expect(await (await s.app.request('/')).text()).toContain('From the old file')
    expect(await s.db.first<{ status: string }>(`SELECT status FROM setup_state`)).toEqual({ status: 'complete' })
  })

  it('starts setup when the old configuration cannot be adopted, saying why in the log', async () => {
    const s = await site({ STATUSPING_CONFIG: JSON.stringify(testConfig({ sinks: { team: { type: 'slack', webhookUrl: 'https://hooks.slack.com/services/T0/B0/literal' } }, ...admins })) })
    expect((await s.app.request('/')).headers.get('location')).toBe('/setup')
    expect(s.logs.some((l) => l.includes('could not be moved'))).toBe(true)
    expect(JSON.parse((await s.db.first<{ draft_json: string }>(`SELECT draft_json FROM setup_state`))!.draft_json)).toEqual({})
  })

  it('never adopts STATUSPING_CONFIG on a hosted tenant', async () => {
    const tenant = JSON.stringify({ tenantId: 'acme', plan: 'free', maxMonitors: 10, minIntervalMin: 5, maxPages: 2, historyDays: 30 })
    const s = await site({ STATUSPING_TENANT: tenant, STATUSPING_SETUP_TOKEN: 'tenant-setup-token', STATUSPING_CONFIG: JSON.stringify(testConfig({ sinks: {}, ...admins })) })
    expect((await s.app.request('/')).headers.get('location')).toBe('/setup')
    expect(await s.db.first(`SELECT id FROM admin_config`)).toBeNull()
  })
})
