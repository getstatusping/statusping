import { afterEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/auth/providers.ts'
import { configSchema, configSchemaJson } from '../src/admin/config-schema.ts'
import { lineDiff, withContext } from '../src/admin/diff.ts'
import { currentRevision, KEEP_REVISIONS, listRevisions, loadAdminConfig, saveAdminConfig, seedAdminConfig } from '../src/admin/service.ts'
import { refreshAdminConfig } from '../src/deps.ts'
import { createSink } from '../src/notify/sinks.ts'
import { syncConfig } from '../src/sync.ts'
import { tick } from '../src/tick.ts'
import { createApp } from '../src/web/app.ts'
import { createTestDb, fakeFetch, makeDeps, testConfig } from './helpers.ts'
import { readFileSync } from 'node:fs'

const ORIGIN = 'https://status.test'
const ADMIN_TOKEN = 'admin-token-0123456789abcdefghijkl'

/** A browser that keeps cookies and echoes the CSRF and revision values of the last page it loaded. */
function browser(app: ReturnType<typeof createApp>, origin = ORIGIN) {
  const jar = new Map<string, string>()
  let hidden: Record<string, string> = {}
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
    const res = await app.request(`${origin}${path}`, { ...init, headers })
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';')
      const [name, ...value] = pair!.split('=')
      jar.set(name!, value.join('='))
    }
    const body = await res.text()
    const csrf = /name="csrf" value="([^"]+)"/.exec(body)?.[1]
    if (csrf) hidden = { csrf, revision: /name="revision" value="(\d+)"/.exec(body)?.[1] ?? '' }
    return { res, body }
  }
  return {
    jar,
    get hidden() { return hidden },
    get: (path: string) => send(path),
    post: (path: string, fields: Record<string, string | string[]>, keep = hidden) => {
      const body = new URLSearchParams()
      for (const [key, value] of Object.entries({ ...keep, ...fields })) for (const v of [value].flat()) body.append(key, v)
      return send(path, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
    },
  }
}

describe('configuration revisions, concurrency, and the YAML API', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => close?.())

  async function site(env: Record<string, string> = {}) {
    const t = await createTestDb('libsql'); close = t.close
    const config = {
      ...testConfig({ sinks: {}, access: { provider: { type: 'basic' as const }, admins: { emails: ['admin@example.test', 'second@example.test'] } } }),
      baseUrl: ORIGIN, admin: true,
    }
    const users = { 'admin@example.test': await hashPassword('admin-password-123'), 'second@example.test': await hashPassword('second-password-123') }
    const f = fakeFetch(() => new Response('ok'))
    const deps = makeDeps(t.db, { config, env: { BASIC_AUTH_USERS: JSON.stringify(users), ADMIN_TOKEN, ...env }, fetch: f.fn })
    await tick(deps, Date.parse('2026-10-11T00:00:00Z'))
    const app = createApp(deps)
    const signIn = async (email: string, password: string, origin = ORIGIN) => {
      const b = browser(app, origin)
      await b.post('/auth/login', { email, password, next: '/admin' })
      return b
    }
    return { app, db: t.db, deps, calls: f.calls, signIn }
  }

  it('keeps a history with diffs, and restores an earlier version without touching sign-in', async () => {
    const { db, signIn } = await site()
    const b = await signIn('admin@example.test', 'admin-password-123')
    // The configuration seeded from config-as-code is version 1.
    expect(await currentRevision(db)).toBe(1)
    await b.get('/admin')
    expect(b.hidden.revision).toBe('1')
    expect((await b.post('/admin/general', { title: 'Renamed', baseUrl: ORIGIN, timezone: 'UTC' })).res.status).toBe(303)
    expect(await currentRevision(db)).toBe(2)
    expect((await listRevisions(db)).map((r) => [r.id, r.action, r.actor])).toEqual([[2, 'config.save', 'admin@example.test'], [1, 'config.seed', 'config-seed']])

    const history = await b.get('/admin/configuration')
    expect(history.body).toContain('Version 2')
    expect(history.body).toContain('First configuration')
    const compare = await b.get('/admin/configuration/revisions/1')
    expect(compare.body).toContain('<span class="del">- title: Test Status</span>')
    expect(compare.body).toContain('<span class="add">+ title: Renamed</span>')

    const restored = await b.post('/admin/configuration/revisions/1/restore', {})
    expect(restored.res.headers.get('location')).toBe('/admin/configuration?notice=restored')
    const config = (await loadAdminConfig(db))!.config
    expect(config.title).toBe('Test Status')
    expect(config.access?.provider).toEqual({ type: 'basic' })
    expect((await listRevisions(db))[0]).toMatchObject({ id: 3, action: 'config.restore' })
    expect((await b.get('/admin/activity')).body).toContain('config.restore')
  })

  it('records an existing configuration as version 1 before the first change', async () => {
    const { db, deps } = await site()
    await db.run(`DELETE FROM config_revisions`)
    await refreshAdminConfig(deps, 10)
    expect(await listRevisions(db)).toEqual([expect.objectContaining({ id: 1, action: 'config.baseline' })])
    expect(deps.configRevision).toBe(1)
  })

  it('keeps only the newest revisions', async () => {
    const t = await createTestDb('libsql'); close = t.close
    const config = { ...testConfig({ sinks: {} }), admin: true }
    await seedAdminConfig(t.db, config, 'seed', 1)
    for (let i = 0; i < KEEP_REVISIONS + 5; i++) await saveAdminConfig(t.db, { ...config, title: `T${i}` }, 'a@example.test', 10 + i, () => undefined)
    const list = await listRevisions(t.db)
    expect(list).toHaveLength(KEEP_REVISIONS)
    expect(list[0]!.id).toBe(KEEP_REVISIONS + 6)
  })

  it('refuses a save over a newer revision, then saves when submitted again', async () => {
    const { db, signIn } = await site()
    const first = await signIn('admin@example.test', 'admin-password-123')
    const second = await signIn('second@example.test', 'second-password-123')
    await first.get('/admin/monitors/site')
    await second.get('/admin/monitors/site')
    const stale = second.hidden
    expect((await first.post('/admin/monitors/site', { name: 'First edit', url: 'https://site.test/health', group: 'Web', alerts: 'all' })).res.status).toBe(303)

    const conflict = await second.post('/admin/monitors/site', { name: 'Second edit', url: 'https://site.test/health', group: 'Web', alerts: 'all' }, stale)
    expect(conflict.res.status).toBe(400)
    expect(conflict.body).toContain('Someone else changed the configuration after you opened this page')
    expect(conflict.body).toContain('value="Second edit"')
    const monitor = () => loadAdminConfig(db).then((c) => c!.config.groups!.flatMap((g) => g.monitors).find((m) => m.id === 'site')!)
    expect((await monitor()).name).toBe('First edit')

    // The re-rendered form carries the newest revision, so saving again is a deliberate overwrite.
    expect(second.hidden.revision).toBe(String(await currentRevision(db)))
    expect((await second.post('/admin/monitors/site', { name: 'Second edit', url: 'https://site.test/health', group: 'Web', alerts: 'all' })).res.status).toBe(303)
    expect((await monitor()).name).toBe('Second edit')
  })

  it('serves YAML with an ETag and honours If-Match on PUT', async () => {
    const { app, db, deps } = await site()
    const auth = { authorization: `Bearer ${ADMIN_TOKEN}` }
    const got = await app.request(`${ORIGIN}/api/admin/config`, { headers: { ...auth, accept: 'application/yaml' } })
    expect(got.headers.get('content-type')).toContain('application/yaml')
    expect(got.headers.get('etag')).toBe('"1"')
    const yaml = await got.text()
    expect(yaml.startsWith(`# yaml-language-server: $schema=${ORIGIN}/admin/schema.json\n`)).toBe(true)

    const edited = yaml.replace('title: Test Status', '# Shown in the header\ntitle: From YAML')
    const put = (body: string, ifMatch?: string) => app.request(`${ORIGIN}/api/admin/config`, { method: 'PUT', body, headers: { ...auth, 'content-type': 'application/yaml', ...(ifMatch ? { 'if-match': ifMatch } : {}) } })
    const ok = await put(edited, '"1"')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('etag')).toBe('"2"')
    expect((await put(edited, '"1"')).status).toBe(412)
    expect(deps.config.title).toBe('From YAML')

    // The text, comments included, round-trips through export.
    const again = await (await app.request(`${ORIGIN}/api/admin/config?format=yaml`, { headers: auth })).text()
    expect(again).toContain('# Shown in the header\ntitle: From YAML')
    expect((await listRevisions(db))[0]).toMatchObject({ id: 2, action: 'config.api' })

    // Errors name the line.
    const bad = await put(edited.replace('url: https://site.test/health', 'url: https://user:pw@site.test/health'))
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toMatch(/Line \d+: groups\.1\.monitors\.0\.url: contains a credential/)
    const json = await app.request(`${ORIGIN}/api/admin/config`, { headers: auth })
    expect(await json.json()).toMatchObject({ revision: 2, config: { title: 'From YAML' } })
  })

  it('shows every $env name with its status, serves the schema, and warns about a different address', async () => {
    const { app, signIn } = await site({ HOOK_URL: 'https://hooks.test/x' })
    const b = await signIn('admin@example.test', 'admin-password-123')
    const yaml = `title: Test Status\nbaseUrl: ${ORIGIN}\naccess:\n  provider: { type: basic }\n  admins: { emails: [admin@example.test] }\nsinks:\n  hook:\n    type: webhook\n    url: { $env: HOOK_URL }\n    headers:\n      Authorization: { $env: HOOK_AUTH }\ngroups:\n  - name: Web\n    monitors:\n      - { id: site, kind: http, name: Site, url: "https://site.test/health" }\n`
    await b.get('/admin/configuration')
    const preview = await b.post('/admin/import', { config: yaml })
    expect(preview.body).toContain('Confirm import')
    await b.post('/admin/import/apply', { config: yaml })
    const page = await b.get('/admin/configuration')
    expect(page.body).toMatch(/<code>HOOK_AUTH<\/code> <span class="missing">✗ Not set<\/span><span class="muted small">sinks\.hook\.headers\.Authorization<\/span>/)
    expect(page.body).toMatch(/<code>HOOK_URL<\/code> <span class="ok">✓ Worker secret or environment variable<\/span>/)
    expect(page.body).not.toContain('https://hooks.test/x')

    const schema = await app.request(`${ORIGIN}/admin/schema.json`)
    expect(schema.status).toBe(200)
    expect(await schema.json()).toEqual(configSchema())
    const exported = await b.get('/admin/export/statusping.yaml')
    expect(exported.body.split('\n')[0]).toBe(`# yaml-language-server: $schema=${ORIGIN}/admin/schema.json`)

    expect((await b.get('/admin')).body).not.toContain('but its address is set to')
    const elsewhere = await signIn('admin@example.test', 'admin-password-123', 'https://other.test')
    expect((await elsewhere.get('/admin')).body).toContain('This site is open at https://other.test, but its address is set to https://status.test.')
  })

  it('locates YAML mistakes by line in the import preview', async () => {
    const { signIn } = await site()
    const b = await signIn('admin@example.test', 'admin-password-123')
    await b.get('/admin/configuration')
    expect((await b.post('/admin/import', { config: 'title: x\nfoo: [1, 2\nbar: 3\n' })).body).toContain('YAML is invalid at line 3, column 1')
    const leaky = `title: T\nbaseUrl: ${ORIGIN}\naccess:\n  provider: { type: basic }\n  admins: { emails: [admin@example.test] }\ngroups:\n  - name: Web\n    monitors:\n      - id: site\n        kind: http\n        name: Site\n        url: https://site.test\n        headers:\n          Authorization: Bearer leaked\n`
    const body = (await b.post('/admin/import', { config: leaky })).body
    expect(body).toContain('Line 14: groups.0.monitors.0.headers.Authorization: holds a credential')
    expect(body).not.toContain('Confirm import')
  })

  it('creates a ping URL as soon as a scheduled job is added', async () => {
    const { signIn } = await site()
    const b = await signIn('admin@example.test', 'admin-password-123')
    await b.get('/admin/monitors/new?kind=push')
    const added = await b.post('/admin/monitors/new', { kind: 'push', name: 'Nightly export', period: '1d', group: 'Jobs', alerts: 'all' })
    expect(added.res.status).toBe(200)
    expect(added.body).toContain('Monitor added')
    const url = /<p class="secret"[^>]*>([^<]+)<\/p>/.exec(added.body)![1]!
    expect(url).toMatch(new RegExp(`^${ORIGIN}/ping/[A-Za-z0-9]{40}$`))
    expect((await b.get(new URL(url).pathname)).res.status).toBe(200)
    expect((await b.get('/admin/monitors')).body).not.toContain('No ping URL yet')
  })

  it('skips reloading the configuration while nothing has changed', async () => {
    const { db, deps } = await site()
    await refreshAdminConfig(deps, 1)
    const before = db.queries
    expect(await refreshAdminConfig(deps, 2)).toBe(true)
    expect(db.queries - before).toBe(1)
    await db.run(`UPDATE admin_config SET config_json = ?, updated_at = 5 WHERE id = 1`, [JSON.stringify({ ...(await loadAdminConfig(db))!.config, title: 'Changed elsewhere' })])
    await refreshAdminConfig(deps, 3)
    expect(deps.config.title).toBe('Changed elsewhere')
  })

  it('reads webhook URLs and header values from secrets, and never stores them', async () => {
    const env: Record<string, string> = { HOOK_URL: 'https://hooks.test/secret-path', HOOK_AUTH: 'Bearer hook-secret', API_AUTH: 'Bearer api-secret' }
    const f = fakeFetch(() => new Response('ok'))
    await createSink('hook', { type: 'webhook', url: { $env: 'HOOK_URL' }, headers: { Authorization: { $env: 'HOOK_AUTH' }, 'X-Team': 'ops' } }, (n) => env[n])
      .send({ kind: 'test', title: 't', body: 'b', url: ORIGIN, priority: 'normal' }, f.fn)
    expect(f.calls[0]).toMatchObject({ url: 'https://hooks.test/secret-path', headers: { authorization: 'Bearer hook-secret', 'x-team': 'ops' } })

    const t = await createTestDb('libsql'); close = t.close
    const config = testConfig({ sinks: {}, groups: [{ name: 'Web', monitors: [{ id: 'api', kind: 'http', name: 'API', url: { $env: 'API_URL' }, headers: { Authorization: { $env: 'API_AUTH' } } }] }] })
    const deps = makeDeps(t.db, { config, env: { ...env, API_URL: 'https://api.test/health?key=k' } })
    const monitor = deps.config.monitors[0]!
    expect(monitor).toMatchObject({ url: 'https://api.test/health?key=k', headers: { Authorization: 'Bearer api-secret' }, secretUrl: true, secretHeaders: ['Authorization'] })
    await syncConfig(deps, 1)
    const row = await t.db.first<{ config_json: string }>(`SELECT config_json FROM monitors WHERE id = 'api'`)
    expect(row!.config_json).not.toContain('api-secret')
    expect(row!.config_json).not.toContain('key=k')
  })

  it('publishes the schema generated from the config types', () => {
    expect(readFileSync(new URL('../statusping.schema.json', import.meta.url), 'utf8')).toBe(configSchemaJson())
  })

  it('diffs lines with context', () => {
    const diff = lineDiff('a\nb\nc\nd\ne\nf\ng\nh\ni\n', 'a\nb\nc\nd\nE\nf\ng\nh\ni\n')
    expect(diff.filter((l) => l.op !== ' ')).toEqual([{ op: '-', text: 'e' }, { op: '+', text: 'E' }])
    expect(withContext(diff, 1).map((l) => (l ? `${l.op}${l.text}` : '…'))).toEqual(['…', ' d', '-e', '+E', ' f', '…'])
  })
})
