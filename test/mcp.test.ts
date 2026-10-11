import { afterEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/auth/providers.ts'
import { loadAdminConfig } from '../src/admin/service.ts'
import { createApp } from '../src/web/app.ts'
import { tick } from '../src/tick.ts'
import { createTestDb, makeDeps, testConfig } from './helpers.ts'

const ORIGIN = 'https://status.test'

describe('MCP server', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => close?.())

  async function setup() {
    const t = await createTestDb('libsql'); close = t.close
    const config = { ...testConfig({ sinks: {}, access: { provider: { type: 'basic' as const }, admins: { emails: ['admin@example.test'] } } }), baseUrl: ORIGIN, admin: true }
    const deps = makeDeps(t.db, { config, env: { BASIC_AUTH_USERS: JSON.stringify({ 'admin@example.test': await hashPassword('admin-password-123') }) } })
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
    const post = (path: string, fields: Array<[string, string]>) => {
      const body = new URLSearchParams([['csrf', csrf], ...fields])
      return send(path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
    }
    await post('/auth/login', [['email', 'admin@example.test'], ['password', 'admin-password-123'], ['next', '/admin']])
    const createToken = async (name: string, scopes: string[]) => {
      await send('/admin/mcp')
      const page = await post('/admin/mcp', [['name', name], ...scopes.map((s): [string, string] => ['scopes', s])])
      return /value="(spm_[A-Za-z0-9]{40})"/.exec(page.body)?.[1]
    }
    let id = 0
    const mcp = async (token: string | undefined, method: string, params: Record<string, unknown> = {}) => {
      const res = await app.request(`${ORIGIN}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
      return { status: res.status, json: await res.json().catch(() => null) as any }
    }
    const call = async (token: string, name: string, args: Record<string, unknown> = {}) => (await mcp(token, 'tools/call', { name, arguments: args })).json
    return { db: t.db, send, post, createToken, mcp, call }
  }

  it('creates tokens in Settings, shows them once, and limits tools to their scopes', async () => {
    const s = await setup()
    expect((await s.send('/admin/mcp')).body).toContain(`${ORIGIN}/mcp`)
    expect((await s.post('/admin/mcp', [['name', 'nothing']])).body).toContain('Choose at least one thing the token can do.')
    const reader = await s.createToken('Reader', ['read'])
    expect(reader).toBeDefined()
    expect(await s.db.first(`SELECT name FROM api_tokens WHERE token_hash = ?`, [reader!])).toBeNull()
    const list = (await s.send('/admin/mcp')).body
    expect(list).toContain('Reader')
    expect(list).not.toContain(reader!)

    expect((await s.mcp(undefined, 'tools/list')).status).toBe(401)
    expect((await s.mcp('spm_' + 'x'.repeat(40), 'tools/list')).status).toBe(401)
    const init = await s.mcp(reader, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    expect(init.json.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'statusping' } })
    expect((await s.mcp(reader, 'tools/list')).json.result.tools.map((t: { name: string }) => t.name)).toEqual(['get_status', 'get_monitor', 'list_incidents'])
    const status = await s.call(reader!, 'get_status')
    expect(status.result.structuredContent.monitors.length).toBeGreaterThan(0)
    expect((await s.call(reader!, 'create_incident', { title: 'x' })).error.message).toContain('not allowed')
  })

  it('posts incidents and manages monitors with the matching scopes, then stops after revoke', async () => {
    const s = await setup()
    const token = (await s.createToken('Ops bot', ['read', 'incidents', 'monitors']))!
    const status = (await s.call(token, 'get_status')).result.structuredContent
    const monitorId = status.monitors[0].id as string

    const created = (await s.call(token, 'create_incident', { title: 'Slow API', impact: 'minor', monitors: [monitorId], message: 'Looking into it.' })).result
    expect(created.isError).toBeUndefined()
    const id = created.structuredContent.id
    expect((await s.call(token, 'update_incident', { id, status: 'resolved', message: 'Fixed.' })).result.structuredContent.status).toBe('resolved')
    expect((await s.call(token, 'create_incident', { title: 'x', impact: 'minor', monitors: ['nope'], message: 'y' })).result).toMatchObject({ isError: true })

    const added = (await s.call(token, 'add_monitor', { kind: 'http', name: 'Docs', url: 'https://docs.test/' })).result
    expect(added.structuredContent.added).toMatchObject({ id: 'docs', kind: 'http', url: 'https://docs.test/' })
    const job = (await s.call(token, 'add_monitor', { kind: 'push', name: 'Backup', period: '1d' })).result.structuredContent
    expect(job.pingUrl).toMatch(new RegExp(`^${ORIGIN}/ping/`))
    await s.call(token, 'update_monitor', { id: 'docs', keyword: 'Welcome' })
    let config = (await loadAdminConfig(s.db))!.config
    expect(config.groups!.flatMap((g) => g.monitors).find((m) => m.id === 'docs')).toMatchObject({ name: 'Docs', url: 'https://docs.test/', keyword: 'Welcome' })
    expect((await s.call(token, 'add_monitor', { kind: 'http', name: 'Bad', url: 'nope' })).result).toMatchObject({ isError: true })
    await s.call(token, 'delete_monitor', { id: 'docs' })
    config = (await loadAdminConfig(s.db))!.config
    expect(config.groups!.flatMap((g) => g.monitors).some((m) => m.id === 'docs')).toBe(false)
    expect((await s.db.all<{ actor: string }>(`SELECT actor FROM audit_log WHERE action = 'config.save'`)).map((r) => r.actor)).toContain('mcp:Ops bot')

    const row = await s.db.first<{ id: number }>(`SELECT id FROM api_tokens WHERE name = 'Ops bot'`)
    await s.send('/admin/mcp')
    expect((await s.post(`/admin/mcp/${row!.id}/revoke`, [])).res.headers.get('location')).toBe('/admin/mcp?notice=mcp-token-revoked')
    expect((await s.mcp(token, 'tools/list')).status).toBe(401)
  })

  it('answers notifications with 202, rejects other origins, and refuses GET', async () => {
    const s = await setup()
    const token = (await s.createToken('Reader', ['read']))!
    const app = { notify: await fetchLike(s, token, { jsonrpc: '2.0', method: 'notifications/initialized' }) }
    expect(app.notify).toBe(202)
    expect(await fetchLike(s, token, { jsonrpc: '2.0', id: 1, method: 'ping' }, 'https://evil.test')).toBe(403)
    expect((await s.send('/mcp')).res.status).toBe(405)
  })
})

async function fetchLike(s: { send: (path: string, init?: RequestInit) => Promise<{ res: Response }> }, token: string, body: unknown, origin?: string) {
  return (await s.send('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })).res.status
}
