import { afterEach, describe, expect, it } from 'vitest'
import { loadAdminConfig } from '../src/admin/service.ts'
import { createDeps, type Deps } from '../src/deps.ts'
import { loadSetupState } from '../src/setup/state.ts'
import { createApp } from '../src/web/app.ts'
import { createTestDb, type FetchCall, fakeFetch, testConfig } from './helpers.ts'

const ORIGIN = 'https://status.test'
const RESET_TOKEN = 'reset-token-0123456789abcdefghij'
const RECOVERY_TOKEN = 'recovery-token-0123456789abcdefgh'

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
    if (path === '/setup' && !init.method && res.status === 302) return send(res.headers.get('location')!, init)
    return { res, body: await res.text() }
  }
  return {
    jar,
    get: (path: string) => send(path),
    post: (path: string, fields: Record<string, string>) =>
      send(path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }),
  }
}

const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? ''

describe('setup wizard: alerts, import, unattended setup, and recovery', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => close?.())

  async function instance(env: Record<string, string> = {}) {
    const t = await createTestDb('libsql'); close = t.close
    const vars: Record<string, string> = { STATUSPING_RESET_TOKEN: RESET_TOKEN, ...env }
    const f = fakeFetch((call: FetchCall) => (call.url.includes('hooks.slack.test') ? new Response('ok') : new Response('ok')))
    const deps: Deps = createDeps({ db: t.db, config: testConfig(), getEnv: (n) => vars[n], fetch: f.fn, log: () => {} })
    const app = createApp(deps)
    await browser(app).post('/setup/reset', { token: RESET_TOKEN, confirm: 'reset' })
    return { app, db: t.db, deps, vars, calls: f.calls }
  }

  /** Claims the site and walks to the first optional step as the built-in owner. */
  async function toMonitorStep(app: ReturnType<typeof createApp>, db: Deps['db']) {
    const b = browser(app)
    await b.post('/setup/claim', { code: (await loadSetupState(db))!.code! })
    const csrf = csrfOf((await b.get('/setup')).body)
    await b.post('/setup/method', { csrf, method: 'basic' })
    const password = 'owner-password-0123'
    await b.post('/setup/account', { csrf, email: 'owner@example.test', password, confirm: password })
    await b.post('/setup/basics', { csrf, title: 'Acme', description: 'Service health for Acme', baseUrl: ORIGIN, timezone: 'UTC' })
    return { b, csrf, password }
  }

  it('sets up an alert channel, sends a test, and keeps its secret out of the draft', async () => {
    const { app, db, calls } = await instance()
    const { b, csrf } = await toMonitorStep(app, db)
    expect((await b.post('/setup/monitor', { csrf, skip: '1' })).res.status).toBe(303)
    const page = await b.get('/setup')
    expect(page.body).toContain('Where should alerts go?')
    expect((await b.get('/setup?step=channel&type=telegram')).body).toContain('name="botToken"')

    expect((await b.post('/setup/channel', { csrf, type: 'slack' })).body).toContain('Enter the webhook url.')
    expect((await b.post('/setup/channel', { csrf, type: 'slack', webhookUrl: 'https://hooks.slack.test/T0/B0/secret' })).res.status).toBe(303)
    const saved = await b.get('/setup?step=channel')
    expect(saved.body).toContain('Slack alerts are set up.')
    expect(saved.body).not.toContain('hooks.slack.test')
    expect(JSON.stringify((await loadSetupState(db))!.draft)).not.toContain('hooks.slack.test')

    const test = await b.post('/setup/channel/test', { csrf })
    expect(test.res.headers.get('location')).toBe('/setup?step=channel&tested=1')
    expect(calls.some((call) => call.url === 'https://hooks.slack.test/T0/B0/secret')).toBe(true)
    expect((await b.get('/setup?step=channel&tested=1')).body).toContain('Test alert sent.')

    await b.post('/setup/channel/done', { csrf })
    const review = await b.get('/setup')
    expect(review.body).toContain('<dt>Alerts</dt><dd>Slack (slack)</dd>')
    expect(review.body).toContain('<dt>Description</dt><dd>Service health for Acme</dd>')
    expect((await b.post('/setup/finish', { csrf })).res.status).toBe(303)
    const config = (await loadAdminConfig(db))!.config
    expect(config.sinks).toEqual({ slack: { type: 'slack', webhookUrl: { $env: 'SINK_SLACK_WEBHOOKURL' } } })
    expect(config.pages![0]).toMatchObject({ slug: 'status', description: 'Service health for Acme' })
    expect((await b.get('/')).body).toContain('Service health for Acme')
    expect((await b.get('/admin/channels/slack')).body).toContain('✓ Saved. Leave blank to keep it.')
  })

  it('imports a configuration, keeping the sign-in method and site basics from the wizard', async () => {
    const { app, db } = await instance()
    const { b, csrf } = await toMonitorStep(app, db)
    expect((await b.get('/setup?step=monitor')).body).toContain('href="/setup?step=import"')
    expect((await b.get('/setup?step=import')).body).toContain('Import a configuration')
    expect((await b.post('/setup/import', { csrf, config: 'title: x\nfoo: [1, 2\nbar: 3\n' })).body).toContain('YAML is invalid at line 3, column 1')

    const yaml = `title: Old site
baseUrl: https://old.example.test
access:
  provider: { type: oidc, issuer: https://idp.test, clientId: { $env: OIDC_CLIENT_ID }, clientSecret: { $env: OIDC_CLIENT_SECRET } }
  admins: { emails: [ops@example.test] }
sinks:
  hook: { type: webhook, url: { $env: HOOK_URL } }
groups:
  - name: Jobs
    monitors:
      - { id: nightly-backup, kind: push, name: Nightly backup, period: 1d }
  - name: Web
    monitors:
      - { id: api, kind: http, name: API, url: "https://api.example.test/health" }
pages:
  - { slug: status, title: Old site, monitors: ["*"] }
`
    const imported = await b.post('/setup/import', { csrf, config: yaml })
    expect(imported.res.headers.get('location')).toBe('/setup?step=import')
    expect((await b.get('/setup?step=import')).body).toContain('2 monitors, 1 status page, 1 alert channel')
    const review = await b.get('/setup')
    expect(review.body).toContain('Review and finish')
    expect(review.body).toContain('<dt>Imported configuration</dt><dd>2 monitors, 1 status page, 1 alert channel</dd>')

    const done = await b.post('/setup/finish', { csrf })
    expect(done.res.headers.get('location')).toBe('/admin/monitors?notice=setup-ping-urls')
    const config = (await loadAdminConfig(db))!.config
    expect(config).toMatchObject({ title: 'Acme', baseUrl: ORIGIN, access: { provider: { type: 'basic' }, admins: { emails: ['owner@example.test', 'ops@example.test'] } } })
    expect(config.groups!.flatMap((g) => g.monitors).map((m) => m.id)).toEqual(['nightly-backup', 'api'])
    const monitors = await b.get('/admin/monitors?notice=setup-ping-urls')
    expect(monitors.body).toContain('No ping URL yet')
  })

  it('completes setup in one call with POST /api/setup', async () => {
    const { app, db, deps } = await instance()
    const call = (body: unknown) => app.request(`${ORIGIN}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const yaml = `title: Scripted\nbaseUrl: ${ORIGIN}\ngroups: []\n`
    expect((await call({ code: 'AAAA-BBBB-CCCC', admin: 'owner@example.test', yaml })).status).toBe(401)
    const code = (await loadSetupState(db))!.code!
    expect((await call({ code, admin: 'not-an-email', yaml })).status).toBe(400)
    expect((await call({ code, admin: 'owner@example.test', yaml: 'title: [x' })).status).toBe(400)
    expect((await call({ code, admin: 'owner@example.test', yaml: `${yaml}access:\n  provider: { type: cloudflare-access, teamDomain: t.cloudflareaccess.com, audience: { $env: CF_ACCESS_AUD } }\n` })).status).toBe(400)

    const ok = await call({ code, admin: 'Owner@Example.test', yaml })
    expect(ok.status).toBe(201)
    const result = await ok.json() as { password: string; method: string; admin: string }
    expect(result).toMatchObject({ ok: true, admin: 'owner@example.test', method: 'basic' })
    expect(result.password).toMatch(/^[A-Za-z0-9]{24}$/)
    expect(deps.setupPending).toBe(false)
    expect((await loadAdminConfig(db))!.config).toMatchObject({ title: 'Scripted', access: { provider: { type: 'basic' }, admins: { emails: ['owner@example.test'] } } })

    const b = browser(app)
    await b.post('/auth/login', { email: 'owner@example.test', password: result.password, next: '/admin' })
    expect((await b.get('/admin')).res.status).toBe(200)
    expect((await call({ code, admin: 'owner@example.test', yaml })).status).toBe(404)
  })

  it('recovers access with STATUSPING_RECOVERY_TOKEN, limited to changing the sign-in method', async () => {
    const { app, db, vars } = await instance()
    const code = (await loadSetupState(db))!.code!
    await app.request(`${ORIGIN}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, admin: 'owner@example.test', yaml: `title: Acme\nbaseUrl: ${ORIGIN}\ngroups: []\n` }) })
    const b = browser(app)
    expect((await b.get('/setup/recover')).res.status).toBe(404)

    vars.STATUSPING_RECOVERY_TOKEN = RECOVERY_TOKEN
    expect((await b.get('/setup/recover')).body).toContain('Recover access to Settings')
    expect((await b.post('/setup/recover', { token: 'wrong', email: 'owner@example.test' })).res.status).toBe(401)
    expect((await b.post('/setup/recover', { token: RECOVERY_TOKEN, email: 'stranger@example.test' })).res.status).toBe(400)
    const ok = await b.post('/setup/recover', { token: RECOVERY_TOKEN, email: 'Owner@example.test' })
    expect(ok.res.headers.get('location')).toBe('/admin/access/method?notice=recovered')

    // Only the sign-in method can be changed.
    expect((await b.get('/admin')).res.headers.get('location')).toBe('/admin/access/method')
    expect((await b.get('/admin/configuration')).res.headers.get('location')).toBe('/admin/access/method')
    const choose = await b.get('/admin/access/method?notice=recovered')
    expect(choose.body).toContain('Recovery session started')
    await b.post('/admin/access/method', { csrf: csrfOf(choose.body), method: 'basic' })
    const configure = await b.get('/admin/access/method')
    const password = 'recovered-password-0123'
    await b.post('/admin/access/method/settings', { csrf: csrfOf(configure.body), password, confirm: password })
    const ready = await b.get('/admin/access/method')
    expect(ready.body).toContain('Password saved')
    expect((await b.post('/admin/access/method/apply', { csrf: csrfOf(ready.body) })).res.headers.get('location')).toBe('/admin/access?notice=method-changed')
    expect(b.jar.has('sp_recover')).toBe(false)
    expect((await b.get('/admin')).res.status).toBe(200)

    const fresh = browser(app)
    await fresh.post('/auth/login', { email: 'owner@example.test', password, next: '/admin' })
    expect((await fresh.get('/admin')).res.status).toBe(200)
    const audit = await db.all<{ action: string; actor: string }>(`SELECT action, actor FROM audit_log WHERE action = 'instance.recover'`)
    expect(audit).toEqual([{ action: 'instance.recover', actor: 'owner@example.test' }])
  })
})
