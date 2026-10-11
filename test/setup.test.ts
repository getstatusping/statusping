import { afterEach, describe, expect, it } from 'vitest'
import { createDeps, type Deps } from '../src/deps.ts'
import { loadSetupState } from '../src/setup/state.ts'
import { tick } from '../src/tick.ts'
import { createApp } from '../src/web/app.ts'
import { createTestDb, fakeFetch, TEST_TOKENS, testConfig } from './helpers.ts'

const ORIGIN = 'https://status.test'
const RESET_TOKEN = 'reset-token-0123456789abcdefghij'

/** A tiny browser: keeps cookies and sends same-origin form posts. */
function browser(app: ReturnType<typeof createApp>) {
  const jar = new Map<string, string>()
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
    const res = await app.request(`${ORIGIN}${path}`, { ...init, headers })
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';')
      const [name, ...value] = pair!.split('=')
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(cookie) || value.join('=') === '') jar.delete(name!)
      else jar.set(name!, value.join('='))
    }
    return { res, body: await res.text() }
  }
  return {
    jar,
    get: (path: string) => send(path),
    post: (path: string, fields: Record<string, string>, origin = ORIGIN) =>
      send(path, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }),
  }
}

const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? ''
const passwordOf = (html: string) => /<p class="secret">([^<]+)<\/p>/.exec(html)?.[1] ?? ''

describe('first-run setup wizard and reset', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => close?.())

  async function instance(env: Record<string, string> = {}) {
    const t = await createTestDb('libsql'); close = t.close
    const logs: string[] = []
    const vars: Record<string, string> = { PING_TOKENS: JSON.stringify(TEST_TOKENS), ...env }
    const deps: Deps = createDeps({ db: t.db, config: testConfig(), getEnv: (n) => vars[n], fetch: fakeFetch(() => new Response('ok')).fn, log: (_level, message) => logs.push(message) })
    return { db: t.db, deps, logs, app: createApp(deps) }
  }

  it('leaves config-as-code installs alone and hides reset without its secret', async () => {
    const { app } = await instance()
    const b = browser(app)
    expect((await b.get('/setup')).res.status).toBe(404)
    expect((await b.get('/setup/reset')).res.status).toBe(404)
    expect((await b.post('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' })).res.status).toBe(404)
    expect(await (await app.request(`${ORIGIN}/healthz`)).json()).not.toHaveProperty('setup')
  })

  it('resets to setup mode, pauses checks, and walks the wizard to a signed-in admin', async () => {
    const { app, db, deps, logs } = await instance({ STATUSPING_RESET_TOKEN: RESET_TOKEN })
    const b = browser(app)

    // Reset needs the token, the typed confirmation, and a same-origin post.
    expect((await b.post('/setup/reset', { token: 'wrong', confirm: 'reset' })).res.status).toBe(401)
    expect((await b.post('/setup/reset', { token: RESET_TOKEN, confirm: 'nope' })).res.status).toBe(400)
    expect((await b.post('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' }, 'https://evil.test')).res.status).toBe(403)
    const reset = await b.post('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' })
    expect(reset.res.status).toBe(303)
    expect(reset.res.headers.get('location')).toBe('/setup')

    // Setup mode: public routes show the setup page, /healthz stays 200, ticks run no checks.
    const home = await b.get('/')
    expect(home.res.status).toBe(503)
    expect(home.body).toContain('This StatusPing site is being set up')
    expect((await b.get(`/ping/${TEST_TOKENS.heartbeat}`)).res.status).toBe(503)
    expect(await (await app.request(`${ORIGIN}/healthz`)).json()).toMatchObject({ ok: true, setup: 'required' })
    const summary = await tick(deps, Date.parse('2026-10-11T00:00:00Z'))
    expect(summary.checks).toBe(0)
    const code = (await loadSetupState(db))!.code!
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(logs.some((line) => line === `Setup code: ${code}. Open /setup on this site to finish setup.`)).toBe(true)
    expect(logs.some((line) => line.includes(`Setup code: ${code}.`) && line.includes(`${ORIGIN}/setup`))).toBe(true)

    // Claim.
    expect((await b.get('/setup')).body).toContain('Claim this StatusPing site')
    expect((await b.post('/setup/claim', { code: 'AAAA-BBBB-CCCC' })).res.status).toBe(401)
    expect((await b.post('/setup/claim', { code: code.toLowerCase().replace(/-/g, ' ') })).res.status).toBe(303)
    const method = await b.get('/setup')
    expect(method.body).toContain('How will administrators sign in?')
    const csrf = csrfOf(method.body)
    expect(csrf).toHaveLength(32)

    // Every wizard form needs the CSRF value; a method must be chosen.
    expect((await b.post('/setup/method', { csrf: 'x'.repeat(32), method: 'basic' })).res.status).toBe(403)
    expect((await b.post('/setup/method', { csrf, method: 'oidc' })).res.status).toBe(400)
    expect((await b.post('/setup/method', { csrf, method: 'basic' })).res.status).toBe(303)

    // Account: the generated password is shown once and must be typed back.
    expect((await b.post('/setup/account', { csrf, email: 'not-an-email' })).res.status).toBe(400)
    const account = await b.post('/setup/account', { csrf, email: 'Owner@Example.test' })
    const password = passwordOf(account.body)
    expect(password).toHaveLength(24)
    expect((await b.get('/setup')).body).not.toContain(password)
    expect((await b.post('/setup/verify', { csrf, password: 'wrong' })).res.status).toBe(401)
    expect((await b.post('/setup/verify', { csrf, password })).res.status).toBe(303)

    // Basics and monitor.
    expect((await b.post('/setup/basics', { csrf, title: 'Acme', baseUrl: 'http://status.example.com', timezone: 'UTC' })).res.status).toBe(400)
    expect((await b.post('/setup/basics', { csrf, title: 'Acme', baseUrl: ORIGIN, timezone: 'Mars/Base' })).res.status).toBe(400)
    expect((await b.post('/setup/basics', { csrf, title: 'Acme', baseUrl: `${ORIGIN}/`, timezone: 'Europe/London', updates: '1' })).res.status).toBe(303)
    expect((await b.post('/setup/monitor', { csrf, name: 'Site', url: 'ftp://x' })).res.status).toBe(400)
    expect((await b.post('/setup/monitor', { csrf, name: 'Site', url: 'https://site.test/health' })).res.status).toBe(303)

    // Review shows the YAML, without the password or its hash.
    const review = await b.get('/setup')
    expect(review.body).toContain('Review and finish')
    expect(review.body).toContain('owner@example.test')
    expect(review.body).toContain('https://site.test/health')
    expect(review.body).not.toContain('sha256:')

    // Finish signs the owner in and ends setup mode.
    const finish = await b.post('/setup/finish', { csrf })
    expect(finish.res.status).toBe(303)
    expect(finish.res.headers.get('location')).toMatch(/^\/admin\?message=/)
    expect(b.jar.has('sp_session')).toBe(true)
    const admin = await b.get('/admin?message=Setup%20is%20complete.')
    expect(admin.res.status).toBe(200)
    expect(admin.body).toContain('Signed in as owner@example.test')
    expect(admin.body).toContain('title: Acme')

    expect((await b.get('/setup')).res.status).toBe(404)
    expect((await b.post('/setup/finish', { csrf })).res.status).toBe(404)
    expect(await (await app.request(`${ORIGIN}/healthz`)).json()).not.toHaveProperty('setup')
    expect((await loadSetupState(db))).toMatchObject({ status: 'complete', code: null, sessionKey: null, draft: {} })
    const audit = await db.all<{ action: string; actor: string }>(`SELECT action, actor FROM audit_log ORDER BY id`)
    expect(audit.map((row) => row.action)).toEqual(['instance.reset', 'setup.complete'])

    // The wizard's account signs in through the normal form, and checks run again.
    const other = browser(app)
    expect((await other.post('/auth/login', { email: 'owner@example.test', password: 'wrong', next: '/admin' })).res.status).toBe(401)
    expect((await other.post('/auth/login', { email: 'owner@example.test', password, next: '/admin' })).res.status).toBe(303)
    expect((await other.get('/admin')).res.status).toBe(200)
    expect((await tick(deps, Date.parse('2026-10-11T00:05:00Z'))).checks).toBe(1)
  })

  it('replaces a generated code after repeated failures and honours STATUSPING_SETUP_TOKEN', async () => {
    const { app, db } = await instance({ STATUSPING_RESET_TOKEN: RESET_TOKEN })
    const b = browser(app)
    await b.post('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' })
    const first = (await loadSetupState(db))!.code
    for (let i = 0; i < 10; i++) await b.post('/setup/claim', { code: 'WRNG-WRNG-WRNG' })
    expect((await loadSetupState(db))!.code).not.toBe(first)

    const env = await instance({ STATUSPING_RESET_TOKEN: RESET_TOKEN, STATUSPING_SETUP_TOKEN: 'my-own-setup-token' })
    const c = browser(env.app)
    await c.post('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' })
    expect((await c.get('/setup')).body).toContain('STATUSPING_SETUP_TOKEN')
    expect((await c.post('/setup/claim', { code: (await loadSetupState(env.db))!.code! })).res.status).toBe(401)
    expect((await c.post('/setup/claim', { code: 'my-own-setup-token' })).res.status).toBe(303)
  })

  it('a second reset ends existing sessions and keeps the replaced configuration', async () => {
    const { app, db } = await instance({ STATUSPING_RESET_TOKEN: RESET_TOKEN })
    const b = browser(app)
    await b.post('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' })
    await b.post('/setup/claim', { code: (await loadSetupState(db))!.code! })
    const csrf = csrfOf((await b.get('/setup')).body)
    await b.post('/setup/method', { csrf, method: 'basic' })
    const password = passwordOf((await b.post('/setup/account', { csrf, email: 'owner@example.test' })).body)
    await b.post('/setup/verify', { csrf, password })
    await b.post('/setup/basics', { csrf, title: 'First', baseUrl: ORIGIN, timezone: 'UTC' })
    await b.post('/setup/monitor', { csrf, skip: '1' })
    await b.post('/setup/finish', { csrf })
    expect((await b.get('/admin')).res.status).toBe(200)

    await browser(app).post('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' })
    expect((await b.get('/admin')).res.status).toBe(503)
    const row = await db.first<{ previous_config_json: string }>(`SELECT previous_config_json FROM setup_state WHERE id = 1`)
    expect(JSON.parse(row!.previous_config_json)).toMatchObject({ title: 'First' })
    expect(await db.first(`SELECT * FROM local_users`)).toBeNull()
    expect(await db.first(`SELECT * FROM admin_config`)).toBeNull()
  })
})
