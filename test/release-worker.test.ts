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
})
