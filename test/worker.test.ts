import { randomUUID } from 'node:crypto'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { describe, expect, it, vi } from 'vitest'
import { testConfig } from './helpers.ts'

// This Workers builtin is present in the real bundle but not in Node's test resolver.
vi.mock('cloudflare:email', () => ({ EmailMessage: class EmailMessage {} }))

async function withD1(fn: (db: never) => Promise<void>) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("") } }', d1Databases: { DB: randomUUID() } }))
  try { await fn((await mf.getD1Database('DB')) as never) } finally { await mf.dispose() }
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} }
const admins = { access: { provider: { type: 'basic' as const }, admins: { emails: ['owner@example.test'] } } }

describe('Cloudflare Worker entrypoint (configured only through its database)', () => {
  it('starts a fresh deploy in setup, healthy and with no checks', async () => {
    const { default: worker } = await import('../adapters/cloudflare/worker.ts')
    await withD1(async (db) => {
      const env = { DB: db, PING_TOKENS: '{}' }
      const home = await worker.fetch(new Request('https://fresh.test/'), env, ctx)
      expect(home.status).toBe(302)
      expect(home.headers.get('location')).toBe('/setup')
      const health = await (await worker.fetch(new Request('https://fresh.test/healthz'), env, ctx)).json()
      expect(health).toMatchObject({ ok: true, setup: 'required' })
    })
  })

  it('adopts a STATUSPING_CONFIG site with administrators once, then ignores the variable', async () => {
    const { default: worker } = await import('../adapters/cloudflare/worker.ts')
    await withD1(async (db) => {
      const config = { ...testConfig({ sinks: {}, title: 'Moved from STATUSPING_CONFIG', ...admins }), baseUrl: 'https://moved.test', groups: [{ name: 'Jobs', monitors: [{ id: 'heartbeat', kind: 'push' as const, name: 'Heartbeat', period: '5m' }] }], pages: undefined, home: undefined }
      const env = { DB: db, STATUSPING_CONFIG: JSON.stringify(config), PING_TOKENS: JSON.stringify({ heartbeat: 'test-token-0123456789' }) }
      const pending: Promise<unknown>[] = []
      worker.scheduled({ scheduledTime: Date.now(), cron: '* * * * *' }, env, { ...ctx, waitUntil: (p: Promise<unknown>) => pending.push(p) })
      await Promise.all(pending)
      const page = await worker.fetch(new Request('https://moved.test/'), env, ctx)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('Moved from STATUSPING_CONFIG')
      // Ping URLs from PING_TOKENS keep working.
      const ping = await worker.fetch(new Request('https://moved.test/ping/test-token-0123456789', { method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.12' }, body: 'completed' }), env, ctx)
      expect(await ping.text()).toBe('OK')
      const audit = await (db as unknown as D1Database).prepare(`SELECT action FROM audit_log WHERE action = 'config.migrate'`).first()
      expect(audit).toMatchObject({ action: 'config.migrate' })
      // The variable is a one-time source: the database now wins.
      const changed = { ...env, STATUSPING_CONFIG: JSON.stringify({ ...config, title: 'Edited variable' }) }
      expect(await (await worker.fetch(new Request('https://moved.test/'), changed, ctx)).text()).not.toContain('Edited variable')
    })
  })

  it('opens setup with the old configuration imported when it names no administrators', async () => {
    const { default: worker } = await import('../adapters/cloudflare/worker.ts')
    await withD1(async (db) => {
      const env = { DB: db, STATUSPING_CONFIG: JSON.stringify(testConfig({ sinks: {}, title: 'No admins yet' })), PING_TOKENS: '{}' }
      expect((await worker.fetch(new Request('https://noadmin.test/'), env, ctx)).headers.get('location')).toBe('/setup')
      const row = await (db as unknown as D1Database).prepare(`SELECT draft_json FROM setup_state WHERE id = 1`).first<{ draft_json: string }>()
      expect(JSON.parse(row!.draft_json)).toMatchObject({ title: 'No admins yet', imported: { title: 'No admins yet' } })
    })
  })
})

interface D1Database { prepare(sql: string): { first<T = unknown>(): Promise<T | null> } }
