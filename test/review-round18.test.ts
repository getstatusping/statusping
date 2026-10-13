import { describe, expect, it, onTestFinished } from 'vitest'
import { rotatePingToken } from '../src/admin/service.ts'
import type { AdminConfig } from '../src/admin/security.ts'
import { epochKey, SECRET_EPOCH_NAME, SIGN_IN_EPOCH_NAME } from '../src/auth/epoch.ts'
import { hashPassword } from '../src/auth/providers.ts'
import { createDeps, type Deps } from '../src/deps.ts'
import { completeSetup } from '../src/setup/routes.ts'
import { beginSetup, loadSetupState } from '../src/setup/state.ts'
import { dispatchSubscriberOutbox, enqueueIncidentSubscribers, startSubscription } from '../src/subscribers.ts'
import { tick } from '../src/tick.ts'
import { hmacSha256Hex } from '../src/util/crypto.ts'
import { createApp } from '../src/web/app.ts'
import { createTestDb, DB_KINDS, fakeFetch, makeDeps, sec, testConfig } from './helpers.ts'

/** Round 18 security review: sign-in method changes end sessions, a reset revokes ping URLs, hardening. */

const ORIGIN = 'https://status.test'
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

const withCookie = async (app: App, path: string, cookie: string) => (await app.request(`${ORIGIN}${path}`, { headers: { cookie } })).status

/** Settings → Access → Change sign-in method → Email and password, with a new password, then Switch. */
async function switchToNewPassword(admin: ReturnType<typeof browser>) {
  await admin.get('/admin/access/method')
  await admin.post('/admin/access/method', { method: 'basic' })
  await admin.get('/admin/access/method')
  await admin.post('/admin/access/method/settings', { password: 'brand-new-password-456', confirm: 'brand-new-password-456' })
  const page = await admin.get('/admin/access/method')
  const applied = await admin.post('/admin/access/method/apply', {})
  return { page: page.body, applied: applied.res }
}

describe('changing the sign-in method ends existing sessions', () => {
  for (const withSecret of [true, false]) {
    it(`a same-type switch (new password) signs everyone else out and ends recovery sessions (SESSION_SECRET ${withSecret ? 'set' : 'unset'})`, async () => {
      const { db, close } = await createTestDb('libsql')
      onTestFinished(close)
      const config = { ...testConfig({ sinks: {}, access: { provider: { type: 'basic' as const }, admins: { emails: ['admin@example.test', 'other@example.test'] } } }), baseUrl: ORIGIN, admin: true }
      const env: Record<string, string> = {
        BASIC_AUTH_USERS: JSON.stringify({ 'admin@example.test': await hashPassword('admin-password-123'), 'other@example.test': await hashPassword('other-password-123') }),
        STATUSPING_RECOVERY_TOKEN: 'recovery-token-0123456789abcdefgh',
        ACK_SECRET: 'ack_test_secret_0123456789',
      }
      if (withSecret) env.SESSION_SECRET = 's'.repeat(40)
      const deps = makeDeps(db, { config, env })
      await tick(deps, Date.parse('2026-10-11T00:00:00Z'))
      const app = createApp(deps)

      const other = browser(app)
      await other.post('/auth/login', { email: 'other@example.test', password: 'other-password-123', next: '/admin' })
      const otherCookie = `sp_session=${other.jar.get('sp_session')}`
      expect(await withCookie(app, '/admin', otherCookie)).toBe(200)

      const recover = await app.request(`${ORIGIN}/setup/recover`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: env.STATUSPING_RECOVERY_TOKEN!, email: 'admin@example.test' }).toString() })
      const recoverCookie = recover.headers.getSetCookie().map((c) => c.split(';')[0]!).find((c) => c.startsWith('sp_recover='))!
      expect(await withCookie(app, '/admin/access/method', recoverCookie)).toBe(200)

      const admin = browser(app)
      await admin.post('/auth/login', { email: 'admin@example.test', password: 'admin-password-123', next: '/admin' })
      const adminOldCookie = `sp_session=${admin.jar.get('sp_session')}`
      const ackBefore = await epochKey(db, env.ACK_SECRET!, 'ack')

      const { page, applied } = await switchToNewPassword(admin)
      expect(page).toContain('Switching signs everyone out')
      expect(applied.status).toBe(303)
      expect(applied.headers.get('location')).toContain('/admin/access')

      expect(await withCookie(app, '/admin', otherCookie)).not.toBe(200)
      expect(await withCookie(app, '/admin', adminOldCookie)).not.toBe(200)
      expect(await withCookie(app, '/admin/access/method', recoverCookie)).not.toBe(200)
      // The administrator who switched was signed in again with the new key.
      expect(admin.jar.get('sp_session')).toBeTruthy()
      expect(`sp_session=${admin.jar.get('sp_session')}`).not.toBe(adminOldCookie)
      expect((await admin.get('/admin')).res.status).toBe(200)
      // Alert acknowledgement links are not sign-ins: a method change leaves them working.
      expect(await epochKey(db, env.ACK_SECRET!, 'ack')).toBe(ackBefore)
      expect(await db.first(`SELECT 1 FROM instance_secrets WHERE name = ?`, [SIGN_IN_EPOCH_NAME])).toBeTruthy()
    })
  }

  it('also on a site set up with the wizard (stored session key)', async () => {
    const { db, close } = await createTestDb('libsql')
    onTestFinished(close)
    const env: Record<string, string> = { BASIC_AUTH_USERS: JSON.stringify({ 'other@example.test': await hashPassword('other-password-123') }) }
    const deps = createDeps({ db, getEnv: (n) => env[n], fetch: fakeFetch().fn, log: () => {} })
    const app = createApp(deps)
    await app.request(`${ORIGIN}/healthz`)
    const code = (await loadSetupState(db))!.code!
    const yaml = `title: Acme\nbaseUrl: ${ORIGIN}\ngroups: []\naccess:\n  provider: { type: basic }\n  admins: { emails: [other@example.test] }\n`
    const done = await (await app.request(`${ORIGIN}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, admin: 'admin@example.test', yaml }) })).json() as { password: string }
    const keyBefore = (await db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = 'session_key'`))!.value

    const other = browser(app)
    await other.post('/auth/login', { email: 'other@example.test', password: 'other-password-123', next: '/admin' })
    const otherCookie = `sp_session=${other.jar.get('sp_session')}`
    expect(await withCookie(app, '/admin', otherCookie)).toBe(200)

    const admin = browser(app)
    await admin.post('/auth/login', { email: 'admin@example.test', password: done.password, next: '/admin' })
    const { applied } = await switchToNewPassword(admin)
    expect(applied.status).toBe(303)
    expect((await db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = 'session_key'`))!.value).not.toBe(keyBefore)
    expect(await withCookie(app, '/admin', otherCookie)).not.toBe(200)
    expect((await admin.get('/admin')).res.status).toBe(200)
    // The new password works for a fresh sign-in.
    const again = browser(app)
    await again.post('/auth/login', { email: 'admin@example.test', password: 'brand-new-password-456', next: '/admin' })
    expect((await again.get('/admin')).res.status).toBe(200)
    const audit = await db.all<{ action: string }>(`SELECT action FROM audit_log WHERE action = 'access.method-change'`)
    expect(audit).toHaveLength(1)
  })
})

describe('the sign-in epoch', () => {
  it('leaves keys exactly as before until a sign-in method change creates it, and never touches ack keys', async () => {
    const { db, close } = await createTestDb('libsql')
    onTestFinished(close)
    const secret = 'x'.repeat(40)
    expect(await epochKey(db, secret, 'session')).toBe(secret)
    await db.run(`INSERT INTO instance_secrets (name, value, created_at) VALUES (?, 'E', 1)`, [SECRET_EPOCH_NAME])
    // The 0.3.17 derivation, so upgrading signs nobody out.
    for (const purpose of ['session', 'recovery', 'ack'] as const) {
      expect(await epochKey(db, secret, purpose)).toBe(await hmacSha256Hex(secret, `statusping-epoch:${purpose}:E`))
    }
    await db.run(`INSERT INTO instance_secrets (name, value, created_at) VALUES (?, 'S', 1)`, [SIGN_IN_EPOCH_NAME])
    expect(await epochKey(db, secret, 'session')).not.toBe(await hmacSha256Hex(secret, 'statusping-epoch:session:E'))
    expect(await epochKey(db, secret, 'recovery')).not.toBe(await hmacSha256Hex(secret, 'statusping-epoch:recovery:E'))
    expect(await epochKey(db, secret, 'ack')).toBe(await hmacSha256Hex(secret, 'statusping-epoch:ack:E'))
    // A sign-in epoch alone (no reset yet) still changes session keys.
    await db.run(`DELETE FROM instance_secrets WHERE name = ?`, [SECRET_EPOCH_NAME])
    expect(await epochKey(db, secret, 'session')).not.toBe(secret)
    expect(await epochKey(db, secret, 'ack')).toBe(secret)
  })
})

describe('a reset revokes push monitor ping URLs', () => {
  it('a reused monitor id does not keep the old owner\'s ping URL', async () => {
    const RESET_TOKEN = 'reset-token-0123456789abcdefghij'
    const { db, close } = await createTestDb('libsql')
    onTestFinished(close)
    const config = {
      ...testConfig({ sinks: {}, access: { provider: { type: 'basic' as const }, admins: { emails: ['old-owner@example.test'] } } }),
      baseUrl: ORIGIN, admin: true,
      groups: [{ name: 'Jobs', monitors: [{ id: 'nightly', kind: 'push' as const, name: 'Nightly', period: '1d' }] }],
      pages: [{ slug: 'status', title: 'Status', access: 'public' as const, monitors: ['nightly'] }],
    }
    const deps = makeDeps(db, { config, env: { PING_TOKENS: '{}', STATUSPING_RESET_TOKEN: RESET_TOKEN, BASIC_AUTH_USERS: JSON.stringify({ 'old-owner@example.test': await hashPassword('old-password-12345') }) } })
    await tick(deps, Date.parse('2026-10-11T00:00:00Z'))
    const app = createApp(deps)
    const oldToken = (await rotatePingToken(db, 'nightly', 'old-owner@example.test', 1))!
    const ping = async () => (await app.request(`${ORIGIN}/ping/${oldToken}`, { headers: { 'cf-connecting-ip': '203.0.113.9' } })).status
    expect(await ping()).toBe(200)

    const reset = await app.request(`${ORIGIN}/setup/reset`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: RESET_TOKEN, confirm: 'reset' }).toString() })
    expect(reset.status).toBeLessThan(400)
    expect(await db.first(`SELECT 1 FROM monitors WHERE ping_token_hash IS NOT NULL`)).toBeNull()

    const code = (await loadSetupState(db))!.code!
    const yaml = `title: New owner\nbaseUrl: ${ORIGIN}\ngroups:\n  - name: Jobs\n    monitors:\n      - id: nightly\n        kind: push\n        name: Nightly\n        period: 1d\npages:\n  - slug: status\n    title: Status\n    access: public\n    monitors: [nightly]\n`
    const done = await app.request(`${ORIGIN}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, admin: 'new-owner@example.test', yaml }) })
    expect(done.status).toBe(201)
    const body = await done.json() as { password: string; pingUrlsNeeded?: string[] }
    expect(body.pingUrlsNeeded).toEqual(['nightly'])
    await tick(deps, Date.parse('2026-10-11T00:05:00Z'))
    expect((await db.first<{ ping_token_hash: string | null }>(`SELECT ping_token_hash FROM monitors WHERE id = 'nightly'`))!.ping_token_hash).toBeNull()
    expect(await ping()).not.toBe(200)

    // The new owner sees which jobs need a ping URL.
    const owner = browser(app)
    await owner.post('/auth/login', { email: 'new-owner@example.test', password: body.password, next: '/admin' })
    const monitors = await owner.get('/admin/monitors')
    expect(monitors.res.status).toBe(200)
    expect(monitors.body).toContain('No ping URL yet')
  })

  it('the reset card and page say so', async () => {
    const { db, close } = await createTestDb('libsql')
    onTestFinished(close)
    const app = createApp(makeDeps(db, { env: { STATUSPING_RESET_TOKEN: 'reset-token-0123456789abcdefghij' } }))
    expect(await (await app.request(`${ORIGIN}/setup/reset`)).text()).toContain('revokes the ping URLs of scheduled jobs')
  })
})

describe('subscriber email follows the page\'s current access', () => {
  const SUBSCRIBERS = { provider: 'resend' as const, apiKey: 're_test_key', from: 'Status <status@example.com>' }
  const base = (pageAccess: unknown) => testConfig({
    subscribers: SUBSCRIBERS,
    access: { provider: { type: 'basic' }, teams: { ops: { emails: ['*@ops.example'] } }, admins: { emails: ['admin@example.test'] } },
    pages: [{ slug: 'internal', title: 'Internal', monitors: ['heartbeat'], access: pageAccess as never }],
  })
  const seed = async (deps: Deps, emails: string[], now: number) => {
    for (const email of emails) await deps.db.run(`INSERT INTO subscribers (page_slug, email, confirmed_at, confirm_token_hash, unsubscribe_token_hash, created_at) VALUES ('internal', ?, ?, ?, ?, ?)`, [email, now, `c-${email}`, `u-${email}`, now])
  }
  const queued = async (deps: Deps) => (await deps.db.all<{ email: string }>(`SELECT s.email FROM subscriber_outbox o JOIN subscribers s ON s.id = o.subscriber_id ORDER BY s.email`)).map((r) => r.email)

  it('a restricted page queues mail only for addresses its access rules list (emails or team emails)', async () => {
    const { db, close } = await createTestDb('libsql')
    onTestFinished(close)
    const deps = makeDeps(db, { env: { SUBSCRIBER_TOKEN_SECRET: 'subscriber-token-secret' }, config: base({ emails: ['listed@example.test'], teams: ['ops'] }) })
    const now = sec('2026-10-12T12:00:00Z')
    await seed(deps, ['listed@example.test', 'alice@ops.example', 'outsider@example.test'], now)
    await db.run(`INSERT INTO incidents (monitor_id, reason, detail, started_at) VALUES ('heartbeat', 'missed', NULL, ?)`, [now])
    await enqueueIncidentSubscribers(deps, now)
    expect(await queued(deps)).toEqual(['alice@ops.example', 'listed@example.test'])
  })

  it('a page made private stops mailing its earlier public subscribers, and keeps them', async () => {
    const { db, close } = await createTestDb('libsql')
    onTestFinished(close)
    const fetch = fakeFetch()
    const now = sec('2026-10-12T12:00:00Z')
    const publicDeps = makeDeps(db, { fetch: fetch.fn, env: { SUBSCRIBER_TOKEN_SECRET: 'subscriber-token-secret' }, config: base('public') })
    await seed(publicDeps, ['anyone@example.test'], now)
    await db.run(`INSERT INTO incidents (monitor_id, reason, detail, started_at) VALUES ('heartbeat', 'missed', NULL, ?)`, [now])
    await enqueueIncidentSubscribers(publicDeps, now)
    expect(await queued(publicDeps)).toEqual(['anyone@example.test'])
    // The page becomes private before the queued message goes out: it is not sent.
    const privateDeps = makeDeps(db, { fetch: fetch.fn, env: { SUBSCRIBER_TOKEN_SECRET: 'subscriber-token-secret' }, config: base({ emails: ['listed@example.test'] }) })
    expect(await dispatchSubscriberOutbox(privateDeps, now + 60)).toBe(0)
    expect(fetch.calls).toHaveLength(0)
    await db.run(`DELETE FROM subscriber_outbox`)
    await enqueueIncidentSubscribers(privateDeps, now + 120)
    expect(await queued(privateDeps)).toEqual([])
    expect(await db.first(`SELECT 1 FROM subscribers WHERE email = 'anyone@example.test'`)).toBeTruthy()
  })

  it('an address the rules do not list cannot subscribe to a restricted page', async () => {
    const { db, close } = await createTestDb('libsql')
    onTestFinished(close)
    const fetch = fakeFetch()
    const deps = makeDeps(db, { fetch: fetch.fn, env: { SUBSCRIBER_TOKEN_SECRET: 'subscriber-token-secret' }, config: base({ emails: ['listed@example.test'] }) })
    expect(await startSubscription(deps, 'internal', 'outsider@example.test', 100)).toBe('not-allowed')
    expect(await startSubscription(deps, 'internal', 'nope@example.test', 100)).toBe('not-allowed')
    expect(await startSubscription(deps, 'missing-page', 'listed@example.test', 100)).toBe('not-allowed')
    expect(fetch.calls).toHaveLength(0)
    expect(await startSubscription(deps, 'internal', 'listed@example.test', 100)).toBe('sent')
  })

  it('a reset keeps subscribers', async () => {
    const { db, close } = await createTestDb('libsql')
    onTestFinished(close)
    const deps = makeDeps(db, { env: { SUBSCRIBER_TOKEN_SECRET: 'subscriber-token-secret' }, config: base('public') })
    await seed(deps, ['keep@example.test'], 1)
    await beginSetup(db, 'test', 100)
    expect(await db.first(`SELECT 1 FROM subscribers WHERE email = 'keep@example.test' AND confirmed_at IS NOT NULL`)).toBeTruthy()
  })
})

describe.each(DB_KINDS)('finishing setup twice writes once (%s)', (kind) => {
  it('two finishes that both read "pending" do not both write', async () => {
    const { db, close } = await createTestDb(kind)
    onTestFinished(close)
    const deps = makeDeps(db)
    await beginSetup(db, 'test', 100)
    const config = (email: string) => ({ ...testConfig({ sinks: {} }), admin: true, access: { provider: { type: 'basic' }, admins: { emails: [email] } } }) as AdminConfig
    const results = await Promise.all([
      completeSetup(deps, config('first@example.test'), { email: 'first@example.test', method: 'basic', passwordHash: 'h1' }, 200),
      completeSetup(deps, config('second@example.test'), { email: 'second@example.test', method: 'basic', passwordHash: 'h2' }, 200),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await db.all(`SELECT 1 FROM audit_log WHERE action = 'setup.complete'`)).toHaveLength(1)
    expect(await db.all(`SELECT 1 FROM local_users`)).toHaveLength(1)
    expect(await db.all(`SELECT 1 FROM config_revisions`)).toHaveLength(1)
    expect((await loadSetupState(db))!.status).toBe('complete')
    // A later finish is refused before it writes anything.
    expect(await completeSetup(deps, config('third@example.test'), { email: 'third@example.test', method: 'basic', passwordHash: 'h3' }, 300)).toBe(false)
    expect(await db.all(`SELECT 1 FROM local_users`)).toHaveLength(1)
  })
})
