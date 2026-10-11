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
    // /setup redirects to the address of the current step, as a browser would follow.
    if (path === '/setup' && !init.method && res.status === 302) return send(res.headers.get('location')!, init)
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
    expect(home.res.status).toBe(302)
    expect(home.res.headers.get('location')).toBe('/setup')
    expect((await b.get('/admin')).res.headers.get('location')).toBe('/setup')
    expect((await b.get(`/ping/${TEST_TOKENS.heartbeat}`)).res.status).toBe(503)
    expect((await b.post('/auth/login', { email: 'x@example.test', password: 'x' })).res.status).toBe(503)
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
    expect((await b.post('/setup/method', { csrf, method: 'carrier-pigeon' })).res.status).toBe(400)
    expect((await b.post('/setup/method', { csrf, method: 'basic' })).res.status).toBe(303)

    // Account: the administrator chooses a password; errors re-render without echoing it.
    const password = 'correct horse battery staple'
    expect((await b.post('/setup/account', { csrf, email: 'not-an-email', password, confirm: password })).res.status).toBe(400)
    const short = await b.post('/setup/account', { csrf, email: 'Owner@Example.test', password: 'short-pw', confirm: 'short-pw' })
    expect(short.res.status).toBe(400)
    expect(short.body).toContain('at least 12 characters')
    expect(short.body).toContain('value="owner@example.test"')
    expect(short.body).not.toContain('short-pw')
    const mismatch = await b.post('/setup/account', { csrf, email: 'owner@example.test', password, confirm: `${password}!` })
    expect(mismatch.res.status).toBe(400)
    expect(mismatch.body).toContain('do not match')
    expect(mismatch.body).not.toContain(password)
    expect((await b.post('/setup/account', { csrf, email: 'owner@example.test', password: 'Owner@Example.test', confirm: 'Owner@Example.test' })).res.status).toBe(400)
    expect((await b.post('/setup/account', { csrf, email: 'owner@example.test', password: 'x'.repeat(257), confirm: 'x'.repeat(257) })).res.status).toBe(400)
    expect((await loadSetupState(db))!.draft.verified).toBeFalsy()
    const account = await b.post('/setup/account', { csrf, email: 'Owner@Example.test', password, confirm: password })
    expect(account.res.status).toBe(303)
    expect(account.res.headers.get('location')).toBe('/setup')
    const draft = (await loadSetupState(db))!.draft
    expect(draft).toMatchObject({ email: 'owner@example.test', verified: true })
    expect(draft.passwordHash).toMatch(/^pbkdf2-sha256:50000:[0-9a-f]{32}:[0-9a-f]{64}$/)

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
    expect(finish.res.headers.get('location')).toBe('/')
    expect(b.jar.has('sp_session')).toBe(true)
    const admin = await b.get('/admin')
    expect(admin.res.status).toBe(200)
    expect(admin.body).toContain('<span class="muted small account-email">owner@example.test</span>')
    expect(admin.body).toContain('value="Acme"')

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

  it('sets up a scheduled job, shows its ping URL once, and keeps the token across config changes', async () => {
    const { app, db, deps } = await instance({ STATUSPING_RESET_TOKEN: RESET_TOKEN })
    const b = browser(app)
    await b.post('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' })
    await b.post('/setup/claim', { code: (await loadSetupState(db))!.code! })
    const csrf = csrfOf((await b.get('/setup')).body)
    await b.post('/setup/method', { csrf, method: 'basic' })
    const password = 'owner-password-123'
    await b.post('/setup/account', { csrf, email: 'owner@example.test', password, confirm: password })
    await b.post('/setup/basics', { csrf, title: 'Jobs', baseUrl: ORIGIN, timezone: 'Europe/London' })

    // Each type has its own form; invalid input is explained.
    expect((await b.get('/setup?step=monitor&kind=tcp')).body).toContain('name="port"')
    expect((await b.post('/setup/monitor', { csrf, kind: 'tcp', name: 'DB', host: 'db.example.test', port: '70000' })).body).toContain('between 1 and 65535')
    expect((await b.post('/setup/monitor', { csrf, kind: 'push', name: 'Backup', schedule: 'not a cron' })).body).toContain('is not a valid cron schedule')
    expect((await b.post('/setup/monitor', { csrf, kind: 'push', name: 'Backup', period: '1d', schedule: '0 3 * * *' })).res.status).toBe(303)

    // The review is in plain words; the YAML is tucked away.
    const review = (await b.get('/setup')).body
    expect(review).toContain('<dt>First monitor</dt><dd>Backup: a scheduled job expected on the cron schedule 0 3 * * *</dd>')
    expect(review).toContain('<dt>Sign-in</dt><dd>Email and password</dd>')
    expect(review).toContain('<summary>Show as YAML</summary>')

    const done = await b.post('/setup/finish', { csrf })
    expect(done.res.status).toBe(200)
    const pingUrl = /<p class="secret">([^<]+)<\/p>/.exec(done.body)![1]!
    expect(pingUrl).toMatch(new RegExp(`^${ORIGIN}/ping/[A-Za-z0-9]{40}$`))
    expect(done.body).toContain(`curl -fsS ${pingUrl}`)
    const path = new URL(pingUrl).pathname
    expect((await b.get(path)).res.status).toBe(200)

    // A later config change (as the YAML admin would make) must not discard the generated token.
    const stored = JSON.parse((await db.first<{ config_json: string }>(`SELECT config_json FROM admin_config`))!.config_json)
    stored.groups[0].monitors[0].name = 'Nightly backup'
    await db.run(`UPDATE admin_config SET config_json = ? WHERE id = 1`, [JSON.stringify(stored)])
    await tick(deps, Date.parse('2026-10-11T00:05:00Z'))
    expect((await b.get(path)).res.status).toBe(200)
  })

  it('a second reset ends existing sessions and keeps the replaced configuration', async () => {
    const { app, db } = await instance({ STATUSPING_RESET_TOKEN: RESET_TOKEN })
    const b = browser(app)
    await b.post('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' })
    await b.post('/setup/claim', { code: (await loadSetupState(db))!.code! })
    const csrf = csrfOf((await b.get('/setup')).body)
    await b.post('/setup/method', { csrf, method: 'basic' })
    const password = 'first-owner-password'
    expect((await b.post('/setup/account', { csrf, email: 'owner@example.test', password, confirm: password })).res.status).toBe(303)
    await b.post('/setup/basics', { csrf, title: 'First', baseUrl: ORIGIN, timezone: 'UTC' })
    await b.post('/setup/monitor', { csrf, skip: '1' })
    await b.post('/setup/finish', { csrf })
    expect((await b.get('/admin')).res.status).toBe(200)
    // No monitors and no tick yet: there are no statuses to call out of date.
    const status = await b.get('/')
    expect(status.res.status).toBe(200)
    expect(status.body).not.toContain('Monitoring may be stalled')

    await browser(app).post('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' })
    expect((await b.get('/admin')).res.headers.get('location')).toBe('/setup')
    const row = await db.first<{ previous_config_json: string }>(`SELECT previous_config_json FROM setup_state WHERE id = 1`)
    expect(JSON.parse(row!.previous_config_json)).toMatchObject({ title: 'First' })
    expect(await db.first(`SELECT * FROM local_users`)).toBeNull()
    expect(await db.first(`SELECT * FROM admin_config`)).toBeNull()
  })
})
