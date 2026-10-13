/**
 * Round 20 security review: a password stored in the site (local_users) belongs to an
 * administrator. It stops working when the address stops being one, and the row is deleted in the
 * same transaction as the save that removed them; switching to SSO deletes every stored password;
 * Settings → Access lists stored passwords and removes one; verifyPassword costs the same whether
 * or not the address exists.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createClient } from '@libsql/client'
import { describe, expect, it, onTestFinished } from 'vitest'
import { LibsqlDb } from '../src/db/libsql.ts'
import { migrate } from '../src/schema.ts'
import { hashPassword, hashUserPassword, verifyPassword } from '../src/auth/providers.ts'
import { pruneLocalUsersStatement, storedPasswordAllowed } from '../src/auth/local-users.ts'
import { refreshAdminConfig, storedEnvKey } from '../src/deps.ts'
import { saveAdminConfig } from '../src/admin/service.ts'
import { createApiToken } from '../src/mcp/tokens.ts'
import { tick } from '../src/tick.ts'
import { createApp } from '../src/web/app.ts'
import { createTestDb, makeDeps, testConfig } from './helpers.ts'

const ORIGIN = 'https://status.test'
const T0 = Date.parse('2026-10-11T00:00:00Z')
type App = ReturnType<typeof createApp>

function browser(app: App) {
  const jar = new Map<string, string>()
  let csrf = ''
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
    const res = await app.request(`${ORIGIN}${path}`, { ...init, headers })
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';')
      const [k, ...v] = pair!.split('=')
      if (/max-age=0/i.test(cookie) || v.join('=') === '') jar.delete(k!)
      else jar.set(k!, v.join('='))
    }
    const body = await res.text()
    csrf = /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? csrf
    return { res, body }
  }
  return {
    jar,
    get: (path: string) => send(path),
    post: (path: string, fields: Record<string, string>, opts: { csrf?: boolean } = {}) => send(path, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(opts.csrf === false ? fields : { csrf, ...fields }).toString(),
    }),
  }
}

async function site(admins: string[], env: Record<string, string>, extra: Record<string, unknown> = {}) {
  const { db, close } = await createTestDb('libsql')
  onTestFinished(close)
  const config = { ...testConfig({ sinks: {}, access: { provider: { type: 'basic' as const }, admins: { emails: admins } }, ...extra }), baseUrl: ORIGIN, admin: true }
  const deps = makeDeps(db, { config, env })
  await tick(deps, T0)
  return { db, deps, app: createApp(deps), config }
}

const storePassword = async (db: Awaited<ReturnType<typeof site>>['db'], email: string, password: string) =>
  db.run(`INSERT INTO local_users (email, password_hash, created_at) VALUES (?, ?, 1)`, [email, await hashUserPassword(password)])
const storedEmails = async (db: Awaited<ReturnType<typeof site>>['db']) => (await db.all<{ email: string }>(`SELECT email FROM local_users ORDER BY email`)).map((r) => r.email)

async function startPasswordSwitch(b: ReturnType<typeof browser>, password: string) {
  await b.get('/admin/access/method')
  await b.post('/admin/access/method', { method: 'basic' })
  await b.get('/admin/access/method')
  await b.post('/admin/access/method/settings', { password, confirm: password })
  return (await b.get('/admin/access/method')).body
}

async function bossEnv(extra: Record<string, string> = {}) {
  return { BASIC_AUTH_USERS: JSON.stringify({ 'boss@corp.test': await hashPassword('boss-password-123456'), ...extra }) }
}

describe('round 20: stored passwords follow the administrators', () => {
  it('P1: removing an administrator in Settings → Access ends their stored password', async () => {
    const { db, deps, app } = await site(['boss@corp.test', 'alice@corp.test'], await bossEnv(), {
      pages: [{ slug: 'internal', title: 'Internal', access: { emails: ['*@corp.test'] }, monitors: ['*'] }],
    })
    await storePassword(db, 'alice@corp.test', 'alice-stored-password')
    const alice = browser(app)
    expect((await alice.post('/auth/login', { email: 'alice@corp.test', password: 'alice-stored-password', next: '/admin' })).res.status).toBe(303)
    expect((await alice.get('/admin')).res.status).toBe(200)

    const boss = browser(app)
    await boss.post('/auth/login', { email: 'boss@corp.test', password: 'boss-password-123456', next: '/admin' })
    await boss.get('/admin/access')
    expect((await boss.post('/admin/access', { admins: 'boss@corp.test' })).res.status).toBe(303)
    await refreshAdminConfig(deps, Math.floor(Date.now() / 1000))

    expect((await alice.get('/admin')).res.status).toBe(403)
    // The row went in the same save, and the password no longer signs in.
    expect(await storedEmails(db)).toEqual([])
    const again = browser(app)
    expect((await again.post('/auth/login', { email: 'alice@corp.test', password: 'alice-stored-password', next: '/' })).res.status).toBe(401)
    expect((await again.get('/pages/internal')).res.status).not.toBe(200)
  })

  it('a stored password of an address that is not an administrator is refused even when the row is still there', async () => {
    // A row an earlier release left behind, or one written by any path that does not prune.
    const { db, deps } = await site(['boss@corp.test'], await bossEnv())
    await storePassword(db, 'gone@corp.test', 'gone-stored-password')
    expect(await verifyPassword(deps, 'gone@corp.test', 'gone-stored-password')).toBeNull()
    expect(storedPasswordAllowed(deps.config.access, 'gone@corp.test')).toBe(false)
    expect(storedPasswordAllowed(deps.config.access, 'BOSS@corp.test')).toBe(true)
  })

  it('a refused stored password falls back to the BASIC_AUTH_USERS entry, which may list page viewers', async () => {
    const { db, deps } = await site(['boss@corp.test'], await bossEnv({ 'viewer@corp.test': await hashPassword('viewer-env-password') }))
    await storePassword(db, 'viewer@corp.test', 'viewer-stored-password')
    expect(await verifyPassword(deps, 'viewer@corp.test', 'viewer-stored-password')).toBeNull()
    expect(await verifyPassword(deps, 'viewer@corp.test', 'viewer-env-password')).toMatchObject({ email: 'viewer@corp.test' })
  })

  it('MCP set_administrators deletes the stored password of a removed administrator', async () => {
    const { db, deps, app } = await site(['boss@corp.test', 'alice@corp.test'], await bossEnv())
    await storePassword(db, 'alice@corp.test', 'alice-stored-password')
    await storePassword(db, 'boss@corp.test', 'boss-stored-password')
    const token = await createApiToken(db, 'bot', ['settings'], 'boss@corp.test', 1)
    const res = await app.request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_administrators', arguments: { emails: ['boss@corp.test'] } } }),
    })
    expect(((await res.json()) as { result: { isError?: boolean } }).result.isError).toBeFalsy()
    expect(await storedEmails(db)).toEqual(['boss@corp.test'])
    await refreshAdminConfig(deps, 5)
    expect(await verifyPassword(deps, 'alice@corp.test', 'alice-stored-password')).toBeNull()
    expect(await verifyPassword(deps, 'boss@corp.test', 'boss-stored-password')).not.toBeNull()
  })

  it('the configuration API (YAML/JSON PUT) deletes the stored password of a removed administrator', async () => {
    const { db, app } = await site(['boss@corp.test', 'alice@corp.test'], { ...(await bossEnv()), ADMIN_TOKEN: 'admin-api-token' })
    await storePassword(db, 'alice@corp.test', 'alice-stored-password')
    const API = { authorization: 'Bearer admin-api-token', 'content-type': 'application/json' }
    const { config } = (await (await app.request(`${ORIGIN}/api/admin/config`, { headers: API })).json()) as { config: Record<string, any> }
    const next = { ...config, access: { ...config.access, admins: { emails: ['boss@corp.test'] } } }
    expect((await app.request(`${ORIGIN}/api/admin/config`, { method: 'PUT', headers: API, body: JSON.stringify(next) })).status).toBe(200)
    expect(await storedEmails(db)).toEqual([])
  })

  it('pruning keeps administrators by address, *@domain pattern and administrator team', async () => {
    const { db, deps } = await site(['boss@corp.test'], await bossEnv())
    for (const email of ['boss@corp.test', 'any@corp.test', 'x@notcorp.test', 'ops@other.test', 'evil@corp.test.evil', 'stranger@else.test']) await storePassword(db, email, 'pw-123456789012')
    const next = {
      ...deps.configInput, admin: true,
      access: { provider: { type: 'basic' }, teams: { ops: { emails: ['ops@other.test'] } }, admins: { emails: ['boss@corp.test', '*@corp.test'], teams: ['ops'] } },
    }
    await saveAdminConfig(db, next, 'test', 10, deps.getEnv, { hasRealEnv: deps.hasRealEnv })
    expect(await storedEmails(db)).toEqual(['any@corp.test', 'boss@corp.test', 'ops@other.test'])
    await refreshAdminConfig(deps, 10)
    // The SQL prune and the sign-in check agree.
    for (const email of ['any@corp.test', 'boss@corp.test', 'ops@other.test']) expect(storedPasswordAllowed(deps.config.access, email)).toBe(true)
    for (const email of ['x@notcorp.test', 'evil@corp.test.evil', 'stranger@else.test']) expect(storedPasswordAllowed(deps.config.access, email)).toBe(false)
  })

  it('the prune statement runs on D1 as well (json_each, one bound parameter)', async () => {
    const { db, close } = await createTestDb('d1')
    onTestFinished(close)
    for (const email of ['boss@corp.test', 'any@corp.test', 'x@notcorp.test', 'ops@other.test', 'stranger@else.test']) {
      await db.run(`INSERT INTO local_users (email, password_hash, created_at) VALUES (?, 'h', 1)`, [email])
    }
    const access = { provider: { type: 'basic' }, teams: { ops: { emails: ['ops@other.test'], groups: [] } }, sessionHours: 12, admins: { emails: ['boss@corp.test', '*@corp.test'], groups: [], teams: ['ops'] } } as never
    const { sql, params } = pruneLocalUsersStatement(access)
    await db.batch([{ sql, params }])
    expect((await db.all<{ email: string }>(`SELECT email FROM local_users ORDER BY email`)).map((r) => r.email)).toEqual(['any@corp.test', 'boss@corp.test', 'ops@other.test'])
  })

  it('pruning deletes every stored password without email + password or administrators', () => {
    expect(pruneLocalUsersStatement(null)).toEqual({ sql: 'DELETE FROM local_users' })
    const access = { provider: { type: 'oidc' }, teams: {}, sessionHours: 12, admins: { emails: ['a@b.test'], groups: [], teams: [] } } as never
    expect(pruneLocalUsersStatement(access)).toEqual({ sql: 'DELETE FROM local_users' })
  })

  it('P2: BASIC_AUTH_USERS rotation does not revoke a stored password; Settings → Access says so and removes it', async () => {
    const env = await bossEnv({ 'a@corp.test': await hashPassword('rotated-env-password-1') })
    const { db, deps, app } = await site(['boss@corp.test', 'a@corp.test'], env)
    await storePassword(db, 'a@corp.test', 'leaked-stored-password')
    await storePassword(db, 'boss@corp.test', 'boss-stored-password-1')
    // The stored password wins over the env entry (v0.3.19), so rotating the secret does not help ...
    expect(await verifyPassword(deps, 'a@corp.test', 'rotated-env-password-1')).toBeNull()
    expect(await verifyPassword(deps, 'a@corp.test', 'leaked-stored-password')).not.toBeNull()

    const boss = browser(app)
    expect((await boss.post('/auth/login', { email: 'boss@corp.test', password: 'boss-stored-password-1', next: '/admin' })).res.status).toBe(303)
    const page = (await boss.get('/admin/access')).body
    expect(page).toContain('Passwords stored in the site')
    expect(page).toContain('a@corp.test')
    expect(page).toContain('BASIC_AUTH_USERS still lists a@corp.test')
    // Boss's own row has no Remove button.
    expect(page).toContain('Your own: another administrator has to remove it.')

    // Without a CSRF value the removal is refused.
    expect((await boss.post('/admin/access/passwords/remove', { email: 'a@corp.test' }, { csrf: false })).res.status).toBe(403)
    // Removing one's own stored password is refused.
    expect((await boss.post('/admin/access/passwords/remove', { email: 'boss@corp.test' })).res.status).toBe(400)
    expect(await storedEmails(db)).toEqual(['a@corp.test', 'boss@corp.test'])

    const removed = await boss.post('/admin/access/passwords/remove', { email: 'A@corp.test' })
    expect(removed.res.status).toBe(303)
    expect(removed.res.headers.get('location')).toContain('password-removed')
    expect(await storedEmails(db)).toEqual(['boss@corp.test'])
    const audit = await db.first<{ actor: string; target: string }>(`SELECT actor, target FROM audit_log WHERE action = 'access.password-remove'`)
    expect(audit).toEqual({ actor: 'boss@corp.test', target: 'local-user:a@corp.test' })
    // ... and now the rotated env password is the one that works.
    expect(await verifyPassword(deps, 'a@corp.test', 'leaked-stored-password')).toBeNull()
    expect(await verifyPassword(deps, 'a@corp.test', 'rotated-env-password-1')).not.toBeNull()
    // Removing an address with nothing stored changes nothing.
    expect((await boss.post('/admin/access/passwords/remove', { email: 'a@corp.test' })).res.headers.get('location')).toContain('password-missing')
  })

  it('only an administrator can remove a stored password', async () => {
    const env = await bossEnv({ 'viewer@corp.test': await hashPassword('viewer-env-password') })
    const { db, app } = await site(['boss@corp.test'], env)
    await storePassword(db, 'boss@corp.test', 'boss-stored-password-1')
    const viewer = browser(app)
    expect((await viewer.post('/auth/login', { email: 'viewer@corp.test', password: 'viewer-env-password', next: '/' })).res.status).toBe(303)
    const res = await viewer.post('/admin/access/passwords/remove', { email: 'boss@corp.test' }, { csrf: false })
    expect(res.res.status).toBeGreaterThanOrEqual(403)
    expect(await storedEmails(db)).toEqual(['boss@corp.test'])
  })

  it('P3: switching to SSO deletes every stored password, so basic → oidc → basic revives none', async () => {
    const { db, deps, app } = await site(['boss@corp.test'], await bossEnv())
    await storePassword(db, 'old-admin@corp.test', 'old-admin-password')
    await storePassword(db, 'boss@corp.test', 'boss-old-stored-password')
    const oidc = { ...deps.configInput, access: { provider: { type: 'oidc', issuer: 'https://idp.example', clientId: { $env: 'OIDC_CLIENT_ID' }, clientSecret: { $env: 'OIDC_CLIENT_SECRET' } }, admins: { emails: ['boss@corp.test'] } }, admin: true }
    await db.run(`INSERT INTO instance_secrets (name, value, created_at) VALUES (?, 'id', 1), (?, 'secret', 1)`, [storedEnvKey('OIDC_CLIENT_ID'), storedEnvKey('OIDC_CLIENT_SECRET')])
    await refreshAdminConfig(deps, 2)
    await saveAdminConfig(db, oidc, 'test', 3, deps.getEnv, { hasRealEnv: deps.hasRealEnv })
    await refreshAdminConfig(deps, 3)
    expect(deps.config.access?.provider.type).toBe('oidc')
    expect(await storedEmails(db)).toEqual([])
    expect((await app.request(`${ORIGIN}/auth/login`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=old-admin%40corp.test&password=old-admin-password' })).status).toBe(404)

    // A row left from before v0.3.20 (when SSO kept them) is not revived either.
    await storePassword(db, 'old-admin@corp.test', 'old-admin-password')
    const basic = { ...deps.configInput, access: { provider: { type: 'basic' }, admins: { emails: ['boss@corp.test'] } }, admin: true }
    await saveAdminConfig(db, basic, 'test', 4, deps.getEnv, { hasRealEnv: deps.hasRealEnv, extra: [{ sql: `INSERT INTO local_users (email, password_hash, created_at) VALUES ('boss@corp.test', ?, 4)`, params: [await hashUserPassword('boss-new-password-1')] }] })
    await refreshAdminConfig(deps, 4)
    expect(await verifyPassword(deps, 'old-admin@corp.test', 'old-admin-password')).toBeNull()
    expect(await verifyPassword(deps, 'boss@corp.test', 'boss-old-stored-password')).toBeNull()
    expect(await verifyPassword(deps, 'boss@corp.test', 'boss-new-password-1')).not.toBeNull()
    expect(await storedEmails(db)).toEqual(['boss@corp.test'])
  })

  it('a new password through Change sign-in method keeps other administrators\' stored passwords and says so', async () => {
    const env = await bossEnv({ 'b@corp.test': await hashPassword('b-env-password-12345') })
    const { db, app } = await site(['boss@corp.test', 'b@corp.test'], env)
    await storePassword(db, 'b@corp.test', 'b-stored-password-1')
    const boss = browser(app)
    await boss.post('/auth/login', { email: 'boss@corp.test', password: 'boss-password-123456', next: '/admin' })
    const page = await startPasswordSwitch(boss, 'boss-new-password-123')
    expect(page).toContain('Other administrators keep the password stored in the site')
    expect(page).not.toContain('cannot sign in until they have a password')
    expect((await boss.post('/admin/access/method/apply', {})).res.status).toBe(303)
    expect(await storedEmails(db)).toEqual(['b@corp.test', 'boss@corp.test'])
    // The audit row goes through the same redaction as every other one, and still says what changed.
    const row = await db.first<{ after_json: string }>(`SELECT after_json FROM audit_log WHERE action = 'access.method-change'`)
    expect(JSON.parse(row!.after_json)).toMatchObject({ method: 'basic', startedBy: 'boss@corp.test', verifiedEmail: 'boss@corp.test' })
  })

  it('P4: verifyPassword takes about as long for an unknown address as for a stored or env one', async () => {
    const { db, deps } = await site(['a@example.test'], { BASIC_AUTH_USERS: JSON.stringify({ 'env@example.test': await hashPassword('env-password-1') }) })
    await storePassword(db, 'a@example.test', 'stored-password-1')
    const time = async (email: string) => {
      const t = performance.now()
      for (let i = 0; i < 10; i++) await verifyPassword(deps, email, 'wrong-password-xyz')
      return (performance.now() - t) / 10
    }
    await time('a@example.test') // warm up
    const stored = await time('a@example.test')
    const unknown = await time('nobody@example.test')
    const env = await time('env@example.test')
    // Before: unknown ~0.02 ms against ~5 ms for a stored hash. Every path now runs one PBKDF2.
    expect(unknown).toBeGreaterThan(stored * 0.4)
    expect(env).toBeGreaterThan(stored * 0.4)
    // And no dummy hash ever lets anyone in.
    expect(await verifyPassword(deps, 'nobody@example.test', '')).toBeNull()
    expect(await verifyPassword(deps, 'nobody@example.test', 'x')).toBeNull()
  })

  it('P5: another administrator cancels and replaces the draft; the original starter\'s apply is refused', async () => {
    const env = { BASIC_AUTH_USERS: JSON.stringify({ 'a@example.test': await hashPassword('a-password-123456'), 'b@example.test': await hashPassword('b-password-123456') }) }
    const { db, app } = await site(['a@example.test', 'b@example.test'], env)
    const a = browser(app), b = browser(app)
    await a.post('/auth/login', { email: 'a@example.test', password: 'a-password-123456', next: '/admin' })
    await b.post('/auth/login', { email: 'b@example.test', password: 'b-password-123456', next: '/admin' })
    expect(await startPasswordSwitch(a, 'a-new-password-123456')).toContain('Password saved')
    await b.get('/admin/access/method')
    expect((await b.post('/admin/access/method/cancel', {})).res.status).toBe(303)
    expect(await startPasswordSwitch(b, 'b-new-password-123456')).toContain('Password saved')
    expect((await a.post('/admin/access/method/apply', {})).res.status).toBe(409)
    expect(await db.first(`SELECT email FROM local_users WHERE email = 'a@example.test'`)).toBeNull()
    expect((await b.post('/admin/access/method/apply', {})).res.status).toBe(303)
    expect(await storedEmails(db)).toEqual(['b@example.test'])
  })
})

describe('round 20: the CLI', () => {
  const cli = (args: string[], env: Record<string, string>) => promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', 'cli/statusping.ts', ...args], {
    cwd: join(import.meta.dirname, '..'), env: { ...process.env, ...env },
  })
  async function fileDb(stored: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'statusping-r20-'))
    const url = `file:${join(dir, 'r20.db')}`
    const client = createClient({ url })
    onTestFinished(() => client.close())
    const db = new LibsqlDb(client)
    await migrate(db)
    await db.run(`INSERT INTO admin_config (id, config_json, updated_at, updated_by) VALUES (1, ?, 1, 'x')`, [JSON.stringify(stored)])
    return { db, url }
  }

  it('`recover` from SSO keeps only the recovered password; from email + password it keeps other administrators\' ones', async () => {
    const sso = await fileDb({ title: 'T', baseUrl: ORIGIN, groups: [], admin: true, access: { provider: { type: 'cloudflare-access', teamDomain: 'team.cloudflareaccess.com', audience: 'aud' }, admins: { emails: ['admin@example.test', 'other@example.test'] } } })
    for (const email of ['other@example.test', 'admin@example.test', 'gone@example.test']) await storePassword(sso.db as never, email, 'dormant-password-1')
    await cli(['recover', 'admin@example.test'], { TURSO_DATABASE_URL: sso.url, BASIC_AUTH_USERS: '' })
    expect(await storedEmails(sso.db as never)).toEqual(['admin@example.test'])

    const basic = await fileDb({ title: 'T', baseUrl: ORIGIN, groups: [], admin: true, access: { provider: { type: 'basic' }, admins: { emails: ['other@example.test'] } } })
    for (const email of ['other@example.test', 'gone@example.test']) await storePassword(basic.db as never, email, 'stored-password-1')
    await cli(['recover', 'admin@example.test'], { TURSO_DATABASE_URL: basic.url, BASIC_AUTH_USERS: '' })
    expect(await storedEmails(basic.db as never)).toEqual(['admin@example.test', 'other@example.test'])
  })

  it('`remove-user` deletes a stored password and records it', async () => {
    const { db, url } = await fileDb({ title: 'T', baseUrl: ORIGIN, groups: [], admin: true, access: { provider: { type: 'basic' }, admins: { emails: ['a@example.test', 'b@example.test'] } } })
    await storePassword(db as never, 'a@example.test', 'stored-password-1')
    await storePassword(db as never, 'b@example.test', 'stored-password-2')
    const BASIC_AUTH_USERS = JSON.stringify({ 'a@example.test': await hashPassword('env-password-12345') })
    const { stdout } = await cli(['remove-user', 'A@example.test'], { TURSO_DATABASE_URL: url, BASIC_AUTH_USERS })
    expect(stdout).toContain('removed the password stored in the site for a@example.test')
    expect(stdout).toContain('BASIC_AUTH_USERS lists a@example.test')
    expect(await storedEmails(db as never)).toEqual(['b@example.test'])
    expect(await db.first(`SELECT actor, target FROM audit_log WHERE action = 'access.password-remove'`)).toEqual({ actor: 'cli', target: 'local-user:a@example.test' })
    expect((await cli(['remove-user', 'a@example.test'], { TURSO_DATABASE_URL: url, BASIC_AUTH_USERS: '' })).stdout).toContain('has no password stored')
  })
})
