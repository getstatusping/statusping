import { afterEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/auth/providers.ts'
import { forgetChannelStatements } from '../src/admin/channel-credentials.ts'
import type { AdminConfig } from '../src/admin/security.ts'
import { createApp } from '../src/web/app.ts'
import { tick } from '../src/tick.ts'
import { createTestDb, makeDeps, testConfig } from './helpers.ts'

const ORIGIN = 'https://status.test'
const API = { authorization: 'Bearer admin-api-token', 'content-type': 'application/json' }

describe('stored channel credentials', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => close?.())

  async function setup(env: Record<string, string> = {}) {
    const t = await createTestDb('libsql'); close = t.close
    const config = { ...testConfig({ sinks: {}, access: { provider: { type: 'basic' as const }, admins: { emails: ['admin@example.test'] } } }), baseUrl: ORIGIN, admin: true }
    const deps = makeDeps(t.db, { config, env: { BASIC_AUTH_USERS: JSON.stringify({ 'admin@example.test': await hashPassword('admin-password-123') }), ADMIN_TOKEN: 'admin-api-token', ...env } })
    await tick(deps, Date.parse('2026-10-11T00:00:00Z'))
    const app = createApp(deps)
    const jar = new Map<string, string>()
    let csrf = ''
    const send = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers)
      if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
      const res = await app.request(`${ORIGIN}${path}`, { ...init, headers })
      for (const cookie of res.headers.getSetCookie()) { const [pair] = cookie.split(';'); const [k, ...v] = pair!.split('='); jar.set(k!, v.join('=')) }
      const body = await res.text()
      csrf = /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? csrf
      return { res, body }
    }
    const post = (path: string, fields: Record<string, string>) =>
      send(path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, ...fields }).toString() })
    await post('/auth/login', { email: 'admin@example.test', password: 'admin-password-123', next: '/admin' })
    await send('/admin/mcp')
    const page = await post('/admin/mcp', { name: 'bot', scopes: 'channels' })
    const token = /value="(spm_[A-Za-z0-9]{40})"/.exec(page.body)![1]!
    let id = 0
    const tool = async (name: string, args: Record<string, unknown>) => {
      const res = await app.request(`${ORIGIN}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) })
      const result = ((await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } }).result
      return { error: result.isError ? result.content[0]!.text : undefined }
    }
    const getConfig = async () => ((await (await app.request(`${ORIGIN}/api/admin/config`, { headers: API })).json()) as { config: AdminConfig }).config
    const putConfig = async (config: unknown) => {
      const res = await app.request(`${ORIGIN}/api/admin/config`, { method: 'PUT', headers: API, body: JSON.stringify(config) })
      return { status: res.status, body: await res.json() as { error?: string; config?: AdminConfig } }
    }
    const secret = async (name: string) => (await t.db.first<{ value: string }>(`SELECT value FROM instance_secrets WHERE name = ?`, [name]))?.value
    return { db: t.db, send, post, tool, getConfig, putConfig, secret }
  }

  const withSink = (config: AdminConfig, name: string, change: Record<string, unknown>) =>
    ({ ...config, sinks: { ...config.sinks, [name]: { ...config.sinks![name]!, ...change } } }) as AdminConfig

  it('keeps a stored credential with the server it was entered for', async () => {
    const s = await setup()
    expect((await s.tool('add_channel', { name: 'alerts', type: 'ntfy', settings: { topic: 'secret-topic', token: 'ntfy-token', server: 'https://ntfy.example.test' } })).error).toBeUndefined()
    const config = await s.getConfig()

    // ADMIN_TOKEN: the same configuration saves; pointing it elsewhere does not.
    expect((await s.putConfig(config)).status).toBe(200)
    const moved = await s.putConfig(withSink(config, 'alerts', { server: 'https://evil.test' }))
    expect(moved.status).toBe(400)
    expect(moved.body.error).toContain('SINK_ALERTS_TOKEN was entered for a different server')
    expect((await s.getConfig()).sinks!.alerts).toMatchObject({ server: 'https://ntfy.example.test' })
    // ntfy needs https.
    expect((await s.putConfig(withSink(config, 'alerts', { server: 'http://ntfy.example.test' }))).body.error).toContain('sinks.alerts.server: must be an https:// URL')

    // MCP: changing only the server is refused; re-entering the credentials moves them.
    expect((await s.tool('update_channel', { name: 'alerts', settings: { server: 'https://other.example.test' } })).error).toContain('Enter it again')
    expect((await s.tool('update_channel', { name: 'alerts', settings: { server: 'https://other.example.test', topic: 'new-topic', token: 'new-token' } })).error).toBeUndefined()
    expect((await s.getConfig()).sinks!.alerts).toMatchObject({ server: 'https://other.example.test' })
    // Now bound to the new server, not the old one.
    expect((await s.putConfig(withSink(await s.getConfig(), 'alerts', { server: 'https://ntfy.example.test' }))).status).toBe(400)

    // Settings form: a new homeserver without the access token is refused.
    expect((await s.tool('add_channel', { name: 'room', type: 'matrix', settings: { homeserver: 'https://matrix.example.test', roomId: '!abc:example.test', accessToken: 'mx-token' } })).error).toBeUndefined()
    await s.send('/admin/channels/room')
    const form = await s.post('/admin/channels/room', { homeserver: 'https://evil.test', roomId: '!abc:example.test' })
    expect(form.res.status).toBe(400)
    expect(form.body).toContain('SINK_ROOM_ACCESSTOKEN was entered for a different server')
    expect((await s.post('/admin/channels/room', { homeserver: 'https://evil.test', roomId: '!abc:example.test', accessToken: 'mx-token-2' })).res.status).toBe(303)
  })

  it('binds the SMTP password to the server and account', async () => {
    const s = await setup()
    expect((await s.tool('add_channel', { name: 'mail', type: 'email', settings: { to: ['ops@example.test'], via: 'smtp', from: 'alerts@example.test', smtpHost: 'smtp.example.test', smtpPort: 587, smtpUsername: 'u', password: 'smtp-pw' } })).error).toBeUndefined()
    const config = await s.getConfig()
    const via = (config.sinks!.mail as { via: Record<string, unknown> }).via
    expect((await s.putConfig(withSink(config, 'mail', { via: { ...via, port: 465, security: 'tls' } }))).status).toBe(200)
    expect((await s.putConfig(withSink(config, 'mail', { via: { ...via, host: 'smtp.evil.test' } }))).status).toBe(400)
    expect((await s.putConfig(withSink(config, 'mail', { via: { ...via, username: 'someone-else' } }))).status).toBe(400)
  })

  it('binds credentials stored before this check to the configuration as it is', async () => {
    const s = await setup()
    await s.tool('add_channel', { name: 'push', type: 'gotify', settings: { server: 'https://gotify.example.test', token: 'gotify-token' } })
    await s.db.run(`DELETE FROM instance_secrets WHERE substr(name, 1, 5) = 'bind:'`)
    const config = await s.getConfig()
    expect((await s.putConfig(withSink(config, 'push', { server: 'https://evil.test' }))).status).toBe(400)
    expect((await s.putConfig(config)).status).toBe(200)
    expect(JSON.parse((await s.secret('bind:SINK_PUSH_TOKEN'))!)).toMatchObject({ destination: 'gotify https://gotify.example.test' })
    // A credential no channel used before cannot be picked up by a new one.
    await s.tool('delete_channel', { name: 'push' })
    await s.db.run(`INSERT INTO instance_secrets (name, value, created_at) VALUES ('env:SINK_PUSH_TOKEN', 'left-over', 1)`)
    const readded = await s.putConfig({ ...config, sinks: { ...config.sinks, push: { type: 'gotify', server: 'https://evil.test', token: { $env: 'SINK_PUSH_TOKEN' } } } })
    expect(readded.status).toBe(400)
  })

  it('leaves a credential from a Worker secret unbound', async () => {
    const s = await setup({ SINK_OPS_TOKEN: 'from-the-environment' })
    const config = await s.getConfig()
    const sink = (server: string) => ({ ...config, sinks: { ...config.sinks, ops: { type: 'gotify', server, token: { $env: 'SINK_OPS_TOKEN' } } } })
    expect((await s.putConfig(sink('https://gotify.example.test'))).status).toBe(200)
    expect((await s.putConfig(sink('https://elsewhere.example.test'))).status).toBe(200)
  })

  it('refuses channel names that would share stored credentials, and deletes by exact name', async () => {
    const s = await setup()
    expect((await s.tool('add_channel', { name: 'foo', type: 'slack', settings: { webhookUrl: 'https://hooks.slack.test/foo' } })).error).toBeUndefined()
    expect((await s.tool('add_channel', { name: 'foo_x', type: 'slack', settings: { webhookUrl: 'https://hooks.slack.test/foo-x' } })).error).toBeUndefined()
    expect((await s.tool('add_channel', { name: 'FOO', type: 'slack', settings: { webhookUrl: 'https://hooks.slack.test/other' } })).error).toContain('too close to the channel "foo"')
    expect(await s.secret('env:SINK_FOO_WEBHOOKURL')).toBe('https://hooks.slack.test/foo')
    await s.send('/admin/channels/new?type=slack')
    expect((await s.post('/admin/channels/new', { type: 'slack', name: 'f-o-o', webhookUrl: 'https://hooks.slack.test/x' })).res.status).toBe(303)
    expect((await s.post('/admin/channels/new', { type: 'slack', name: 'f_o-o', webhookUrl: 'https://hooks.slack.test/y' })).body).toContain('too close to the channel')
    const config = await s.getConfig()
    const api = await s.putConfig({ ...config, sinks: { ...config.sinks, 'Foo-X': { type: 'discord', webhookUrl: { $env: 'SINK_FOO_X_WEBHOOKURL' } } } })
    expect(api.body.error).toContain('too close to the channel "foo_x"')
    // Deleting "foo" leaves "foo_x" alone.
    expect((await s.tool('delete_channel', { name: 'foo' })).error).toBeUndefined()
    expect(await s.secret('env:SINK_FOO_WEBHOOKURL')).toBeUndefined()
    expect(await s.secret('env:SINK_FOO_X_WEBHOOKURL')).toBe('https://hooks.slack.test/foo-x')
    await s.send('/admin/channels')
    expect((await s.post('/admin/channels/foo_x/delete', {})).res.status).toBe(303)
    expect(await s.secret('env:SINK_FOO_X_WEBHOOKURL')).toBeUndefined()
  })

  it('does not erase a credential another (older, same-named) channel still uses', () => {
    const remaining = { sinks: { 'my-chan': { type: 'slack', webhookUrl: { $env: 'SINK_MY_CHAN_WEBHOOKURL' } } } } as unknown as AdminConfig
    expect(forgetChannelStatements('my_chan', 'slack', remaining)).toEqual([])
    expect(forgetChannelStatements('my_chan', 'slack', { sinks: {} } as unknown as AdminConfig).map((s) => s.params)).toEqual([['env:SINK_MY_CHAN_WEBHOOKURL', 'bind:SINK_MY_CHAN_WEBHOOKURL']])
  })

  it('keeps the sign-in method when the API saves a configuration', async () => {
    const s = await setup()
    const config = await s.getConfig()
    const res = await s.putConfig({ ...config, title: 'Renamed', access: { ...config.access, provider: { type: 'oidc', issuer: 'https://evil.test', clientId: 'x', clientSecret: { $env: 'OIDC_CLIENT_SECRET' } } } })
    expect(res.status).toBe(200)
    const saved = await s.getConfig()
    expect(saved.title).toBe('Renamed')
    expect(saved.access!.provider).toEqual({ type: 'basic' })
  })
})
