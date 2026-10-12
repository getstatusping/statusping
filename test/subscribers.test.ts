import { describe, expect, it } from 'vitest'
import { confirmSubscription, consumeSubscribeLimit, enqueueIncidentSubscribers, startSubscription, unsubscribe } from '../src/subscribers.ts'
import { createApp } from '../src/web/app.ts'
import { DB_KINDS, createTestDb, fakeFetch, makeDeps, sec, testConfig } from './helpers.ts'

describe.each(DB_KINDS)('subscribers (%s)', (kind) => {
  it('requires confirmation, has a signed one-use unsubscribe, and rate limits durably', async () => {
    const { db, close } = await createTestDb(kind)
    const fetch = fakeFetch()
    const deps = makeDeps(db, { fetch: fetch.fn, env: { SUBSCRIBER_TOKEN_SECRET: 'subscriber-token-secret' }, config: testConfig({ subscribers: { provider: 'resend', apiKey: 're_test_key', from: 'Status <status@example.com>' } }) })
    const now = sec('2026-10-10T12:00:00Z')
    expect(await startSubscription(deps, 'status', 'User@Example.com', now)).toBe('sent')
    expect(fetch.calls).toHaveLength(1)
    const row = await db.first<{ confirm_token_hash: string; unsubscribe_token_hash: string }>('SELECT confirm_token_hash, unsubscribe_token_hash FROM subscribers')
    expect(row?.confirm_token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row?.unsubscribe_token_hash).toMatch(/^[0-9a-f]{64}$/)
    // Generate valid URLs from the email body, then prove confirmation and hard deletion work.
    const confirmUrl = new URL(JSON.parse(fetch.calls[0]!.body!).html.match(/href=\\?"([^" ]+)/)?.[1] ?? 'https://bad.test')
    expect(await confirmSubscription(deps, confirmUrl.searchParams.get('token')!, now + 86_401)).toBe(false)
    expect(await confirmSubscription(deps, confirmUrl.searchParams.get('token')!, now)).toBe(true)
    expect(await confirmSubscription(deps, confirmUrl.searchParams.get('token')!, now)).toBe(false)
    const allowed = await Promise.all(Array.from({ length: 5 }, () => consumeSubscribeLimit(db, 'ip:127.0.0.1', now)))
    expect(allowed).toEqual([true, true, true, true, true])
    expect(await consumeSubscribeLimit(db, 'ip:127.0.0.1', now)).toBe(false)
    await close()
  })
})

describe('subscribe rate limit (security review finding 2)', () => {
  it('ignores a forged cf-connecting-ip header on runtimes that do not vouch for it', async () => {
    const { db, close } = await createTestDb('libsql')
    const fetch = fakeFetch()
    const deps = makeDeps(db, { fetch: fetch.fn, env: { SUBSCRIBER_TOKEN_SECRET: 'subscriber-token-secret' }, config: testConfig({ subscribers: { provider: 'resend', apiKey: 're_test_key', from: 'Status <status@example.com>' } }) })
    const app = createApp(deps)
    const statuses: number[] = []
    for (let i = 0; i < 8; i++) {
      const res = await app.request('/pages/status/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', 'cf-connecting-ip': `198.51.100.${i}` },
        body: new URLSearchParams({ email: `victim${i}@example.com` }).toString(),
      })
      statuses.push(res.status)
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)
    expect(fetch.calls.length).toBeLessThanOrEqual(5)
    await close()
  })
})

describe('incident emails follow the page\'s errors visibility', () => {
  it('includes failure detail only for pages that show errors', async () => {
    const { db, close } = await createTestDb('libsql')
    try {
      const deps = makeDeps(db, {
        env: { SUBSCRIBER_TOKEN_SECRET: 'subscriber-token-secret' },
        config: testConfig({
          subscribers: { provider: 'resend', apiKey: 're_test_key', from: 'Status <status@example.com>' },
          pages: [
            { slug: 'quiet', title: 'Quiet', show: ['uptime'], monitors: ['heartbeat'] },
            { slug: 'loud', title: 'Loud', show: ['uptime', 'errors'], monitors: ['heartbeat'] },
          ],
        }),
      })
      const now = sec('2026-10-10T12:00:00Z')
      for (const slug of ['quiet', 'loud']) {
        await db.run(`INSERT INTO subscribers (page_slug, email, confirmed_at, confirm_token_hash, unsubscribe_token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [slug, `${slug}@example.com`, now, `c-${slug}`, `u-${slug}`, now])
      }
      await db.run(`INSERT INTO incidents (monitor_id, reason, detail, started_at) VALUES ('heartbeat', 'missed', 'ping body: visit https://phish.example', ?)`, [now])
      await enqueueIncidentSubscribers(deps, now)
      const rows = await db.all<{ email: string; text_body: string; html_body: string }>(`SELECT s.email, o.text_body, o.html_body FROM subscriber_outbox o JOIN subscribers s ON s.id = o.subscriber_id ORDER BY s.email`)
      expect(rows).toHaveLength(2)
      const [loud, quiet] = rows
      expect(loud!.text_body).toContain('phish.example')
      expect(quiet!.text_body).toBe('An incident has started.')
      expect(quiet!.html_body).not.toContain('phish.example')
    } finally {
      await close()
    }
  })
})
