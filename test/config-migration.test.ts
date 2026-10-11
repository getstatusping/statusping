import { afterEach, describe, expect, it } from 'vitest'
import { LEGACY_CONFIG_KEY } from '../src/deps.ts'
import { createApp } from '../src/web/app.ts'
import { createTestDb, makeDeps, testConfig } from './helpers.ts'

describe('moving config-as-code sites to the database (plan 011)', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => close?.())

  const health = async (app: ReturnType<typeof createApp>) => (await app.request('/healthz')).json() as Promise<Record<string, unknown>>
  const saved = async (db: Awaited<ReturnType<typeof createTestDb>>['db']) => (await db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = ?`, [LEGACY_CONFIG_KEY]))?.value

  it('v0.2.26: a config-as-code site keeps running from its file and saves a validated copy', async () => {
    const t = await createTestDb('libsql'); close = t.close
    const logs: string[] = []
    const deps = makeDeps(t.db, { config: testConfig({ sinks: {} }) })
    deps.log = (_level, message, data) => { logs.push(`${message} ${JSON.stringify(data ?? {})}`) }
    const app = createApp(deps)
    const h = await health(app)
    expect(h, logs.join('\n')).toMatchObject({ config: 'code', migration: 'ready' })
    const copy = JSON.parse((await saved(t.db))!)
    expect(copy).toMatchObject({ title: 'Test Status', admin: true })
    expect(logs.some((l) => l.includes('deprecated'))).toBe(true)
    // Still config-as-code: nothing moved into admin_config.
    expect(await t.db.first(`SELECT id FROM admin_config`)).toBeNull()
  })

  it('reports "blocked" and saves nothing when the file holds a literal credential', async () => {
    const t = await createTestDb('libsql'); close = t.close
    const config = testConfig({ sinks: { team: { type: 'slack', webhookUrl: 'https://hooks.slack.com/services/T0/B0/literal-secret' } } })
    const deps = makeDeps(t.db, { config })
    deps.log = () => {}
    const app = createApp(deps)
    expect(await health(app)).toMatchObject({ config: 'code', migration: 'blocked' })
    expect(await saved(t.db)).toBeUndefined()
  })

  it('says nothing about migration on a site already configured in the database', async () => {
    const t = await createTestDb('libsql'); close = t.close
    const app = createApp(makeDeps(t.db, { config: { ...testConfig({ sinks: {}, access: { provider: { type: 'basic' as const }, admins: { emails: ['a@example.test'] } } }), admin: true } }))
    const h = await health(app)
    expect(h).not.toHaveProperty('config')
    expect(h).not.toHaveProperty('migration')
  })
})
