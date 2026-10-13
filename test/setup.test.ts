import { afterEach, describe, expect, it } from 'vitest'
import { createDeps, type Deps } from '../src/deps.ts'
import { beginSetup, loadSetupState } from '../src/setup/state.ts'
import { tick } from '../src/tick.ts'
import { createApp } from '../src/web/app.ts'
import { createTestDb, fakeFetch, TEST_TOKENS, testConfig } from './helpers.ts'
import { createApiToken } from '../src/mcp/tokens.ts'
import { hashPassword } from '../src/auth/providers.ts'
import { sign } from '../src/auth/session.ts'
import { epochKey, SECRET_EPOCH_NAME, secretEpoch } from '../src/auth/epoch.ts'
import { acknowledgeSecret, createAcknowledgeToken } from '../src/acknowledgements.ts'

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
    expect((await b.post('/setup/channel', { csrf, skip: '1' })).res.status).toBe(303)

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

  it('ignores a stale setup cookie from an earlier setup or an older version', async () => {
    const { app, db } = await instance({ STATUSPING_RESET_TOKEN: RESET_TOKEN })
    const b = browser(app)
    await b.post('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' })
    const claim = await b.post('/setup/claim', { code: (await loadSetupState(db))!.code! })
    // The claim also expires any copy scoped to /setup by older versions.
    expect(claim.res.headers.getSetCookie().some((c) => c.startsWith('sp_setup=;') && c.includes('Path=/setup'))).toBe(true)
    const valid = b.jar.get('sp_setup')!
    // Browsers send the more specific (stale) path first.
    const res = await app.request(`${ORIGIN}/setup`, { headers: { cookie: `sp_setup=stale.value; sp_setup=${valid}` } })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/^\/setup\?step=/)
  })

  it('keeps a generated code after repeated failures and honours STATUSPING_SETUP_TOKEN', async () => {
    const { app, db } = await instance({ STATUSPING_RESET_TOKEN: RESET_TOKEN })
    const b = browser(app)
    await b.post('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' })
    const first = (await loadSetupState(db))!.code
    // Wrong guesses must not let anyone invalidate the code the owner read from the logs.
    for (let i = 0; i < 3; i++) expect((await b.post('/setup/claim', { code: 'WRNG-WRNG-WRNG' })).res.status).toBe(401)
    expect((await loadSetupState(db))!).toMatchObject({ code: first, failedAttempts: 3 })

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
    expect((await b.post('/setup/channel', { csrf, skip: '1' })).res.status).toBe(303)

    // The review is in plain words; the YAML is tucked away.
    const review = (await b.get('/setup')).body
    expect(review).toContain('<dt>First monitor</dt><dd>Backup: a scheduled job expected on the cron schedule 0 3 * * *</dd>')
    expect(review).toContain('<dt>Sign-in</dt><dd>Email and password</dd>')
    expect(review).toContain('<summary>Show as YAML</summary>')

    const done = await b.post('/setup/finish', { csrf })
    expect(done.res.status).toBe(200)
    const pingUrl = /<p class="secret"[^>]*>([^<]+)<\/p>/.exec(done.body)![1]!
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
    await b.post('/setup/channel', { csrf, skip: '1' })
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

describe('reset clears stored sign-in and channel state', () => {
  it('removes stored settings, credential bindings and an unfinished sign-in method change', async () => {
    const t = await createTestDb('libsql')
    try {
      const keep = ['legacy_kept', 'environment']
      const gone = ['session_key', 'access_switch', 'env:SINK_ALERTS_TOKEN', 'bind:SINK_ALERTS_TOKEN', 'pending:OIDC_CLIENT_SECRET']
      for (const name of [...keep, ...gone, SECRET_EPOCH_NAME]) await t.db.run(`INSERT INTO instance_secrets (name, value, created_at) VALUES (?, 'v', 1)`, [name])
      await beginSetup(t.db, 'test', 100)
      const left = (await t.db.all<{ name: string }>(`SELECT name FROM instance_secrets ORDER BY name`)).map((r) => r.name)
      expect(left).toEqual([...keep, SECRET_EPOCH_NAME].sort())
      // The secret epoch is replaced, not kept.
      expect(await secretEpoch(t.db)).not.toBe('v')
    } finally {
      await t.close()
    }
  })
})

// ── Round 17: nothing issued before a reset works after it ──────────────────────────────────────

const OWNER_PASSWORD = 'owner-password-12345'

/** A configured site with email + password sign-in and the reset token set. */
async function configuredSite(env: Record<string, string> = {}, admin = 'owner@example.test') {
  const t = await createTestDb('libsql')
  const config = { ...testConfig({ sinks: {}, access: { provider: { type: 'basic' as const }, admins: { emails: [admin] } } }), baseUrl: ORIGIN, admin: true }
  // Tests change these while the site runs (a secret added or removed), so they are read live.
  const vars: Record<string, string> = { PING_TOKENS: JSON.stringify(TEST_TOKENS), STATUSPING_RESET_TOKEN: RESET_TOKEN, BASIC_AUTH_USERS: JSON.stringify({ [admin]: await hashPassword(OWNER_PASSWORD) }), ...env }
  const deps = createDeps({ db: t.db, config, getEnv: (n) => vars[n], fetch: fakeFetch().fn, log: () => {} })
  await tick(deps, Date.parse('2026-10-11T00:00:00Z'))
  return { ...t, deps, vars, app: createApp(deps) }
}

type Site = Awaited<ReturnType<typeof configuredSite>>

const resetSite = (site: Site) => browser(site.app).post('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' })

/** Finishes setup again through /api/setup (email + password for `admin`). */
async function setUpAgain(site: Site, admin: string) {
  const code = (await loadSetupState(site.db))!.code!
  const res = await site.app.request(`${ORIGIN}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, admin, yaml: `title: After reset\nbaseUrl: ${ORIGIN}\ngroups: []\n` }) })
  expect(res.status).toBe(201)
  return (await res.json()) as { password?: string }
}

describe('a reset revokes MCP access tokens (round 17, F1)', () => {
  let site: Site | undefined
  afterEach(async () => { await site?.close(); site = undefined })

  let id = 0
  const mcp = async (token: string, method: string, params: Record<string, unknown> = {}) => {
    const res = await site!.app.request(`${ORIGIN}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
    return { status: res.status, json: (await res.json().catch(() => null)) as any }
  }

  it('a token issued before a reset does not work for the next owner', async () => {
    site = await configuredSite({}, 'old-admin@example.test')
    const token = await createApiToken(site.db, 'old owner bot', ['read', 'settings', 'monitors'], 'old-admin@example.test', Math.floor(Date.now() / 1000))
    const before = await mcp(token, 'tools/list')
    expect(before.status).toBe(200)
    expect(before.json.result.tools.length).toBeGreaterThan(0)

    await resetSite(site)
    expect(await site.db.all(`SELECT * FROM api_tokens`)).toEqual([])
    expect((await mcp(token, 'tools/list')).status).not.toBe(200)

    await setUpAgain(site, 'new-owner@example.test')
    const after = await mcp(token, 'tools/list')
    expect(after.status).toBe(401)
    const take = await mcp(token, 'tools/call', { name: 'set_administrators', arguments: { emails: ['new-owner@example.test', 'attacker@evil.test'] } })
    expect(take.status).toBe(401)
    const stored = await site.db.first<{ config_json: string }>(`SELECT config_json FROM admin_config WHERE id = 1`)
    expect(stored!.config_json).not.toContain('attacker@evil.test')
  })

  it('a finished setup starts with no MCP tokens either', async () => {
    site = await configuredSite()
    await resetSite(site)
    // A token row that appears while setup is pending (a restored database, say) is not carried over.
    await createApiToken(site.db, 'restored', ['read'], 'someone@example.test', 1)
    await setUpAgain(site, 'owner@example.test')
    expect(await site.db.all(`SELECT * FROM api_tokens`)).toEqual([])
  })
})

describe('a reset signs everyone out, also with operator secrets set (round 17, F2)', () => {
  let site: Site | undefined
  afterEach(async () => { await site?.close(); site = undefined })

  const signIn = async (s: Site) => {
    const b = browser(s.app)
    expect((await b.post('/auth/login', { email: 'owner@example.test', password: OWNER_PASSWORD, next: '/admin' })).res.status).toBe(303)
    expect((await b.get('/admin')).res.status).toBe(200)
    return b
  }

  for (const withSecret of [true, false]) {
    it(`a session from before the reset does not open /admin after setup (SESSION_SECRET ${withSecret ? 'set' : 'unset'})`, async () => {
      site = await configuredSite(withSecret ? { SESSION_SECRET: 's'.repeat(40) } : {})
      const b = await signIn(site)
      await resetSite(site)
      const { password } = await setUpAgain(site, 'owner@example.test')
      expect((await b.get('/admin')).res.status).not.toBe(200)
      // The owner can sign in again with the new account.
      const fresh = browser(site.app)
      delete site.vars.BASIC_AUTH_USERS
      await fresh.post('/auth/login', { email: 'owner@example.test', password: password!, next: '/admin' })
      expect((await fresh.get('/admin')).res.status).toBe(200)
    })
  }

  it('without an epoch yet (upgraded site), sessions signed with SESSION_SECRET keep working until the first reset', async () => {
    const secret = 's'.repeat(40)
    site = await configuredSite({ SESSION_SECRET: secret })
    // Sites set up before this release have no epoch.
    await site.db.run(`DELETE FROM instance_secrets WHERE name = ?`, [SECRET_EPOCH_NAME])
    expect(await epochKey(site.db, secret, 'session')).toBe(secret)
    const legacy = await sign({ kind: 'session', email: 'owner@example.test', groups: [], provider: 'basic', exp: Math.floor(Date.now() / 1000) + 3600 }, secret)
    const open = () => site!.app.request(`${ORIGIN}/admin`, { headers: { cookie: `sp_session=${legacy}` } })
    expect((await open()).status).toBe(200)
    await resetSite(site)
    await setUpAgain(site, 'owner@example.test')
    expect(await secretEpoch(site.db)).toBeTruthy()
    expect((await open()).status).not.toBe(200)
  })

  it('a reset ends a recovery session signed with STATUSPING_RECOVERY_TOKEN', async () => {
    site = await configuredSite({ SESSION_SECRET: 's'.repeat(40) })
    // Recovery needs the browser admin, so start from a site set up in the wizard.
    await resetSite(site)
    await setUpAgain(site, 'owner@example.test')
    delete site.vars.BASIC_AUTH_USERS
    site.vars.STATUSPING_RECOVERY_TOKEN = 'recovery-token-0123456789abcdef'
    const b = browser(site.app)
    const ok = await b.post('/setup/recover', { token: site.vars.STATUSPING_RECOVERY_TOKEN, email: 'owner@example.test' })
    expect(ok.res.headers.get('location')).toBe('/admin/access/method?notice=recovered')
    expect((await b.get('/admin/access/method')).res.status).toBe(200)
    const recover = b.jar.get('sp_recover')!

    await resetSite(site)
    await setUpAgain(site, 'owner@example.test')
    const after = await site.app.request(`${ORIGIN}/admin/access/method`, { headers: { cookie: `sp_recover=${recover}` } })
    expect(after.status).not.toBe(200)
  })

  it('a reset ends acknowledgement links signed with ACK_SECRET', async () => {
    site = await configuredSite({ ACK_SECRET: 'ack-secret-0123456789abcdefghij' })
    const before = await createAcknowledgeToken(1, Math.floor(Date.now() / 1000), (await acknowledgeSecret(site.deps))!)
    await resetSite(site)
    await setUpAgain(site, 'owner@example.test')
    const after = await createAcknowledgeToken(1, Math.floor(Date.now() / 1000), (await acknowledgeSecret(site.deps))!)
    expect(after.split('.')[1]).not.toBe(before.split('.')[1])
    const res = await site.app.request(`${ORIGIN}/ack/${before}`)
    expect(res.status).toBe(404)
  })
})
