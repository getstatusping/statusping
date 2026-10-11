import { afterEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/auth/providers.ts'
import { loadAdminConfig } from '../src/admin/service.ts'
import { parseAdminYaml, stringifyAdminYaml } from '../src/admin/yaml.ts'
import { createApp } from '../src/web/app.ts'
import { tick } from '../src/tick.ts'
import { APP_VERSION } from '../src/version.ts'
import { createTestDb, type FetchCall, fakeFetch, makeDeps, testConfig } from './helpers.ts'

const ORIGIN = 'https://status.test'

function browser(app: ReturnType<typeof createApp>) {
  const jar = new Map<string, string>()
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
    const res = await app.request(`${ORIGIN}${path}`, { ...init, headers })
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';')
      const [name, ...value] = pair!.split('=')
      jar.set(name!, value.join('='))
    }
    return { res, body: await res.text() }
  }
  let csrf = ''
  return {
    get: async (path: string) => {
      const r = await send(path)
      csrf = /name="csrf" value="([^"]+)"/.exec(r.body)?.[1] ?? csrf
      return r
    },
    post: (path: string, fields: Record<string, string | string[]>) => {
      const body = new URLSearchParams()
      for (const [key, value] of Object.entries({ csrf, ...fields })) for (const v of [value].flat()) body.append(key, v)
      return send(path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
    },
  }
}

describe('admin Settings pages', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => close?.())

  async function signedIn(handler?: (call: FetchCall) => Response) {
    const t = await createTestDb('libsql'); close = t.close
    const config = {
      ...testConfig({ sinks: {}, access: { provider: { type: 'basic' as const }, admins: { emails: ['admin@example.test', 'second@example.test'] } } }),
      baseUrl: ORIGIN, admin: true,
    }
    const users = { 'admin@example.test': await hashPassword('admin-password-123') }
    const f = fakeFetch(handler ?? (() => new Response('ok')))
    const deps = makeDeps(t.db, { config, env: { BASIC_AUTH_USERS: JSON.stringify(users) }, fetch: f.fn })
    await tick(deps, Date.parse('2026-10-11T00:00:00Z'))
    const app = createApp(deps)
    const b = browser(app)
    await b.post('/auth/login', { email: 'admin@example.test', password: 'admin-password-123', next: '/admin' })
    return { b, db: t.db, deps, calls: f.calls }
  }
  const stored = async (db: Parameters<typeof loadAdminConfig>[0]) => (await loadAdminConfig(db))!.config

  it('adds, edits, and deletes monitors, keeping pages consistent', async () => {
    const { b, db } = await signedIn()
    await b.get('/admin/monitors/new?kind=http')
    expect((await b.post('/admin/monitors/new', { kind: 'http', name: 'API', url: 'not a url' })).body).toContain('Enter a full http:// or https:// URL.')
    const added = await b.post('/admin/monitors/new', { kind: 'http', name: 'Public API', url: 'https://api.test/health', keyword: 'ok', interval: '5m', group: 'Web', alerts: 'all' })
    expect(added.res.headers.get('location')).toBe('/admin/monitors?notice=monitor-added')
    let config = await stored(db)
    expect(config.groups!.find((g) => g.name === 'Web')!.monitors.at(-1)).toEqual({ id: 'public-api', kind: 'http', name: 'Public API', url: 'https://api.test/health', keyword: 'ok', interval: '5m' })
    expect((await b.post('/admin/monitors/new', { kind: 'http', name: 'Public API', url: 'https://x.test' })).body).toContain('already exists')

    // Editing keeps fields the form does not show; a TCP monitor validates its port.
    await b.get('/admin/monitors/site')
    await b.post('/admin/monitors/site', { name: 'Main site', url: 'https://site.test/health', group: 'Web', alerts: 'none' })
    config = await stored(db)
    expect(config.groups!.flatMap((g) => g.monitors).find((m) => m.id === 'site')).toMatchObject({ name: 'Main site', notify: [] })
    expect((await b.post('/admin/monitors/new', { kind: 'tcp', name: 'DB', host: 'db.test', port: '99999' })).body).toContain('from 1 to 65535')

    // Pages referencing a deleted monitor are updated with it.
    await b.post('/admin/pages/new', { title: 'API status', visibility: 'public', show: 'some', monitors: ['public-api', 'site'] })
    await b.post('/admin/monitors/public-api/delete', {})
    config = await stored(db)
    expect(config.groups!.flatMap((g) => g.monitors).some((m) => m.id === 'public-api')).toBe(false)
    expect(config.pages!.find((p) => p.slug === 'api-status')!.monitors).toEqual(['site'])
  })

  it('adds a private page and can make it the home page', async () => {
    const { b, db } = await signedIn()
    await b.get('/admin/pages/new')
    expect((await b.post('/admin/pages/new', { title: 'Ops', visibility: 'private', emails: '', show: 'all' })).body).toContain('List at least one email')
    await b.post('/admin/pages/new', { title: 'Ops', visibility: 'private', emails: 'ops@example.test\n*@example.test', show: 'all' })
    expect((await b.get('/admin/pages')).body).toContain('action="/admin/pages/ops/home"')
    expect((await b.post('/admin/pages/ops/home', {})).res.headers.get('location')).toBe('/admin/pages?notice=home-saved')
    const config = await stored(db)
    expect(config.pages!.find((p) => p.slug === 'ops')).toEqual({ slug: 'ops', title: 'Ops', access: { emails: ['ops@example.test', '*@example.test'] }, monitors: ['*'] })
    expect(config.home).toBe('ops')
    expect((await b.get('/admin/pages')).body).toContain('/ops · home page (/)')
  })

  it('saves channel credentials write-only, uses them for tests, and erases them on delete', async () => {
    const { b, db, calls } = await signedIn()
    await b.get('/admin/channels/new?type=slack')
    expect((await b.post('/admin/channels/new', { type: 'slack', name: 'team', webhookUrl: '' })).body).toContain('Enter the webhook url.')
    expect((await b.post('/admin/channels/new', { type: 'slack', name: 'team', webhookUrl: 'https://hooks.slack.test/secret-path' })).res.headers.get('location')).toBe('/admin/channels?notice=channel-added')
    expect((await stored(db)).sinks!.team).toEqual({ type: 'slack', webhookUrl: { $env: 'SINK_TEAM_WEBHOOKURL' } })
    const edit = await b.get('/admin/channels/team')
    expect(edit.body).toContain('Saved. Leave blank to keep it.')
    expect(edit.body).not.toContain('secret-path')

    await b.post('/admin/sinks/team/test', {})
    expect(calls.map((c) => c.url)).toContain('https://hooks.slack.test/secret-path')
    // Saving with the secret left blank keeps it.
    await b.post('/admin/channels/team', { webhookUrl: '' })
    expect((await db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = 'env:SINK_TEAM_WEBHOOKURL'`))!.value).toBe('https://hooks.slack.test/secret-path')
    expect(JSON.stringify(await db.all(`SELECT * FROM audit_log`))).not.toContain('secret-path')

    await b.post('/admin/channels/team/delete', {})
    expect((await stored(db)).sinks?.team).toBeUndefined()
    expect(await db.first(`SELECT name FROM instance_secrets WHERE name LIKE 'env:SINK_TEAM%'`)).toBeNull()
  })

  it('refuses changes that lock the signed-in administrator out', async () => {
    const { b, db } = await signedIn()
    await b.get('/admin/access')
    expect((await b.post('/admin/access', { admins: 'second@example.test' })).body).toContain('remove your own access')
    expect((await stored(db)).access!.admins!.emails).toEqual(['admin@example.test', 'second@example.test'])
    expect((await b.post('/admin/access', { admins: 'admin@example.test' })).res.headers.get('location')).toBe('/admin/access?notice=admins-saved')
  })

  it('imports with a preview, keeps the sign-in method, and exports YAML from Configuration', async () => {
    const { b, db } = await signedIn()
    const exported = await b.get('/admin/export/statusping.yaml')
    expect(exported.res.headers.get('content-disposition')).toBe('attachment; filename="statusping.yaml"')
    expect(exported.body).toContain('title: Test Status')
    expect((await b.get('/admin/import')).res.headers.get('location')).toBe('/admin/configuration#import')
    await b.get('/admin/configuration')
    const edited = parseAdminYaml(exported.body) as Record<string, any>
    edited.title = 'Imported'
    edited.access.provider = { type: 'cloudflare-access', teamDomain: 'evil.cloudflareaccess.com', audience: { $env: 'EVIL_AUD' } }
    const yaml = stringifyAdminYaml(edited)
    const preview = await b.post('/admin/import', { config: yaml })
    expect(preview.body).toContain('Renames the site to &quot;Imported&quot;')
    expect(preview.body).toContain('Keeps the current sign-in method')
    expect((await stored(db)).title).toBe('Test Status')
    await b.post('/admin/import/apply', { config: yaml })
    const config = await stored(db)
    expect(config.title).toBe('Imported')
    expect(config.access!.provider).toEqual({ type: 'basic' })
    expect((await b.post('/admin/import', { config: 'title: [broken' })).body).toContain('YAML is invalid')
  })

  it('resets to the setup wizard from General, after a typed confirmation', async () => {
    const { b, db } = await signedIn()
    const general = await b.get('/admin')
    expect(general.body).toContain('Reset to the setup wizard')
    expect(general.body).not.toContain('href="/admin/reset"')
    expect((await b.post('/admin/reset', { confirm: 'nope' })).body).toContain('Type reset to confirm.')
    expect(await db.first(`SELECT status FROM setup_state`)).toBeNull()
    const reset = await b.post('/admin/reset', { confirm: 'reset' })
    expect(reset.res.headers.get('location')).toBe('/setup')
    expect(await db.first<{ status: string }>(`SELECT status FROM setup_state`)).toEqual({ status: 'pending' })
    expect((await db.all<{ action: string; actor: string }>(`SELECT action, actor FROM audit_log WHERE action = 'instance.reset'`))).toEqual([{ action: 'instance.reset', actor: 'admin@example.test' }])
    // Signed out and sent to setup.
    expect((await b.get('/admin')).res.headers.get('location')).toBe('/setup')
  })

  it('keeps the update-check switch under Software updates, separate from the site form', async () => {
    const { b, db } = await signedIn()
    const general = (await b.get('/admin')).body
    expect(general.indexOf('name="updates"')).toBeGreaterThan(general.indexOf('<h2>Software updates</h2>'))
    await b.post('/admin/updates', { updates: '1' })
    expect((await stored(db)).updates).toEqual({ enabled: true })
    // Saving the site details leaves update checks alone.
    await b.post('/admin/general', { title: 'Renamed', baseUrl: ORIGIN, timezone: 'UTC' })
    expect((await stored(db)).updates).toEqual({ enabled: true })
    await b.post('/admin/updates', {})
    expect((await stored(db)).updates).toBeUndefined()
  })

  it('shows a Settings link in the status page header to administrators only', async () => {
    const { b } = await signedIn()
    const home = (await b.get('/')).body
    expect(home).toContain('href="/admin">Settings</a>')
    expect(home).toContain(`StatusPing</a> <a class="muted" href="https://github.com/getstatusping/statusping/releases/tag/v${APP_VERSION}">v${APP_VERSION}</a>`)
    const t = await createTestDb('libsql')
    const anon = createApp(makeDeps(t.db, { config: { ...testConfig(), admin: true } }))
    expect(await (await anon.request('/')).text()).not.toContain('>Settings</a>')
    await t.close()
  })
})
