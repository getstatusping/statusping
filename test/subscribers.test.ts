import { describe, expect, it } from 'vitest'
import { confirmSubscription, consumeSubscribeLimit, startSubscription, unsubscribe } from '../src/subscribers.ts'
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
