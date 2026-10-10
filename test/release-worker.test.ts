import { randomUUID } from 'node:crypto'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { describe, expect, it, vi } from 'vitest'
import { testConfig } from './helpers.ts'

// This Workers builtin is present in the real bundle but not in Node's test resolver.
vi.mock('cloudflare:email', () => ({ EmailMessage: class EmailMessage {} }))

describe('release Worker entrypoint', () => {
  it('uses STATUSPING_CONFIG instead of the repository config file', async () => {
    const { default: worker } = await import('../adapters/cloudflare/release-worker.ts')
    const mf = new Miniflare(convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("") } }',
      d1Databases: { DB: randomUUID() },
    }))
    try {
      const db = await mf.getD1Database('DB')
      const config = testConfig({ title: 'Configured only by STATUSPING_CONFIG' })
      const response = await worker.fetch(
        new Request('https://release.test/'),
        { DB: db as never, STATUSPING_CONFIG: JSON.stringify(config), PING_TOKENS: '{}' },
        { waitUntil: () => {} },
      )
      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toContain('Configured only by STATUSPING_CONFIG')
    } finally {
      await mf.dispose()
    }
  })

  it('runs a scheduled tick and accepts a ping through the Cloudflare request path', async () => {
    const { default: worker } = await import('../adapters/cloudflare/release-worker.ts')
    const mf = new Miniflare(convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("") } }',
      d1Databases: { DB: randomUUID() },
    }))
    try {
      const db = await mf.getD1Database('DB')
      const config = {
        title: 'Scheduled release Worker',
        baseUrl: 'https://release.test',
        groups: [{ name: 'Jobs', monitors: [{ id: 'heartbeat', kind: 'push', name: 'Heartbeat', period: '5m' }] }],
      }
      const env = { DB: db as never, STATUSPING_CONFIG: JSON.stringify(config), PING_TOKENS: JSON.stringify({ heartbeat: 'test-token-0123456789' }) }
      const pending: Promise<unknown>[] = []

      worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: (promise) => pending.push(promise) })
      await Promise.all(pending)

      const health = await worker.fetch(new Request('https://release.test/healthz'), env, { waitUntil: () => {} })
      expect(health.status).toBe(200)
      const ping = await worker.fetch(
        new Request('https://release.test/ping/test-token-0123456789', { method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.12' }, body: 'completed' }),
        env,
        { waitUntil: () => {} },
      )
      expect(await ping.text()).toBe('OK')
      await expect(db.prepare('SELECT body FROM pings WHERE monitor_id = ?').bind('heartbeat').first()).resolves.toMatchObject({ body: 'completed' })
    } finally {
      await mf.dispose()
    }
  })
})
