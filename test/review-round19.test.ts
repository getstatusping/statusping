import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createClient } from '@libsql/client'
import { describe, expect, it, onTestFinished } from 'vitest'
import { rotatePingToken } from '../src/admin/service.ts'
import { epochKey, rotateSignInEpochStatement } from '../src/auth/epoch.ts'
import { basicAuthUsersLists, hashPassword, hashUserPassword, verifyPassword } from '../src/auth/providers.ts'
import { LibsqlDb } from '../src/db/libsql.ts'
import { refreshAdminConfig, storedEnvKey } from '../src/deps.ts'
import { migrate } from '../src/schema.ts'
import { beginSetup, loadSetupState } from '../src/setup/state.ts'
import { tick } from '../src/tick.ts'
import { createApp } from '../src/web/app.ts'
import { createTestDb, makeDeps, testConfig } from './helpers.ts'

/** Round 19 security review: a password set in the site wins over BASIC_AUTH_USERS; switch drafts belong to whoever started them. */

const ORIGIN = 'https://status.test'
const T0 = Date.parse('2026-10-11T00:00:00Z')
type App = ReturnType<typeof createApp>

/** A browser: keeps cookies and the last CSRF token it saw. */
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
    post: (path: string, fields: Record<string, string>) => send(path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, ...fields }).toString() }),
  }
}

const sessionEmail = (b: ReturnType<typeof browser>) => {
  const cookie = b.jar.get('sp_session')
  return cookie ? (JSON.parse(Buffer.from(cookie.split('.')[0]!, 'base64url').toString()) as { email: string }).email : null
}

async function site(admins: string[], env: Record<string, string>) {
  const { db, close } = await createTestDb('libsql')
  onTestFinished(close)
  const config = { ...testConfig({ sinks: {}, access: { provider: { type: 'basic' as const }, admins: { emails: admins } } }), baseUrl: ORIGIN, admin: true }
  const deps = makeDeps(db, { config, env })
  await tick(deps, T0)
  return { db, deps, app: createApp(deps) }
}

/** Settings → Access → Change sign-in method → Email and password, with a new password. */
async function startPasswordSwitch(b: ReturnType<typeof browser>, password: string) {
  await b.get('/admin/access/method')
  await b.post('/admin/access/method', { method: 'basic' })
  await b.get('/admin/access/method')
  await b.post('/admin/access/method/settings', { password, confirm: password })
  return (await b.get('/admin/access/method')).body
}

describe('a password stored in the site takes precedence over BASIC_AUTH_USERS', () => {
  it('after "Change sign-in method" the new password signs in and the old env password is refused', async () => {
    const env = { BASIC_AUTH_USERS: JSON.stringify({ 'Admin@Example.test': await hashPassword('old-env-password-123') }) }
    const { db, deps, app } = await site(['admin@example.test'], env)
    const admin = browser(app)
    expect((await admin.post('/auth/login', { email: 'admin@example.test', password: 'old-env-password-123', next: '/admin' })).res.status).toBe(303)
    const page = await startPasswordSwitch(admin, 'brand-new-password-456')
    expect(page).toContain('Password saved')
    // The page says the env entry will be ignored and should be removed.
    expect(page).toContain('BASIC_AUTH_USERS still lists admin@example.test')
    const applied = await admin.post('/admin/access/method/apply', {})
    expect(applied.res.status).toBe(303)
    expect(applied.res.headers.get('location')).toBe('/admin/access?notice=method-changed-env')
    expect((await admin.get('/admin/access?notice=method-changed-env')).body).toContain('Remove it from the BASIC_AUTH_USERS secret')
    expect((await db.first<{ password_hash: string }>(`SELECT password_hash FROM local_users WHERE email = 'admin@example.test'`))?.password_hash).toMatch(/^pbkdf2-sha256:/)

    expect(await verifyPassword(deps, 'admin@example.test', 'brand-new-password-456')).not.toBeNull()
    expect(await verifyPassword(deps, 'admin@example.test', 'old-env-password-123')).toBeNull()
    const fresh = browser(app)
    expect((await fresh.post('/auth/login', { email: 'admin@example.test', password: 'old-env-password-123', next: '/admin' })).res.status).toBe(401)
    expect((await fresh.post('/auth/login', { email: 'admin@example.test', password: 'brand-new-password-456', next: '/admin' })).res.status).toBe(303)
  })

  it('the env entry still works for an address with no stored password', async () => {
    const env = { BASIC_AUTH_USERS: JSON.stringify({ 'admin@example.test': await hashPassword('admin-env-password'), 'other@example.test': await hashPassword('other-env-password') }) }
    const { db, deps } = await site(['admin@example.test', 'other@example.test'], env)
    await db.run(`INSERT INTO local_users (email, password_hash, created_at) VALUES ('admin@example.test', ?, 1)`, [await hashUserPassword('admin-stored-password')])
    expect(await verifyPassword(deps, 'other@example.test', 'other-env-password')).toMatchObject({ email: 'other@example.test', provider: 'basic' })
    expect(await verifyPassword(deps, 'OTHER@example.test ', 'other-env-password')).not.toBeNull()
    expect(await verifyPassword(deps, 'admin@example.test', 'admin-stored-password')).not.toBeNull()
    expect(await verifyPassword(deps, 'admin@example.test', 'admin-env-password')).toBeNull()
    expect(await verifyPassword(deps, 'nobody@example.test', 'admin-env-password')).toBeNull()
  })

  it('a stored password still works when BASIC_AUTH_USERS is not valid JSON', async () => {
    const { db, deps } = await site(['admin@example.test'], { BASIC_AUTH_USERS: '{not json' })
    await db.run(`INSERT INTO local_users (email, password_hash, created_at) VALUES ('admin@example.test', ?, 1)`, [await hashUserPassword('admin-stored-password')])
    expect(await verifyPassword(deps, 'admin@example.test', 'admin-stored-password')).not.toBeNull()
    expect(await verifyPassword(deps, 'other@example.test', 'anything-at-all')).toBeNull()
  })

  it('basicAuthUsersLists matches addresses case-insensitively and tolerates a bad secret', () => {
    const env = (v?: string) => (name: string) => (name === 'BASIC_AUTH_USERS' ? v : undefined)
    expect(basicAuthUsersLists(env(JSON.stringify({ 'A@Example.test': 'sha256:x:y' })), ' a@example.TEST')).toBe(true)
    expect(basicAuthUsersLists(env(JSON.stringify({ 'b@example.test': 'sha256:x:y' })), 'a@example.test')).toBe(false)
    expect(basicAuthUsersLists(env('{bad'), 'a@example.test')).toBe(false)
    expect(basicAuthUsersLists(env(undefined), 'a@example.test')).toBe(false)
  })

  it('POST /api/setup and the wizard\'s review warn when BASIC_AUTH_USERS lists the new administrator', async () => {
    const env = { STATUSPING_SETUP_TOKEN: 'SETUP-CODE-1234', BASIC_AUTH_USERS: JSON.stringify({ 'new@example.test': await hashPassword('env-password-12345') }) }
    const { db, deps, app } = await site(['admin@example.test'], env)
    await beginSetup(db, 'test', 2)
    await refreshAdminConfig(deps, 2)
    const res = await app.request(`${ORIGIN}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'SETUP-CODE-1234', admin: 'new@example.test', yaml: `title: T\nbaseUrl: ${ORIGIN}\ngroups: []\n` }) })
    expect(res.status).toBe(201)
    const body = await res.json() as { password: string; warning?: string }
    expect(body.warning).toContain('BASIC_AUTH_USERS still lists new@example.test')
    expect(await verifyPassword(deps, 'new@example.test', body.password)).not.toBeNull()
    expect(await verifyPassword(deps, 'new@example.test', 'env-password-12345')).toBeNull()

    // The wizard shows the same warning on its review step.
    await beginSetup(db, 'test', 3)
    await refreshAdminConfig(deps, 3)
    const b = browser(app)
    await b.post('/setup/claim', { code: 'SETUP-CODE-1234' })
    await b.get('/setup?step=method')
    await b.post('/setup/method', { method: 'basic' })
    await b.post('/setup/account', { email: 'new@example.test', password: 'wizard-password-123', confirm: 'wizard-password-123' })
    await b.post('/setup/basics', { title: 'Jobs', baseUrl: ORIGIN, timezone: 'UTC' })
    await b.post('/setup/monitor', { skip: '1' })
    await b.post('/setup/channel', { skip: '1' })
    const review = (await b.get('/setup?step=review')).body
    expect(review).toContain('Review and finish')
    expect(review).toContain('BASIC_AUTH_USERS still lists new@example.test')
    await b.post('/setup/finish', {})
    expect((await loadSetupState(db))?.status).toBe('complete')
    expect(await verifyPassword(deps, 'new@example.test', 'wizard-password-123')).not.toBeNull()
    expect(await verifyPassword(deps, 'new@example.test', 'env-password-12345')).toBeNull()

    // No warning for an address the secret does not list.
    await beginSetup(db, 'test', 4)
    await refreshAdminConfig(deps, 4)
    const quiet = await app.request(`${ORIGIN}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'SETUP-CODE-1234', admin: 'other@example.test', yaml: `title: T\nbaseUrl: ${ORIGIN}\ngroups: []\n` }) })
    expect(quiet.status).toBe(201)
    expect((await quiet.json() as { warning?: string }).warning).toBeUndefined()
  })

  it('`cli recover` sets a password that wins over the env entry, says the entry is ignored, and drops stored SSO credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'statusping-recover-'))
    const url = `file:${join(dir, 'recover.db')}`
    const client = createClient({ url })
    onTestFinished(() => client.close())
    const db = new LibsqlDb(client)
    await migrate(db)
    const stored = { title: 'T', baseUrl: ORIGIN, groups: [], admin: true, access: { provider: { type: 'basic' }, admins: { emails: ['admin@example.test'] } } }
    await db.run(`INSERT INTO admin_config (id, config_json, updated_at, updated_by) VALUES (1, ?, 1, 'x')`, [JSON.stringify(stored)])
    await db.run(`INSERT INTO instance_secrets (name, value, created_at) VALUES (?, 'old-client-secret', 1)`, [storedEnvKey('OIDC_CLIENT_SECRET')])
    const BASIC_AUTH_USERS = JSON.stringify({ 'admin@example.test': await hashPassword('old-env-password-123') })
    const { stdout } = await promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', 'cli/statusping.ts', 'recover', 'admin@example.test'], {
      cwd: join(import.meta.dirname, '..'), env: { ...process.env, TURSO_DATABASE_URL: url, BASIC_AUTH_USERS },
    })
    expect(stdout).toContain('BASIC_AUTH_USERS still lists admin@example.test')
    const password = /shown once\):\n\n {2}(\S+)/.exec(stdout)![1]!
    const deps = makeDeps(db, { config: { ...testConfig({ sinks: {}, access: { provider: { type: 'basic' }, admins: { emails: ['admin@example.test'] } } }), baseUrl: ORIGIN }, env: { BASIC_AUTH_USERS } })
    expect(await verifyPassword(deps, 'admin@example.test', password)).not.toBeNull()
    expect(await verifyPassword(deps, 'admin@example.test', 'old-env-password-123')).toBeNull()
    expect(await db.first(`SELECT name FROM instance_secrets WHERE name = ?`, [storedEnvKey('OIDC_CLIENT_SECRET')])).toBeNull()
  })
})

describe('a sign-in method change belongs to the administrator who started it', () => {
  async function twoAdmins() {
    const env = { BASIC_AUTH_USERS: JSON.stringify({ 'a@example.test': await hashPassword('a-password-123456'), 'b@example.test': await hashPassword('b-password-123456') }) }
    const s = await site(['a@example.test', 'b@example.test'], env)
    const a = browser(s.app), b = browser(s.app)
    await a.post('/auth/login', { email: 'a@example.test', password: 'a-password-123456', next: '/admin' })
    await b.post('/auth/login', { email: 'b@example.test', password: 'b-password-123456', next: '/admin' })
    return { ...s, a, b }
  }

  it('another administrator sees who started it and cannot change, test or apply it, or get a session as its owner', async () => {
    const { db, a, b } = await twoAdmins()
    expect(await startPasswordSwitch(b, 'b-new-password-123456')).toContain('Password saved')
    const draftBefore = (await db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = 'access_switch'`))!.value

    const page = await a.get('/admin/access/method')
    expect(page.res.status).toBe(200)
    expect(page.body).toContain('Started by <strong>b@example.test</strong>')
    expect(page.body).not.toContain('/admin/access/method/apply')
    expect(page.body).toContain('Cancel their change')

    const applied = await a.post('/admin/access/method/apply', {})
    expect(applied.res.status).toBe(409)
    expect(sessionEmail(a)).toBe('a@example.test')
    expect((await a.post('/admin/access/method/settings', { password: 'a-new-password-123456', confirm: 'a-new-password-123456' })).res.status).toBe(409)
    expect((await a.post('/admin/access/method', { method: 'basic' })).res.status).toBe(409)
    expect((await a.get('/admin/access/method/oidc/start')).res.status).toBe(409)
    // Nothing changed: the draft is B's as before, and no new password or method was stored.
    expect((await db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = 'access_switch'`))!.value).toBe(draftBefore)
    expect(await db.first(`SELECT email FROM local_users`)).toBeNull()
    expect(await db.first(`SELECT id FROM audit_log WHERE action = 'access.method-change'`)).toBeNull()

    // A cancels B's change and starts their own.
    expect((await a.post('/admin/access/method/cancel', {})).res.status).toBe(303)
    expect(await startPasswordSwitch(a, 'a-new-password-123456')).toContain('Password saved')
    expect((await a.post('/admin/access/method/apply', {})).res.status).toBe(303)
    expect(sessionEmail(a)).toBe('a@example.test')
    const audit = await db.first<{ actor: string; after_json: string }>(`SELECT actor, after_json FROM audit_log WHERE action = 'access.method-change'`)
    expect(audit?.actor).toBe('a@example.test')
    expect(JSON.parse(audit!.after_json)).toMatchObject({ method: 'basic', startedBy: 'a@example.test', verifiedEmail: 'a@example.test' })
  })

  it('the owner applies their own draft and stays signed in as themselves; the audit row names who started it', async () => {
    const { db, b, a } = await twoAdmins()
    await startPasswordSwitch(b, 'b-new-password-123456')
    expect((await b.post('/admin/access/method/apply', {})).res.status).toBe(303)
    expect(sessionEmail(b)).toBe('b@example.test')
    expect((await b.get('/admin/access')).res.status).toBe(200)
    expect((await a.get('/admin/access')).res.status).not.toBe(200)
    const audit = await db.first<{ after_json: string }>(`SELECT after_json FROM audit_log WHERE action = 'access.method-change'`)
    expect(JSON.parse(audit!.after_json)).toMatchObject({ startedBy: 'b@example.test' })
  })

  it('when the test sign-in was made as another address, applying signs the applier out instead of handing them that session', async () => {
    const { db, b } = await twoAdmins()
    await startPasswordSwitch(b, 'b-new-password-123456')
    // An SSO test sign-in can verify a different administrator's address than the one that started it.
    const row = (await db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = 'access_switch'`))!
    await db.run(`UPDATE instance_secrets SET value = ? WHERE name = 'access_switch'`, [JSON.stringify({ ...JSON.parse(row.value), verifiedEmail: 'a@example.test' })])
    expect((await b.get('/admin/access/method')).body).toContain('You are signed out too')
    const applied = await b.post('/admin/access/method/apply', {})
    expect(applied.res.status).toBe(303)
    expect(b.jar.has('sp_session')).toBe(false)
    expect(b.jar.has('sp_recover')).toBe(false)
    const next = await b.get(applied.res.headers.get('location')!)
    expect(next.res.status).toBe(302)
    expect(next.res.headers.get('location')).toMatch(/^\/auth\/login\?next=/)
  })

  it('a recovery session counts as the administrator it names', async () => {
    const env = { STATUSPING_RECOVERY_TOKEN: 'recovery-token-0123456789abcdefgh', BASIC_AUTH_USERS: JSON.stringify({ 'b@example.test': await hashPassword('b-password-123456') }) }
    const { app } = await site(['a@example.test', 'b@example.test'], env)
    const b = browser(app)
    await b.post('/auth/login', { email: 'b@example.test', password: 'b-password-123456', next: '/admin' })
    await startPasswordSwitch(b, 'b-new-password-123456')
    // A recovers (a break-glass session for a@example.test): B's draft is not theirs to apply.
    const r = browser(app)
    await r.post('/setup/recover', { token: env.STATUSPING_RECOVERY_TOKEN, email: 'a@example.test' })
    expect(r.jar.has('sp_recover')).toBe(true)
    const page = await r.get('/admin/access/method')
    expect(page.body).toContain('Started by <strong>b@example.test</strong>')
    expect((await r.post('/admin/access/method/apply', {})).res.status).toBe(409)
    // They can cancel it and switch themselves, ending up with a session as a@example.test.
    await r.post('/admin/access/method/cancel', {})
    expect(await startPasswordSwitch(r, 'a-new-password-123456')).toContain('Password saved')
    expect((await r.post('/admin/access/method/apply', {})).res.status).toBe(303)
    expect(r.jar.has('sp_recover')).toBe(false)
    expect(sessionEmail(r)).toBe('a@example.test')
  })
})

describe('switching drops stored sign-in credentials the new method does not use', () => {
  it('a switch from SSO to email and password deletes the stored client ID and secret', async () => {
    const env = { BASIC_AUTH_USERS: JSON.stringify({ 'admin@example.test': await hashPassword('old-env-password-123') }) }
    const { db, app } = await site(['admin@example.test'], env)
    for (const name of ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'CF_ACCESS_AUD']) {
      await db.run(`INSERT INTO instance_secrets (name, value, created_at) VALUES (?, 'stale', 1)`, [storedEnvKey(name)])
    }
    await db.run(`INSERT INTO instance_secrets (name, value, created_at) VALUES ('env:SINK_KEEP', 'kept', 1)`)
    const admin = browser(app)
    await admin.post('/auth/login', { email: 'admin@example.test', password: 'old-env-password-123', next: '/admin' })
    await startPasswordSwitch(admin, 'brand-new-password-456')
    expect((await admin.post('/admin/access/method/apply', {})).res.status).toBe(303)
    const left = (await db.all<{ name: string }>(`SELECT name FROM instance_secrets WHERE substr(name, 1, 4) = 'env:' ORDER BY name`)).map((r) => r.name)
    expect(left).toEqual(['env:SINK_KEEP'])
  })
})

describe('earlier findings stay fixed (round 19 probes)', () => {
  it('a ping URL created in the app stops working after a reset, and the same monitor id set up again does not revive it', async () => {
    const { db, deps, app } = await site(['admin@example.test'], { PING_TOKENS: '{}', STATUSPING_SETUP_TOKEN: 'SETUP-CODE-1234' })
    const token = (await rotatePingToken(db, 'heartbeat', 'admin@example.test', 1))!
    expect((await app.request(`${ORIGIN}/ping/${token}`)).status).toBe(200)
    await beginSetup(db, 'test', 2)
    await refreshAdminConfig(deps, 2)
    expect((await app.request(`${ORIGIN}/ping/${token}`)).status).toBe(503)
    const yaml = `title: T\nbaseUrl: ${ORIGIN}\ngroups:\n  - name: Jobs\n    monitors:\n      - id: heartbeat\n        kind: push\n        name: Heartbeat\n        period: 5m\n        grace: 2m\n`
    const res = await app.request(`${ORIGIN}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'SETUP-CODE-1234', admin: 'new@example.test', yaml }) })
    expect(res.status).toBe(201)
    expect((await res.json() as { pingUrlsNeeded: string[] }).pingUrlsNeeded).toEqual(['heartbeat'])
    expect((await app.request(`${ORIGIN}/ping/${token}`)).status).toBe(404)
    expect((await db.first<{ ping_token_hash: string | null }>(`SELECT ping_token_hash FROM monitors WHERE id = 'heartbeat'`))?.ping_token_hash).toBeNull()
  })

  it('epoch derivation: purposes never collide, and acknowledgement keys ignore the sign-in epoch', async () => {
    const { db, close } = await createTestDb('libsql')
    onTestFinished(close)
    const s = 'x'.repeat(40)
    expect(await epochKey(db, s, 'session')).toBe(s)
    expect(await epochKey(db, s, 'ack')).toBe(s)
    await db.batch([rotateSignInEpochStatement(1)])
    const session = await epochKey(db, s, 'session')
    const recovery = await epochKey(db, s, 'recovery')
    expect(session).not.toBe(s)
    expect(recovery).not.toBe(s)
    expect(session).not.toBe(recovery)
    expect(await epochKey(db, s, 'ack')).toBe(s)
  })
})
