import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { hashPassword } from '../src/auth/providers.ts'
import { createApp } from '../src/web/app.ts'
import { tick } from '../src/tick.ts'
import { syncConfig } from '../src/sync.ts'
import { authorizeAdminToken, isAdminEnabled, issueCsrfToken, validateAdminConfig, validateAdminSecrets, verifyCsrfToken } from '../src/admin/security.ts'
import { listAudit, loadAdminConfig, redactAdminValue, rotatePingToken, saveAdminConfig, seedAdminConfig, sendSinkTest } from '../src/admin/service.ts'
import { createTestDb, makeDeps, testConfig } from './helpers.ts'

const adminConfig = () => ({
  ...testConfig({
    sinks: { slack: { type: 'slack' as const, webhookUrl: { $env: 'SLACK_WEBHOOK_URL' } } },
    access: { provider: { type: 'basic' as const }, admins: { emails: ['admin@example.test'] } },
  }),
  admin: true,
})

async function adminTables(db: Awaited<ReturnType<typeof createTestDb>>['db']) {
  await db.batch([
    { sql: `CREATE TABLE IF NOT EXISTS admin_config (id INTEGER PRIMARY KEY CHECK (id = 1), config_json TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL)` },
    { sql: `CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, before_json TEXT, after_json TEXT, at INTEGER NOT NULL)` },
    { sql: `CREATE TABLE IF NOT EXISTS admin_csrf (session_hash TEXT PRIMARY KEY, token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL)` },
  ])
}

describe('admin secure configuration', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => close?.())

  it('is disabled unless explicitly opted in and rejects literal credentials', () => {
    expect(isAdminEnabled({})).toBe(false)
    expect(isAdminEnabled({ admin: false })).toBe(false)
    expect(isAdminEnabled({ admin: true })).toBe(true)
    const literal = testConfig({ sinks: { discord: { type: 'discord', webhookUrl: 'https://discord.test/secret' } } })
    expect(validateAdminSecrets(literal)).toContain('sinks.discord.webhookUrl: must be an env(NAME) reference when edited through admin')
    const headers = testConfig({ groups: [{ name: 'x', monitors: [{ id: 'x', kind: 'http', name: 'X', url: 'https://test.invalid', headers: { Authorization: 'Bearer leak' } }] }] })
    expect(validateAdminSecrets(headers)).toContain('groups.0.monitors.0.headers.Authorization: credential-bearing headers are not editable in admin')
    expect(() => validateAdminConfig(adminConfig(), () => undefined)).not.toThrow()
  })

  it('stores only safe config and redacts audit values', async () => {
    const t = await createTestDb('libsql'); close = t.close
    await adminTables(t.db)
    const config = adminConfig()
    expect(await seedAdminConfig(t.db, config, 'seed', 100)).toBe(true)
    expect(await seedAdminConfig(t.db, config, 'seed', 101)).toBe(false)
    const saved = await saveAdminConfig(t.db, { ...config, title: 'Changed' }, 'admin@example.test', 200, () => undefined)
    expect(saved.updatedBy).toBe('admin@example.test')
    expect((await loadAdminConfig(t.db))?.config.title).toBe('Changed')
    const audit = await listAudit(t.db)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.after).toMatchObject({ sinks: { slack: { webhookUrl: { $env: 'SLACK_WEBHOOK_URL', set: false } } } })
    expect(redactAdminValue({ apiKey: { $env: 'KEY' }, safe: { $env: 'PUBLIC' } })).toEqual({ apiKey: '[environment reference]', safe: { $env: 'PUBLIC', set: false } })
  })

  it('rotates push tokens once and audits no plaintext token', async () => {
    const t = await createTestDb('libsql'); close = t.close
    await adminTables(t.db)
    const deps = makeDeps(t.db)
    await syncConfig(deps, 100)
    const token = await rotatePingToken(t.db, 'heartbeat', 'admin@example.test', 200)
    expect(token).toMatch(/^[A-Za-z0-9]{40}$/)
    expect(await rotatePingToken(t.db, 'site', 'admin@example.test', 201)).toBeNull()
    const row = await t.db.first<{ ping_token_hash: string }>(`SELECT ping_token_hash FROM monitors WHERE id = 'heartbeat'`)
    expect(row?.ping_token_hash).not.toBe(token)
    expect((await listAudit(t.db))[0]).toMatchObject({ action: 'ping-token.rotate', target: 'monitor:heartbeat', before: null, after: null })
  })

  it('uses a constant-time bearer token check and does not authorize when absent', () => {
    expect(authorizeAdminToken('Bearer right', (name) => name === 'ADMIN_TOKEN' ? 'right' : undefined)).toBe(true)
    expect(authorizeAdminToken('Bearer wrong', () => 'right')).toBe(false)
    expect(authorizeAdminToken('Bearer right', () => undefined)).toBe(false)
  })

  it('sends one explicit test alert through the requested sink only', async () => {
    const calls: string[] = []
    const config = adminConfig()
    await sendSinkTest('slack', config, (name) => name === 'SLACK_WEBHOOK_URL' ? 'https://slack.test/hook' : undefined, (async (url) => {
      calls.push(String(url)); return new Response('ok')
    }) as typeof fetch)
    expect(calls).toEqual(['https://slack.test/hook'])
    await expect(sendSinkTest('unknown', config, () => undefined, fetch)).rejects.toThrow('unknown sink')
  })

  it('binds one-time CSRF tokens to the signed-in session cookie', async () => {
    const t = await createTestDb('libsql'); close = t.close
    await adminTables(t.db)
    const app = new Hono()
    app.get('/issue', async (c) => c.text((await issueCsrfToken(t.db, c, 100)) ?? 'none'))
    app.post('/check', async (c) => c.text(String(await verifyCsrfToken(t.db, c, await c.req.text(), 101))))
    const issued = await app.request('/issue', { headers: { cookie: 'sp_session=valid-session' } })
    const token = await issued.text()
    expect(token).toHaveLength(32)
    expect(await (await app.request('/check', { method: 'POST', headers: { cookie: 'sp_session=other-session' }, body: token })).text()).toBe('false')
    expect(await (await app.request('/check', { method: 'POST', headers: { cookie: 'sp_session=valid-session' }, body: token })).text()).toBe('true')
    expect(await (await app.request('/check', { method: 'POST', headers: { cookie: 'sp_session=valid-session' }, body: token })).text()).toBe('false')
  })

  it('mounts no admin surface by default, then protects browser and API management flows', async () => {
    const off = await createTestDb('libsql')
    expect((await createApp(makeDeps(off.db)).request('/admin')).status).toBe(404)
    await off.close()

    const t = await createTestDb('libsql'); close = t.close
    const users = { 'admin@example.test': await hashPassword('very-long-admin-password') }
    const calls: string[] = []
    const deps = makeDeps(t.db, {
      config: adminConfig(),
      env: { BASIC_AUTH_USERS: JSON.stringify(users), ADMIN_TOKEN: 'admin-api-token' },
      fetch: (async (url) => { calls.push(String(url)); return new Response('ok') }) as typeof fetch,
    })
    await tick(deps, 60_000)
    calls.length = 0
    const app = createApp(deps)
    const login = await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'admin@example.test', password: 'very-long-admin-password', next: '/admin' }).toString() })
    const cookie = login.headers.getSetCookie().find((header) => header.startsWith('sp_session='))!.split(';')[0]!
    const page = await app.request('/admin', { headers: { cookie } })
    expect(page.status).toBe(200)
    const pageText = await page.text()
    expect(pageText).toContain('Administration')
    expect(pageText).toContain('Generate / rotate')
    expect(pageText).toContain('Send test')
    expect(pageText).not.toContain('https://slack.test')
    expect((await app.request('/api/admin/config')).status).toBe(401)
    const api = await app.request('/api/admin/config', { headers: { authorization: 'Bearer admin-api-token' } })
    expect(api.status).toBe(200)
    const apiBody = await api.json() as { config: Record<string, unknown> }
    expect(apiBody).toMatchObject({ config: { admin: true, sinks: { slack: { webhookUrl: { $env: 'SLACK_WEBHOOK_URL' } } } } })
    // A management client can safely round-trip a config: it sees env names, never values.
    const unchanged = await app.request('/api/admin/config', { method: 'PUT', headers: { authorization: 'Bearer admin-api-token', 'content-type': 'application/json' }, body: JSON.stringify(apiBody.config) })
    expect(unchanged.status).toBe(200)
    const unsafe = await app.request('/api/admin/config', { method: 'PUT', headers: { authorization: 'Bearer admin-api-token', 'content-type': 'application/json' }, body: JSON.stringify({ ...adminConfig(), sinks: { slack: { type: 'slack', webhookUrl: 'literal-secret' } } }) })
    expect(unsafe.status).toBe(400)
    const tested = await app.request('/api/admin/sinks/slack/test', { method: 'POST', headers: { authorization: 'Bearer admin-api-token' } })
    expect(tested.status).toBe(400) // The environment reference is deliberately unset in this test.
    expect(calls).toEqual([])
    const token = await app.request('/api/admin/ping-tokens/heartbeat/rotate', { method: 'POST', headers: { authorization: 'Bearer admin-api-token' } })
    expect(token.status).toBe(201)
    expect((await token.json()).token).toMatch(/^[A-Za-z0-9]{40}$/)
  })
})
